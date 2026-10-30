/**
 * /api/search-index: a few thousand well-known titles for the browser's
 * typo-tolerant search (src/search). Built from TMDB's popular, trending and
 * top-rated lists plus Nollywood, K-drama, anime and Bollywood, then shared
 * by every server instance through Upstash Redis (in memory without it) and
 * rebuilt once a day. When a rebuild fails, the last good copy is served.
 *
 * Rows are compact: [tmdbId, "m" | "s", title, originalTitle | "", year | 0,
 * posterPath | "", popularity, score × 10] (see src/search/titleIndex.ts).
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { ServerResponse } from 'node:http'
import { tmdbUpstreamUrl, type TmdbCredentials } from './handlers.js'
import { hasRedis, redis, type RedisEnv } from './redis.js'

export type IndexRow = [number, 'm' | 's', string, string, number, string, number, number]

export interface SearchIndexSnapshot {
  builtAt: number
  rows: IndexRow[]
}

export const SEARCH_INDEX_KEY = 'search:index:v1'
const LOCK_KEY = 'search:index:lock'
/** Rebuilt after a day… */
export const INDEX_FRESH_MS = 24 * 60 * 60 * 1000
/** …and the last good copy kept a week, for when TMDB fails. */
const INDEX_KEEP_S = 7 * 24 * 60 * 60
const LOCK_S = 120
/** A build with fewer titles than this is treated as failed. */
export const MIN_ROWS = 100
const CONCURRENCY = 8
const TMDB_TIMEOUT_MS = 10_000

interface ListSpec {
  path: string
  params?: Record<string, string>
  pages: number
  kind: 'm' | 's'
}

const byPopularity = { sort_by: 'popularity.desc' }

/** The lists the index is built from, ~190 TMDB requests in all (~3,000 titles). */
export const INDEX_LISTS: ListSpec[] = [
  { path: '/trending/movie/week', pages: 5, kind: 'm' },
  { path: '/trending/tv/week', pages: 5, kind: 's' },
  { path: '/movie/popular', pages: 40, kind: 'm' },
  { path: '/tv/popular', pages: 40, kind: 's' },
  { path: '/movie/top_rated', pages: 25, kind: 'm' },
  { path: '/tv/top_rated', pages: 25, kind: 's' },
  // Nollywood
  { path: '/discover/movie', params: { ...byPopularity, with_origin_country: 'NG' }, pages: 8, kind: 'm' },
  { path: '/discover/tv', params: { ...byPopularity, with_origin_country: 'NG' }, pages: 4, kind: 's' },
  // K-drama, and Korean films
  { path: '/discover/tv', params: { ...byPopularity, with_origin_country: 'KR', with_genres: '18' }, pages: 8, kind: 's' },
  { path: '/discover/movie', params: { ...byPopularity, with_origin_country: 'KR' }, pages: 3, kind: 'm' },
  // Anime: Japanese animation
  { path: '/discover/tv', params: { ...byPopularity, with_genres: '16', with_original_language: 'ja' }, pages: 8, kind: 's' },
  { path: '/discover/movie', params: { ...byPopularity, with_genres: '16', with_original_language: 'ja' }, pages: 4, kind: 'm' },
  // Bollywood
  { path: '/discover/movie', params: { ...byPopularity, with_origin_country: 'IN', with_original_language: 'hi' }, pages: 8, kind: 'm' },
  { path: '/discover/tv', params: { ...byPopularity, with_origin_country: 'IN' }, pages: 3, kind: 's' },
]

interface TmdbListResult {
  id: number
  title?: string
  name?: string
  original_title?: string
  original_name?: string
  release_date?: string
  first_air_date?: string
  poster_path?: string | null
  popularity?: number
  vote_average?: number
  adult?: boolean
}

async function fetchPage(credentials: TmdbCredentials, spec: ListSpec, page: number, fetchImpl: typeof fetch): Promise<IndexRow[]> {
  const params = new URLSearchParams({ language: 'en-US', include_adult: 'false', ...spec.params, page: String(page) })
  const url = tmdbUpstreamUrl(credentials, spec.path, params)
  if (!url) return []
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', ...(credentials.readToken ? { Authorization: `Bearer ${credentials.readToken}` } : {}) },
      signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const body = (await response.json()) as { results?: TmdbListResult[] }
    return (body.results ?? []).flatMap((r): IndexRow[] => {
      const title = (r.title ?? r.name ?? '').trim()
      if (r.adult || !title || typeof r.id !== 'number') return []
      const original = (r.original_title ?? r.original_name ?? '').trim()
      const year = Number((r.release_date || r.first_air_date || '').slice(0, 4)) || 0
      return [[r.id, spec.kind, title, original !== title ? original : '', year, r.poster_path ?? '', Math.round(r.popularity ?? 0), Math.round((r.vote_average ?? 0) * 10)]]
    })
  } catch {
    return []
  }
}

