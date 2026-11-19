/**
 * /api/dramas/* for the Short Dramas section (/dramas), shared by the Vite
 * dev/preview server (server/dramas/vite.ts) and the Vercel function
 * api/dramas/[route].ts.
 *
 * Routes (GET unless noted):
 *   home?provider=           shelves of dramas
 *   search?provider=&q=      dramas matching q
 *   drama?provider=&id=      one drama and its episodes (no video links)
 *   play?provider=&id=&ep=   one episode's video sources
 *   settings                 { showLocked }
 *   admin-settings           GET / POST { showLocked } (ADMIN_PASSWORD, from /admin/live)
 *
 * Paid episodes ("locked" in the provider's own app) only get video links
 * while the admin switch "Play paid episodes" is on (Redis key
 * dramas:show-locked, off by default and whenever Redis can't be read). The
 * check is here, on the server, so hiding them in the page isn't the only
 * thing in the way.
 *
 * Ezvid's upstreams are often slow or briefly down, so every answer is
 * cached in memory, served stale when the upstream fails, and asked for once
 * at a time.
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAdmin } from '../live/handlers.js'
import { redis, type RedisEnv } from '../redis.js'
import {
  fetchCatalog,
  searchCatalog,
  type Drama,
  fetchDetail,
  fetchEpisodes,
  fetchHome,
  fetchSearch,
  fetchSource,
  ID,
  isProvider,
  PROVIDER_NAMES,
  DRAMA_PROVIDERS,
  UpstreamError,
  type DramaProvider,
  type EpisodeList,
  type Fetch,
} from './providers.js'

export const SHOW_LOCKED_KEY = 'dramas:show-locked'

/** Cache lifetimes, in ms. */
export const DRAMA_TTL = {
  home: 30 * 60_000,
  search: 30 * 60_000,
  /** Every drama we can list for an app (searched when its own search finds nothing). */
  catalog: 60 * 60_000,
  detail: 6 * 60 * 60_000,
  /** DramaWave's episode lists carry signed video links: kept well inside their expiry. */
  episodes: 30 * 60_000,
  source: 30 * 60_000,
  /** The admin switch, re-read from Redis this often per server instance. */
  setting: 30_000,
  /** After a failure with nothing cached, wait this long before asking again. */
  failed: 30_000,
  /** How long a stale answer may still be served when the upstream fails. */
  keep: 24 * 60 * 60_000,
} as const

interface Entry {
  value?: unknown
  at: number
  failedAt?: number
  pending?: Promise<unknown>
}

export interface DramaCache {
  get<T>(key: string, ttl: number, load: () => Promise<T>): Promise<{ value: T; stale: boolean }>
}

export function createDramaCache(now: () => number = Date.now, max = 500): DramaCache {
  const entries = new Map<string, Entry>()
  return {
    async get<T>(key: string, ttl: number, load: () => Promise<T>) {
      const entry = entries.get(key)
      const time = now()
      if (entry && 'value' in entry && time - entry.at < ttl) return { value: entry.value as T, stale: false }
      if (entry?.pending) {
        try {
          return { value: (await entry.pending) as T, stale: false }
        } catch (error) {
          if (entry && 'value' in entry) return { value: entry.value as T, stale: true }
          throw error
        }
      }
      const hasValue = entry && 'value' in entry && time - entry.at < DRAMA_TTL.keep
      if (!hasValue && entry?.failedAt && time - entry.failedAt < DRAMA_TTL.failed) throw new UpstreamError(502, 'recently failed')
      const next: Entry = entry ?? { at: 0 }
      next.pending = load()
      entries.set(key, next)
      try {
        const value = await next.pending
        entries.set(key, { value, at: now() })
        if (entries.size > max) entries.delete(entries.keys().next().value as string)
        return { value: value as T, stale: false }
      } catch (error) {
        next.pending = undefined
        next.failedAt = now()
        if (hasValue) return { value: next.value as T, stale: true }
        throw error
      }
    },
  }
}

/** One cache per server instance (dev server or warm Vercel function). */
export const sharedDramaCache = createDramaCache()

export interface DramaContext {
  key: string
  cache: DramaCache
  redis: RedisEnv
  adminPassword: string
  authorization?: string
  fetchImpl?: Fetch
  now?: () => number
  /** Vercel's waitUntil: keeps the function alive for work after the answer is sent. */
  waitUntil?: (promise: Promise<unknown>) => void
}

