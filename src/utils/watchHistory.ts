import type { MediaItem } from '../types/media'

/**
 * The last episode played of each series, kept in this browser only. Storage
 * can be missing or blocked (private windows, previews), so every call here
 * quietly does nothing then.
 */

export interface EpisodeRef {
  season: number
  episode: number
}

const key = (seriesId: string) => `naijatr:last-episode:${seriesId}`

const isPositive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0

export function readLastEpisode(seriesId: string): EpisodeRef | null {
  try {
    const raw = window.localStorage.getItem(key(seriesId))
    const value = raw ? (JSON.parse(raw) as Partial<EpisodeRef>) : null
    return value && isPositive(value.season) && isPositive(value.episode)
      ? { season: value.season, episode: value.episode }
      : null
  } catch {
    return null
  }
}

export function saveLastEpisode(seriesId: string, { season, episode }: EpisodeRef) {
  try {
    window.localStorage.setItem(key(seriesId), JSON.stringify({ season, episode }))
  } catch {
    // Not remembered this time; playback is unaffected.
  }
}

/** Titles played most recently, newest first, for the TV "Continue watching" row. */
type SavedTitle = Pick<
  MediaItem,
  'id' | 'tmdbId' | 'title' | 'type' | 'year' | 'releaseDate' | 'genres' | 'score' | 'voteCount' | 'popularity' | 'description' | 'poster' | 'backdrop' | 'certification' | 'length'
>

const RECENT_KEY = 'naijatr:recent-titles'
const RECENT_LIMIT = 20

export function readRecentTitles(): MediaItem[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(list)
      ? list.filter(
          (t): t is MediaItem =>
            typeof t === 'object' && t !== null && typeof t.id === 'string' && typeof t.title === 'string' && (t.type === 'movie' || t.type === 'series'),
        )
      : []
  } catch {
    return []
  }
}

export function saveRecentTitle(item: MediaItem) {
  const saved: SavedTitle = {
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
  }
  try {
    const rest = readRecentTitles().filter((t) => t.id !== item.id)
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([saved, ...rest].slice(0, RECENT_LIMIT)))
  } catch {
    // Not remembered this time.
  }
}