/** Fetches every list page (a few at a time) and keeps one row per title, the most popular copy. */
export async function buildSearchIndex(credentials: TmdbCredentials, fetchImpl: typeof fetch = fetch): Promise<IndexRow[]> {
  const jobs = INDEX_LISTS.flatMap((spec) => Array.from({ length: spec.pages }, (_, i) => () => fetchPage(credentials, spec, i + 1, fetchImpl)))
  const pages: IndexRow[][] = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length) pages.push(await jobs[next++]())
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const rows = new Map<string, IndexRow>()
  for (const row of pages.flat()) {
    const key = `${row[1]}${row[0]}`
    const seen = rows.get(key)
    if (!seen || row[6] > seen[6]) rows.set(key, row)
  }
  return [...rows.values()].sort((a, b) => b[6] - a[6])
}

export interface SearchIndexStore {
  get(): Promise<SearchIndexSnapshot | null>
  set(snapshot: SearchIndexSnapshot): Promise<void>
  /** True when this instance may rebuild (no one else is). */
  lock(): Promise<boolean>
}

export function createMemoryIndexStore(): SearchIndexStore {
  let snapshot: SearchIndexSnapshot | null = null
  return {
    get: async () => snapshot,
    set: async (next) => {
      snapshot = next
    },
    lock: async () => true,
  }
}

export function createRedisIndexStore(env: RedisEnv, fetchImpl: typeof fetch = fetch): SearchIndexStore {
  return {
    async get() {
      const [raw] = (await redis(env, [['GET', SEARCH_INDEX_KEY]], fetchImpl)) ?? [null]
      if (typeof raw !== 'string') return null
      try {
        const snapshot = JSON.parse(raw) as SearchIndexSnapshot
        return typeof snapshot.builtAt === 'number' && Array.isArray(snapshot.rows) ? snapshot : null
      } catch {
        return null
      }
    },
    async set(snapshot) {
      await redis(env, [['SET', SEARCH_INDEX_KEY, JSON.stringify(snapshot), 'EX', INDEX_KEEP_S]], fetchImpl)
    },
    async lock() {
      const result = await redis(env, [['SET', LOCK_KEY, '1', 'NX', 'EX', LOCK_S]], fetchImpl)
      // Redis unreachable: build anyway rather than serve nothing.
      return !result || result[0] === 'OK'
    },
  }
}

export const createIndexStore = (env: RedisEnv, fetchImpl: typeof fetch = fetch) =>
  hasRedis(env) ? createRedisIndexStore(env, fetchImpl) : createMemoryIndexStore()

/** Browsers keep it an hour; the CDN six, then serves the old copy while it refreshes. */
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400'

function send(res: ServerResponse, status: number, body: unknown, cache: string) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', cache)
  res.end(JSON.stringify(body))
}

/** The index: the stored copy while it's fresh, else a rebuild (the stored copy if that fails). */
export async function handleSearchIndex(
  credentials: TmdbCredentials,
  store: SearchIndexStore,
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  const saved = await store.get()
  const reply = (snapshot: SearchIndexSnapshot) => send(res, 200, snapshot, CACHE_CONTROL)
  if (saved && now - saved.builtAt < INDEX_FRESH_MS) return reply(saved)
  if (!credentials.readToken && !credentials.apiKey) {
    return saved ? reply(saved) : send(res, 503, { rows: [], reason: 'not-configured' }, 'no-store')
  }
  // Someone else is rebuilding: the old copy will do for now.
  if (saved && !(await store.lock())) return reply(saved)
  const rows = await buildSearchIndex(credentials, fetchImpl)
  if (rows.length >= MIN_ROWS) {
    const snapshot = { builtAt: now, rows }
    await store.set(snapshot)
    return reply(snapshot)
  }
  return saved ? reply(saved) : send(res, 503, { rows: [], reason: 'unavailable' }, 'no-store')
}