export function readEzvidKey(env: Record<string, string | undefined>) {
  return env.EZVID_API_KEY?.trim() ?? ''
}

// ---- The admin switch ----
let setting: { value: boolean; at: number } | null = null

export async function readShowLocked(ctx: DramaContext): Promise<boolean> {
  const time = (ctx.now ?? Date.now)()
  if (setting && time - setting.at < DRAMA_TTL.setting) return setting.value
  const result = await redis(ctx.redis, [['GET', SHOW_LOCKED_KEY]], ctx.fetchImpl)
  // Off when Redis can't be read: the safe default.
  const value = result?.[0] === '1'
  setting = { value, at: time }
  return value
}

async function writeShowLocked(ctx: DramaContext, value: boolean): Promise<boolean> {
  const result = await redis(ctx.redis, [['SET', SHOW_LOCKED_KEY, value ? '1' : '0']], ctx.fetchImpl)
  if (!result) return false
  setting = { value, at: (ctx.now ?? Date.now)() }
  return true
}

/** For tests: forget the cached switch. */
export const resetDramaSetting = () => void (setting = null)

// ---- HTTP ----

function sendJson(res: ServerResponse, status: number, body: unknown, cdnSeconds = 0) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', cdnSeconds > 0 ? `public, max-age=60, s-maxage=${cdnSeconds}, stale-while-revalidate=${cdnSeconds}` : 'no-store')
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, error: unknown) {
  if (error instanceof UpstreamError && error.status === 403) return sendJson(res, 502, { error: 'key-rejected' })
  sendJson(res, 502, { error: 'upstream-error' })
}

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body)
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1024) throw new Error('too large')
  }
  return JSON.parse(raw || 'null')
}

/** The episode list, cached (DramaWave's holds its video links). */
const episodes = (ctx: DramaContext, provider: DramaProvider, id: string) =>
  ctx.cache.get<EpisodeList>(`episodes:${provider}:${id}`, DRAMA_TTL.episodes, () => fetchEpisodes(ctx.key, provider, id, ctx.fetchImpl))

/**
 * Every drama we can list for an app, for search: the shelves already loaded
 * for its tab, plus its other lists. Never empty in the cache: a list that
 * failed to load is asked for again on the next search.
 */
async function catalogFor(ctx: DramaContext, provider: DramaProvider): Promise<Drama[]> {
  const [home, more] = await Promise.all([
    ctx.cache.get(`home:${provider}`, DRAMA_TTL.home, () => fetchHome(ctx.key, provider, ctx.fetchImpl)).then((r) => r.value.flatMap((s) => s.dramas), () => [] as Drama[]),
    ctx.cache
      .get(`catalog:${provider}`, DRAMA_TTL.catalog, async () => {
        const dramas = await fetchCatalog(ctx.key, provider, ctx.fetchImpl)
        if (!dramas.length) throw new UpstreamError(502, 'empty catalog')
        return dramas
      })
      .then((r) => r.value, () => [] as Drama[]),
  ])
  const all = [...home, ...more]
  return all.filter((d, i) => all.findIndex((o) => o.id === d.id) === i)
}

export function splitDramaUrl(url: string) {
  const parsed = new URL(url, 'http://localhost')
  const route = (parsed.searchParams.get('__path') ?? parsed.pathname.replace(/^\/api\/dramas/, '')).replace(/^\/+|\/+$/g, '')
  parsed.searchParams.delete('__path')
  return { route, params: parsed.searchParams }
}

