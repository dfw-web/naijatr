import { useSyncExternalStore } from 'react'
import type { MediaItem, SeasonSummary } from '../types/media'

/**
 * "Continue watching": every title played on this device, newest first, kept
 * in localStorage under one key. A series has one entry, for the episode the
 * viewer is on; finishing it (90%, or the player's "ended") moves the entry to
 * the next episode, and finishing the last one, or a movie, removes it.
 *
 * Storage can be missing, full or blocked (private windows, previews), so
 * every read and write here quietly does nothing then.
 */

export const CONTINUE_KEY = 'naijatr:continueWatching'
export const CONTINUE_LIMIT = 20
/** Watched this much of a movie or episode: it counts as finished. */
export const FINISHED_AT = 0.9

const IMAGE_BASE = 'https://image.tmdb.org/t/p'

/** The title as the details page needs it to open again. */
export type SavedTitle = Pick<MediaItem, 'id' | 'tmdbId' | 'title' | 'type' | 'year' | 'releaseDate' | 'genres' | 'score' | 'voteCount' | 'popularity' | 'description' | 'poster' | 'backdrop' | 'certification' | 'length'>

export interface ContinueEntry {
  /** Our title id (MediaItem.id): one entry per movie or series. */
  id: string
  type: 'movie' | 'tv'
  tmdbId: number | null
  title: string
  poster: string | null
  backdrop: string | null
  /** Series only: the episode the viewer is on. */
  season: number | null
  episode: number | null
  episodeTitle: string | null
  /** The episode's still image, when TMDB has one. */
  still: string | null
  progressSeconds: number | null
  durationSeconds: number | null
  lastWatchedAt: number
  /** Series only: season sizes, for moving on to the next episode. */
  seasons: Pick<SeasonSummary, 'number' | 'episodeCount'>[]
  /** "free": a Watch Free film (played by our own player); otherwise the stream. */
  source: 'stream' | 'free'
  item: SavedTitle
}

const listeners = new Set<() => void>()
let cache: { raw: string | null; list: ContinueEntry[] } | null = null

const emit = () => listeners.forEach((listener) => listener())

const isEntry = (value: unknown): value is ContinueEntry => {
  const e = value as Partial<ContinueEntry> | null
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.id === 'string' &&
    typeof e.title === 'string' &&
    (e.type === 'movie' || e.type === 'tv') &&
    typeof e.lastWatchedAt === 'number' &&
    typeof e.item === 'object' &&
    e.item !== null
  )
}

/** Every entry, most recently watched first. */
export function readContinueWatching(): ContinueEntry[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(CONTINUE_KEY)
  } catch {
    return []
  }
  if (cache && cache.raw === raw) return cache.list
  let list: ContinueEntry[] = []
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    list = Array.isArray(parsed) ? parsed.filter(isEntry).sort((a, b) => b.lastWatchedAt - a.lastWatchedAt) : []
  } catch {
    list = []
  }
  cache = { raw, list }
  return list
}

function write(list: ContinueEntry[]): void {
  const sorted = [...list].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt).slice(0, CONTINUE_LIMIT)
  try {
    window.localStorage.setItem(CONTINUE_KEY, JSON.stringify(sorted))
  } catch {
    // Not remembered this time; playback is unaffected.
  }
  emit()
}

export const saveTitle = (item: MediaItem): SavedTitle => ({
  id: item.id,
  tmdbId: item.tmdbId,
  title: item.title,
  type: item.type,
  year: item.year,
  releaseDate: item.releaseDate,
  genres: item.genres,
  score: item.score,
  voteCount: item.voteCount,
  popularity: item.popularity,
  description: item.description,
  poster: item.poster,
  backdrop: item.backdrop,
  certification: item.certification,
  length: item.length,
})

/** The title to open again from a card. */
export const entryTitle = (entry: ContinueEntry): MediaItem => ({ ...entry.item })

/**
 * Play pressed: the title moves to the front. A series entry switches to this
 * episode (its progress starts over unless it's the same episode).
 */
export function recordPlay(
  item: MediaItem,
  options: { season?: number; episode?: number; source?: 'stream' | 'free' } = {},
  now = Date.now(),
): void {
  const list = readContinueWatching()
  const old = list.find((e) => e.id === item.id)
  const isSeries = item.type === 'series'
  const season = isSeries ? (options.season ?? 1) : null
  const episode = isSeries ? (options.episode ?? 1) : null
  const sameEpisode = old && old.season === season && old.episode === episode
  const seasons = item.seasons?.length
    ? item.seasons.map(({ number, episodeCount }) => ({ number, episodeCount }))
    : (old?.seasons ?? [])
  const entry: ContinueEntry = {
    id: item.id,
    type: isSeries ? 'tv' : 'movie',
    tmdbId: item.tmdbId ?? null,
    title: item.title,
    poster: item.poster,
    backdrop: item.backdrop,
    season,
    episode,
    episodeTitle: sameEpisode ? old.episodeTitle : null,
    still: sameEpisode ? old.still : null,
    progressSeconds: sameEpisode ? old.progressSeconds : null,
    durationSeconds: sameEpisode ? old.durationSeconds : null,
    lastWatchedAt: now,
    seasons,
    source: options.source ?? 'stream',
    item: saveTitle(item),
  }
  write([entry, ...list.filter((e) => e.id !== item.id)])
  if (isSeries && !sameEpisode) void loadEpisodeInfo(entry)
}

