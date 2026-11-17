import { useSyncExternalStore } from 'react'

/**
 * "Your short dramas": every short drama opened on this device, newest first,
 * kept in localStorage under one key (max 20). Each entry can carry the
 * episode the viewer says they're on ("I'm on episode __" on the drama page),
 * since most episodes are watched in the drama's own app.
 *
 * Signed in, the account keeps the same list (src/account/sync.ts): the
 * newest entry of each drama wins, as with Continue Watching.
 *
 * Storage can be missing, full or blocked (private windows, previews), so
 * every read and write here quietly does nothing then.
 */

export const DRAMA_HISTORY_KEY = 'naijatr:dramaHistory'
export const DRAMA_HISTORY_LIMIT = 20
/** The highest episode the picker accepts when the drama's size isn't known. */
export const MAX_EPISODE = 9999

export interface DramaHistoryEntry {
  /** `${provider}:${dramaId}`: one entry per drama. */
  id: string
  /** The app it's from ("dramabox", "netshort"…); a string so entries from apps added later still show. */
  provider: string
  dramaId: string
  title: string
  poster: string | null
  /** The episode the viewer set on the picker; null until they do. */
  episode: number | null
  /** How many episodes the drama has, when known. */
  episodeCount: number | null
  /** Opened, or the episode changed: the newest is first, and wins when syncing. */
  viewedAt: number
}

export const dramaEntryId = (provider: string, dramaId: string) => `${provider}:${dramaId}`

const listeners = new Set<() => void>()
let cache: { raw: string | null; list: DramaHistoryEntry[] } | null = null
const emit = () => listeners.forEach((listener) => listener())

const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

export const isDramaEntry = (value: unknown): value is DramaHistoryEntry => {
  const e = value as Partial<DramaHistoryEntry> | null
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.id === 'string' &&
    typeof e.provider === 'string' &&
    typeof e.dramaId === 'string' &&
    e.id === dramaEntryId(e.provider, e.dramaId) &&
    typeof e.title === 'string' &&
    typeof e.viewedAt === 'number' &&
    (e.poster === null || typeof e.poster === 'string') &&
    (e.episode === null || positiveInt(e.episode)) &&
    (e.episodeCount === null || positiveInt(e.episodeCount))
  )
}

const newestFirst = (list: DramaHistoryEntry[]) => [...list].sort((a, b) => b.viewedAt - a.viewedAt).slice(0, DRAMA_HISTORY_LIMIT)

/** Every entry, most recently viewed first. */
export function readDramaHistory(): DramaHistoryEntry[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(DRAMA_HISTORY_KEY)
  } catch {
    return []
  }
  if (cache && cache.raw === raw) return cache.list
  let list: DramaHistoryEntry[] = []
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    list = Array.isArray(parsed) ? newestFirst(parsed.filter(isDramaEntry)) : []
  } catch {
    list = []
  }
  cache = { raw, list }
  return list
}

function write(list: DramaHistoryEntry[]): void {
  try {
    window.localStorage.setItem(DRAMA_HISTORY_KEY, JSON.stringify(newestFirst(list)))
  } catch {
    // Not remembered this time.
  }
  emit()
}

/** Keeps a picked episode inside the drama (1…its size). */
export const clampEpisode = (value: number, episodeCount: number | null) =>
  Math.min(Math.max(1, Math.round(value)), episodeCount ?? MAX_EPISODE)

export interface DramaView {
  provider: string
  dramaId: string
  title: string
  poster: string | null
  episodeCount: number | null
}

/** A drama's page was opened: it moves to the front, keeping the episode set before. */
export function recordDramaView(view: DramaView, now = Date.now()): void {
  const id = dramaEntryId(view.provider, view.dramaId)
  const list = readDramaHistory()
  const before = list.find((entry) => entry.id === id)
  const episodeCount = positiveInt(view.episodeCount) ? view.episodeCount : (before?.episodeCount ?? null)
  const entry: DramaHistoryEntry = {
    id,
    provider: view.provider,
    dramaId: view.dramaId,
    title: view.title || before?.title || '',
    poster: view.poster || before?.poster || null,
    episode: before?.episode != null ? clampEpisode(before.episode, episodeCount) : null,
    episodeCount,
    viewedAt: now,
  }
  write([entry, ...list.filter((e) => e.id !== id)])
}

/** The picker: the episode the viewer is on (null clears it). Counts as a view, so it's the newest. */
export function setDramaEpisode(id: string, episode: number | null, now = Date.now()): void {
  const list = readDramaHistory()
  const entry = list.find((e) => e.id === id)
  if (!entry) return
  const next = episode === null || !Number.isFinite(episode) ? null : clampEpisode(episode, entry.episodeCount)
  if (next === entry.episode) return
  write([{ ...entry, episode: next, viewedAt: now }, ...list.filter((e) => e.id !== id)])
}

/** The card's ✕. */
export function removeDramaEntry(id: string): void {
  const list = readDramaHistory()
  if (list.some((e) => e.id === id)) write(list.filter((e) => e.id !== id))
}

/** "Episode 12 of 80", "Episode 12", or null while no episode is set. */
export function episodeProgress(entry: Pick<DramaHistoryEntry, 'episode' | 'episodeCount'>): string | null {
  if (entry.episode === null) return null
  return entry.episodeCount ? `Episode ${entry.episode} of ${entry.episodeCount}` : `Episode ${entry.episode}`
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  // Another tab opened a drama.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DRAMA_HISTORY_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** For account sync (src/account/sync.ts): told of every change, and able to put the account's list in place. */
export const subscribeDramaHistory = subscribe
export const replaceDramaHistory = (list: DramaHistoryEntry[]) => write(list)

const empty: DramaHistoryEntry[] = []
export const useDramaHistory = () => useSyncExternalStore(subscribe, readDramaHistory, () => empty)

/** Test helper. */
export function resetDramaHistory(): void {
  cache = null
}
