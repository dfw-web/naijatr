import type { ContinueEntry } from '../utils/continueWatching'
import type { WatchLaterEntry } from '../utils/watchLater'
import { attributeScores, MAX_ATTRIBUTES, MAX_TITLES, type TasteProfile } from '../taste/profile'

/**
 * Turning this device's data into account rows and back, and merging the two.
 * Pure functions: src/account/sync.ts does the reading, writing and sending.
 *
 * The rule: the account is the source of truth, except for changes made on
 * this device that haven't reached it yet ("pending"). On the first sign-in on
 * a device everything here is pending, so the newest of each title wins
 * (by last watched) and My List is the union of both.
 */

export type PendingOp = 'up' | 'del'
export type PendingMap = Record<string, PendingOp>

export interface ContinueRow {
  user_id: string
  title_id: string
  tmdb_id: number | null
  media_type: 'movie' | 'tv'
  season: number | null
  episode: number | null
  progress_seconds: number | null
  duration_seconds: number | null
  last_watched_at: string
  title: string
  poster_path: string | null
  data: Pick<ContinueEntry, 'backdrop' | 'episodeTitle' | 'still' | 'seasons' | 'source' | 'playerSource' | 'item'>
}

export interface ListRow {
  user_id: string
  title_id: string
  tmdb_id: number | null
  media_type: 'movie' | 'tv'
  title: string
  poster_path: string | null
  saved_at: string
  data: Pick<WatchLaterEntry, 'item'>
}

const iso = (ms: number) => new Date(ms).toISOString()
const ms = (value: string) => {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

export const continueRow = (userId: string, e: ContinueEntry): ContinueRow => ({
  user_id: userId,
  title_id: e.id,
  tmdb_id: e.tmdbId,
  media_type: e.type,
  season: e.season,
  episode: e.episode,
  progress_seconds: e.progressSeconds,
  duration_seconds: e.durationSeconds,
  last_watched_at: iso(e.lastWatchedAt),
  title: e.title,
  poster_path: e.poster,
  data: { backdrop: e.backdrop, episodeTitle: e.episodeTitle, still: e.still, seasons: e.seasons, source: e.source, playerSource: e.playerSource ?? null, item: e.item },
})

export function continueEntry(row: ContinueRow): ContinueEntry | null {
  const data = (row.data ?? {}) as Partial<ContinueRow['data']>
  if (!row.title_id || (row.media_type !== 'movie' && row.media_type !== 'tv') || !data.item) return null
  return {
    id: row.title_id,
    type: row.media_type,
    tmdbId: row.tmdb_id,
    title: row.title,
    poster: row.poster_path,
    backdrop: data.backdrop ?? null,
    season: row.season,
    episode: row.episode,
    episodeTitle: data.episodeTitle ?? null,
    still: data.still ?? null,
    progressSeconds: row.progress_seconds,
    durationSeconds: row.duration_seconds,
    lastWatchedAt: ms(row.last_watched_at),
    seasons: Array.isArray(data.seasons) ? data.seasons : [],
    source: data.source === 'free' ? 'free' : 'stream',
    playerSource: typeof data.playerSource === 'string' ? data.playerSource : null,
    item: data.item,
  }
}

export const listRow = (userId: string, e: WatchLaterEntry): ListRow => ({
  user_id: userId,
  title_id: e.id,
  tmdb_id: e.item.tmdbId ?? null,
  media_type: e.item.type === 'series' ? 'tv' : 'movie',
  title: e.item.title,
  poster_path: e.item.poster,
  saved_at: iso(e.savedAt),
  data: { item: e.item },
})

export function listEntry(row: ListRow): WatchLaterEntry | null {
  const item = (row.data as Partial<ListRow['data']> | null)?.item
  if (!row.title_id || !item) return null
  return { id: row.title_id, savedAt: ms(row.saved_at), item }
}

export interface Merged<T> {
  /** What this device keeps. */
  list: T[]
  /** Pending changes the account doesn't have yet. */
  upload: T[]
  /** Pending removals to make on the account. */
  remove: string[]
}

/**
 * The account's entries, with this device's pending changes on top: a pending
 * removal stays removed, and a pending change wins unless the account has a
 * newer version of the same title (watched later on another device). An
 * entry here that's newer than the account's isn't replaced by it either.
 */
export function mergeEntries<T extends { id: string }>(
  local: T[],
  remote: T[],
  pending: PendingMap,
  time: (entry: T) => number,
): Merged<T> {
  const byId = new Map(remote.map((entry) => [entry.id, entry]))
  const upload: T[] = []
  const remove: string[] = []
  for (const [id, op] of Object.entries(pending)) {
    if (op === 'del') {
      byId.delete(id)
      remove.push(id)
      continue
    }
    const mine = local.find((entry) => entry.id === id)
    if (!mine) continue
    const theirs = byId.get(id)
    if (!theirs || time(mine) >= time(theirs)) {
      byId.set(id, mine)
      upload.push(mine)
    }
  }
  // Not pending but newer here than the account's copy: sent while the account
  // was loading (a pause or the 15-second save), so the copy is from before it.
  // Ours stays, or the player's last position would go back to an older one.
  for (const mine of local) {
    if (pending[mine.id]) continue
    const theirs = byId.get(mine.id)
    if (theirs && time(mine) > time(theirs)) byId.set(mine.id, mine)
  }
  const list = [...byId.values()].sort((a, b) => time(b) - time(a))
  return { list, upload, remove }
}

export const mergeContinue = (local: ContinueEntry[], remote: ContinueEntry[], pending: PendingMap) =>
  mergeEntries(local, remote, pending, (entry) => entry.lastWatchedAt)

export const mergeList = (local: WatchLaterEntry[], remote: WatchLaterEntry[], pending: PendingMap) =>
  mergeEntries(local, remote, pending, (entry) => entry.savedAt)

/** Everything on this device counts as pending (the first sign-in here). */
export const allPending = (entries: { id: string }[]): PendingMap =>
  Object.fromEntries(entries.map((entry) => [entry.id, 'up' as const]))

/**
 * Two taste profiles as one (the first sign-in on a device that has its own):
 * each attribute keeps the stronger score, titles keep the latest visit,
 * hidden titles and the picker's answer add up.
 */
export function combineTaste(a: TasteProfile, b: TasteProfile, now = Date.now()): TasteProfile {
  const scores = attributeScores(a, now)
  for (const [key, score] of attributeScores(b, now)) {
    const mine = scores.get(key)
    if (mine === undefined || Math.abs(score) > Math.abs(mine)) scores.set(key, score)
  }
  const attrs = [...scores].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, MAX_ATTRIBUTES)
  const titles = new Map(a.titles.map((t) => [t.id, t]))
  for (const title of b.titles) {
    const mine = titles.get(title.id)
    if (!mine || title.lastAt > mine.lastAt) titles.set(title.id, title)
  }
  return {
    v: 1,
    attrs: Object.fromEntries(attrs.map(([key, s]) => [key, { s, t: now }])),
    titles: [...titles.values()].sort((x, y) => y.lastAt - x.lastAt).slice(0, MAX_TITLES),
    hidden: [...new Set([...a.hidden, ...b.hidden])],
    asked: a.asked || b.asked,
  }
}

/** A stored profile we can use (anything else counts as none). */
export const isTasteProfile = (value: unknown): value is TasteProfile => {
  const p = value as Partial<TasteProfile> | null
  return typeof p === 'object' && p !== null && p.v === 1 && typeof p.attrs === 'object' && Array.isArray(p.titles) && Array.isArray(p.hidden)
}