export async function handleDramas(ctx: DramaContext, req: IncomingMessage & { body?: unknown }, route: string, params: URLSearchParams, res: ServerResponse) {
  const method = req.method ?? 'GET'

  if (route === 'admin-settings') {
    if (!ctx.adminPassword) return sendJson(res, 503, { error: 'not-configured' })
    if (!isAdmin({ adminPassword: ctx.adminPassword, redisUrl: '', redisToken: '' }, ctx.authorization)) return sendJson(res, 401, { error: 'unauthorized' })
    if (method === 'POST') {
      let body: { showLocked?: unknown } | null
      try {
        body = (await readBody(req)) as { showLocked?: unknown } | null
      } catch {
        return sendJson(res, 400, { error: 'bad-request' })
      }
      if (typeof body?.showLocked !== 'boolean') return sendJson(res, 400, { error: 'bad-request' })
      if (!(await writeShowLocked(ctx, body.showLocked))) return sendJson(res, 503, { error: 'no-store' })
      return sendJson(res, 200, { showLocked: body.showLocked, configured: Boolean(ctx.key) })
    }
    setting = null
    return sendJson(res, 200, { showLocked: await readShowLocked(ctx), configured: Boolean(ctx.key) })
  }

  if (method !== 'GET') return sendJson(res, 405, { error: 'method' })

  if (route === 'settings') {
    return sendJson(res, 200, {
      configured: Boolean(ctx.key),
      showLocked: await readShowLocked(ctx),
      providers: DRAMA_PROVIDERS.map((id) => ({ id, name: PROVIDER_NAMES[id] })),
    })
  }

  if (!ctx.key) return sendJson(res, 503, { error: 'not-configured' })
  const provider = params.get('provider')
  if (!isProvider(provider)) return sendJson(res, 400, { error: 'bad-request' })

  try {
    if (route === 'home') {
      // Loads the app's searchable list now, so a search moments later is quick.
      ctx.waitUntil?.(catalogFor(ctx, provider))
      const { value, stale } = await ctx.cache.get(`home:${provider}`, DRAMA_TTL.home, () => fetchHome(ctx.key, provider, ctx.fetchImpl))
      return sendJson(res, 200, { provider, shelves: value, stale }, stale ? 0 : 300)
    }

    if (route === 'search') {
      const q = (params.get('q') ?? '').trim().slice(0, 80)
      if (q.length < 2) return sendJson(res, 400, { error: 'bad-request' })
      // The app's own search, then the dramas we can list for it (DramaWave's
      // search often fails).
      // Both at once, so a slow search doesn't hold up the list.
      const [upstream, catalog] = await Promise.all([
        ctx.cache
          .get(`search:${provider}:${q.toLowerCase()}`, DRAMA_TTL.search, () => fetchSearch(ctx.key, provider, q, ctx.fetchImpl))
          .then((r) => r.value, () => [] as Drama[]),
        catalogFor(ctx, provider),
      ])
      const found = [...upstream, ...searchCatalog(catalog, q)]
      const dramas = found.filter((d, i) => found.findIndex((o) => o.id === d.id) === i)
      return sendJson(res, 200, { provider, dramas }, dramas.length ? 600 : 0)
    }

    const id = params.get('id') ?? ''
    if (!ID.test(id)) return sendJson(res, 400, { error: 'bad-request' })

    if (route === 'drama') {
      const [detail, list, showLocked] = await Promise.all([
        ctx.cache.get(`detail:${provider}:${id}`, DRAMA_TTL.detail, () => fetchDetail(ctx.key, provider, id, ctx.fetchImpl)).catch(() => null),
        episodes(ctx, provider, id),
        readShowLocked(ctx),
      ])
      const drama = detail?.value ?? null
      // Only what the page needs: never the video links (those come from /play).
      const eps = list.value.episodes.map(({ id: epId, number, title, locked }) => ({ id: epId, number, title, locked, playable: !locked || showLocked }))
      return sendJson(res, 200, { provider, drama, title: drama?.title || list.value.title, episodes: eps, showLocked })
    }

    if (route === 'play') {
      const ep = params.get('ep') ?? ''
      if (!ID.test(ep)) return sendJson(res, 400, { error: 'bad-request' })
      const [list, showLocked] = await Promise.all([episodes(ctx, provider, id), readShowLocked(ctx)])
      const episode = list.value.episodes.find((e) => e.id === ep)
      if (!episode) return sendJson(res, 404, { error: 'not-found' })
      if (episode.locked && !showLocked) return sendJson(res, 403, { error: 'locked' })
      const sources =
        episode.sources ??
        (await ctx.cache.get(`source:${provider}:${id}:${ep}`, DRAMA_TTL.source, () => fetchSource(ctx.key, provider, id, ep, ctx.fetchImpl))).value
      if (!sources.length) return sendJson(res, 404, { error: 'no-source' })
      return sendJson(res, 200, { sources })
    }
  } catch (error) {
    return sendError(res, error)
  }

  sendJson(res, 404, { error: 'not-found' })
}