/**
 * The player reported how far in it is. Only updates the entry if it's still
 * on that episode (a finished episode's last updates don't bring it back).
 * Finishing it moves a series on, or removes a movie.
 */
export function recordProgress(
  id: string,
  at: { season?: number | null; episode?: number | null },
  progressSeconds: number,
  durationSeconds: number | null,
  now = Date.now(),
): void {
  const list = readContinueWatching()
  const entry = list.find((e) => e.id === id)
  if (!entry || !Number.isFinite(progressSeconds) || progressSeconds < 0) return
  if (entry.type === 'tv' && (entry.season !== (at.season ?? null) || entry.episode !== (at.episode ?? null))) return
  const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : entry.durationSeconds
  if (duration && progressSeconds >= duration * FINISHED_AT) return finishEntry(id, at, now)
  write(list.map((e) => (e.id === id ? { ...e, progressSeconds, durationSeconds: duration, lastWatchedAt: now } : e)))
}

/** The episode after `season`/`episode`, or null after the last one. Unknown season sizes: just the next number. */
export function nextEpisodeOf(
  seasons: ContinueEntry['seasons'],
  season: number,
  episode: number,
): { season: number; episode: number } | null {
  const sorted = [...seasons].filter((s) => s.number > 0).sort((a, b) => a.number - b.number)
  if (!sorted.length) return { season, episode: episode + 1 }
  const current = sorted.find((s) => s.number === season)
  if (!current || current.episodeCount === 0 || episode < current.episodeCount) return { season, episode: episode + 1 }
  const next = sorted.find((s) => s.number > season && s.episodeCount > 0)
  return next ? { season: next.number, episode: 1 } : null
}

/** Finished a movie (removed) or an episode (on to the next; removed after the last). */
export function finishEntry(id: string, at: { season?: number | null; episode?: number | null } = {}, now = Date.now()): void {
  const list = readContinueWatching()
  const entry = list.find((e) => e.id === id)
  if (!entry) return
  if (entry.type === 'movie') return removeEntry(id)
  // Already moved on (e.g. a late "ended" for the episode just finished).
  if (at.season != null && (entry.season !== at.season || entry.episode !== at.episode)) return
  const next = nextEpisodeOf(entry.seasons, entry.season ?? 1, entry.episode ?? 1)
  if (!next) return removeEntry(id)
  const moved: ContinueEntry = {
    ...entry,
    ...next,
    episodeTitle: null,
    still: null,
    progressSeconds: null,
    durationSeconds: null,
    lastWatchedAt: now,
  }
  write(list.map((e) => (e.id === id ? moved : e)))
  void loadEpisodeInfo(moved)
}

/** The card's ✕. */
export function removeEntry(id: string): void {
  const list = readContinueWatching()
  if (list.some((e) => e.id === id)) write(list.filter((e) => e.id !== id))
}

/** Episode name and still from TMDB (through our /api/tmdb proxy), filled in when they arrive. */
async function loadEpisodeInfo(entry: ContinueEntry): Promise<void> {
  if (entry.tmdbId === null || entry.season === null || entry.episode === null) return
  try {
    const response = await fetch(`/api/tmdb/tv/${entry.tmdbId}/season/${entry.season}/episode/${entry.episode}?language=en-US`)
    if (!response.ok) return
    const body = (await response.json()) as { name?: unknown; still_path?: unknown }
    const episodeTitle = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
    const still = typeof body.still_path === 'string' ? `${IMAGE_BASE}/w780${body.still_path}` : null
    if (!episodeTitle && !still) return
    const list = readContinueWatching()
    const current = list.find((e) => e.id === entry.id)
    if (!current || current.season !== entry.season || current.episode !== entry.episode) return
    write(list.map((e) => (e.id === entry.id ? { ...e, episodeTitle, still } : e)))
  } catch {
    // No title or still: the card shows the series image.
  }
}

/** "S2 · E5 – Episode title" (or just "S2 · E5"). */
export function episodeLabel(entry: Pick<ContinueEntry, 'season' | 'episode' | 'episodeTitle'>): string | null {
  if (entry.season === null || entry.episode === null) return null
  const label = `S${entry.season} · E${entry.episode}`
  return entry.episodeTitle ? `${label} – ${entry.episodeTitle}` : label
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  // Another tab played something.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CONTINUE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export const useContinueWatching = () => useSyncExternalStore(subscribe, readContinueWatching, () => [])

/**
 * A card was tapped: its details page opens and its player starts this
 * entry's movie or episode, resuming where it was left (see PlayerPanel).
 */
let resumeRequest: { id: string; season: number | null; episode: number | null; at: number | null; source: ContinueEntry['source'] } | null = null

export function requestResume(entry: ContinueEntry): void {
  resumeRequest = {
    id: entry.id,
    season: entry.season,
    episode: entry.episode,
    at: entry.progressSeconds,
    source: entry.source,
  }
}

/** The pending resume for this title, if any; it's handed out once. */
export function takeResumeRequest(id: string) {
  if (resumeRequest?.id !== id) return null
  const request = resumeRequest
  resumeRequest = null
  return request
}

/** Test helper. */
export function resetContinueWatching(): void {
  cache = null
  resumeRequest = null
}
