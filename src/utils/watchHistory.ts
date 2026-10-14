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
