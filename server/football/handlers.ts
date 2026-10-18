/**
 * API-Football (api-sports.io) proxy for the Football section, shared by the
 * Vite dev/preview server (server/football/vite.ts) and the Vercel functions
 * in api/football/. The key (API_FOOTBALL_KEY) is only ever read here, on the
 * server, and is sent upstream in the x-apisports-key header.
 *
 * Both providers' plans have tight request quotas, so every answer is cached:
 * in memory, in a cache shared by every server instance (Vercel's Runtime
 * Cache, see api/football/[route].ts) and, through s-maxage, on Vercel's CDN.
 * Only one upstream call per answer is made at a time. When the upstream call
 * fails, the last good answer is served instead, marked `stale`, and the call
 * isn't tried again for a while.
 *
 * Only the featured leagues are served (server/football/priority.ts).
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { ServerResponse } from 'node:http'
import {
  fetchStreamLink,
  fetchStreamListing,
  findMatchStream,
  isProviderMatchId,
  NO_STREAM,
  providerFixtures,
  type MatchStream,
  type ProviderFixture,
} from './stream.js'
import { isFeaturedLeague } from './priority.js'

export const FOOTBALL_ORIGIN = 'https://v3.football.api-sports.io'
const UPSTREAM_TIMEOUT_MS = 10000

/** Leagues with standings tabs. Only these may be requested from /standings. */
export const FOOTBALL_LEAGUES = [
  { id: 39, name: 'Premier League' },
  { id: 140, name: 'La Liga' },
  { id: 2, name: 'Champions League' },
  { id: 3, name: 'Europa League' },
  { id: 848, name: 'Conference League' },
] as const

/** Cache lifetimes, in seconds. */
export const FOOTBALL_TTL = {
  live: 5 * 60,
  fixtures: 10 * 60,
  standings: 60 * 60,
  season: 12 * 60 * 60,
  matchLive: 5 * 60,
  matchFinished: 60 * 60,
  /** Out of requests: wait before asking again. */
  rateLimited: 5 * 60,
  /** Key rejected or account suspended: it won't fix itself in a minute. */
  rejected: 30 * 60,
  /** Any other failure, while the last good answer is served. */
  failed: 60,
  /** Which live matches have a stream (see watchable). */
  watchable: 5 * 60,
  /** The stream provider's listing (one request, shared by every match). */
  streams: 5 * 60,
  /** A match's stream link rarely changes, and each check is one provider request. */
  streamLinks: 2 * 60 * 60,
  /** A match without a stream yet is checked again later, as streams start near kick-off. */
  noStreamLink: 15 * 60,
  /** How long the shared cache keeps an answer, as a fallback for when a provider fails. */
  keep: 24 * 60 * 60,
} as const

export type FootballErrorReason =
  | 'bad-request'
  | 'not-configured'
  | 'rate-limited'
  | 'plan'
  | 'auth'
  | 'not-found'
  | 'upstream-error'
  | 'unreachable'

const ERROR_STATUS: Record<FootballErrorReason, number> = {
  'bad-request': 400,
  'not-configured': 503,
  'rate-limited': 429,
  plan: 403,
  auth: 502,
  'not-found': 404,
  'upstream-error': 502,
  unreachable: 502,
}

export function readFootballKey(env: Record<string, string | undefined>) {
  return env.API_FOOTBALL_KEY?.trim() ?? ''
}

type Outcome =
  | { ok: true; data: unknown; extra?: Record<string, unknown> }
  | { ok: false; reason: FootballErrorReason; extra?: Record<string, unknown> }

interface CacheEntry {
  outcome: Outcome
  expires: number
  /** The last good answer, kept on after a failed refresh. */
  stale?: boolean
}

/** A cache shared by every server instance (Vercel's Runtime Cache has this shape). */
export interface SharedStore {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown, options?: { ttl?: number }) => Promise<void>
}

const isCacheEntry = (value: unknown): value is CacheEntry =>
  typeof value === 'object' && value !== null && typeof (value as CacheEntry).expires === 'number' &&
  typeof (value as CacheEntry).outcome === 'object' && (value as CacheEntry).outcome !== null

/**
 * In memory, plus `shared` when given. Entries are kept after they expire, as
 * a stale fallback. A shared store that fails is simply skipped.
 */
export function createFootballCache(now: () => number = Date.now, shared?: SharedStore) {
  const entries = new Map<string, CacheEntry>()
  /** Upstream calls in progress, so concurrent requests share one. */
  const pending = new Map<string, Promise<Loaded>>()
  return {
    now,
    pending,
    async get(key: string): Promise<CacheEntry | undefined> {
      const local = entries.get(key)
      if ((local && local.expires > now()) || !shared) return local
      try {
        const found = await shared.get(key)
        if (isCacheEntry(found) && (!local || found.expires > local.expires)) {
          entries.set(key, found)
          return found
        }
      } catch {
        // Shared cache unavailable: memory only.
      }
      return local
    },
    async set(key: string, entry: CacheEntry) {
      entries.set(key, entry)
      try {
        await shared?.set(key, entry, { ttl: FOOTBALL_TTL.keep })
      } catch {
        // Shared cache unavailable: memory only.
      }
    },
  }
}

export type FootballCache = ReturnType<typeof createFootballCache>

export interface FootballContext {
  key: string
  /** RAPIDAPI_KEY, for the Football Live Stream API (only the stream route uses it). */
  rapidKey?: string
  cache: FootballCache
  fetchImpl?: typeof fetch
}

const isEmptyErrors = (errors: unknown) =>
  errors === undefined ||
  errors === null ||
  (Array.isArray(errors) ? errors.length === 0 : typeof errors === 'object' && !Object.keys(errors).length)

/**
 * Maps API-Football's error object to a reason. It reports most problems with
 * HTTP 200 and e.g. {"errors": {"requests": "You have reached the request limit
 * for the day"}}, {"rateLimit": ...}, {"plan": ...} or {"token": ...}.
 */
export function classifyApiErrors(errors: unknown): FootballErrorReason {
  const keys = errors && typeof errors === 'object' ? Object.keys(errors).map((k) => k.toLowerCase()) : []
  if (keys.some((k) => k === 'ratelimit' || k === 'requests')) return 'rate-limited'
  if (keys.includes('plan')) return 'plan'
  if (keys.some((k) => k === 'token' || k === 'access')) return 'auth'
  return 'upstream-error'
}

/** One upstream call. Never throws; never includes the key in what it returns. */
async function callApi(ctx: FootballContext, path: string, params: Record<string, string>): Promise<Outcome> {
  const url = `${FOOTBALL_ORIGIN}/${path}?${new URLSearchParams(params)}`
  let upstream: Response
  try {
    upstream = await (ctx.fetchImpl ?? fetch)(url, {
      headers: { 'x-apisports-key': ctx.key, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (upstream.status === 429) return { ok: false, reason: 'rate-limited' }
  if (upstream.status === 401 || upstream.status === 403) return { ok: false, reason: 'auth' }
  if (!upstream.ok) return { ok: false, reason: 'upstream-error' }
  try {
    const body = (await upstream.json()) as { errors?: unknown; response?: unknown }
    if (!isEmptyErrors(body.errors)) return { ok: false, reason: classifyApiErrors(body.errors) }
    return { ok: true, data: body.response ?? [] }
  } catch {
    return { ok: false, reason: 'upstream-error' }
  }
}

/** How long an outcome may be cached, or 0 to not cache it at all. */
const ttlFor = (outcome: Outcome, successTtl: number) =>
  outcome.ok
    ? successTtl
    : outcome.reason === 'plan'
      ? successTtl
      : outcome.reason === 'rate-limited'
        ? FOOTBALL_TTL.rateLimited
        : outcome.reason === 'auth'
          ? FOOTBALL_TTL.rejected
          : 0

interface Loaded {
  outcome: Outcome
  maxAge: number
  stale: boolean
}

/**
 * Returns the cached outcome while it is fresh, otherwise calls `load` (once,
 * however many requests are waiting for it). A failed refresh falls back to
 * the last good answer, marked stale, which is then kept for a while before
 * the provider is asked again.
 */
async function cached(
  ctx: FootballContext,
  cacheKey: string,
  load: () => Promise<Outcome>,
  successTtl: (outcome: Outcome) => number,
): Promise<Loaded> {
  const entry = await ctx.cache.get(cacheKey)
  const now = ctx.cache.now()
  if (entry && entry.expires > now) {
    const maxAge = entry.stale ? 0 : Math.ceil((entry.expires - now) / 1000)
    return { outcome: entry.outcome, maxAge, stale: !!entry.stale }
  }
  const inFlight = ctx.cache.pending.get(cacheKey)
  if (inFlight) return inFlight
  const refresh = (async (): Promise<Loaded> => {
    const outcome = await load()
    const at = ctx.cache.now()
    if (!outcome.ok && entry?.outcome.ok) {
      const wait = ttlFor(outcome, FOOTBALL_TTL.failed) || FOOTBALL_TTL.failed
      await ctx.cache.set(cacheKey, { outcome: entry.outcome, expires: at + wait * 1000, stale: true })
      return { outcome: entry.outcome, maxAge: 0, stale: true }
    }
    const ttl = ttlFor(outcome, successTtl(outcome))
    if (ttl > 0) await ctx.cache.set(cacheKey, { outcome, expires: at + ttl * 1000 })
    return { outcome, maxAge: ttl, stale: false }
  })()
  ctx.cache.pending.set(cacheKey, refresh)
  try {
    return await refresh
  } finally {
    ctx.cache.pending.delete(cacheKey)
  }
}

function send(res: ServerResponse, result: { outcome: Outcome; maxAge: number; stale: boolean }) {
  const { outcome, maxAge, stale } = result
  res.statusCode = outcome.ok ? 200 : ERROR_STATUS[outcome.reason]
  res.setHeader('Content-Type', 'application/json')
  res.setHeader(
    'Cache-Control',
    maxAge > 0 ? `public, max-age=0, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}` : 'no-store',
  )
  if (!outcome.ok && outcome.reason === 'rate-limited') res.setHeader('Retry-After', String(maxAge || 60))
  res.end(
    JSON.stringify(
      outcome.ok
        ? { ...outcome.extra, data: outcome.data, ...(stale ? { stale: true } : {}) }
        : { ...outcome.extra, error: outcome.reason },
    ),
  )
}

const fail = (res: ServerResponse, reason: FootballErrorReason) =>
  send(res, { outcome: { ok: false, reason }, maxAge: 0, stale: false })

const fixed = (ttl: number) => () => ttl

/** GET /api/football/live: every match in play right now. */
const loadLive = (ctx: FootballContext) =>
  cached(ctx, 'live', () => callApi(ctx, 'fixtures', { live: 'all' }), fixed(FOOTBALL_TTL.live))

/**
 * When API-Football fails, answers from the stream provider's listing instead
 * (see providerFixture in stream.ts), so matches and scores keep showing.
 */
async function withProviderFallback(
  ctx: FootballContext,
  result: Loaded,
  pick: (fixture: ProviderFixture) => boolean,
): Promise<Loaded> {
  if (result.outcome.ok || !ctx.rapidKey) return result
  const listing = await loadStreamListing(ctx, ctx.rapidKey)
  if (!listing.outcome.ok) return result
  const data = featuredProviderFixtures(listing.outcome.data as unknown[])
    .map((p) => p.fixture)
    .filter(pick)
  return { outcome: { ok: true, data, extra: { source: 'rapidapi' } }, maxAge: listing.maxAge, stale: listing.stale }
}

/** The stream provider's matches in the featured leagues. */
const featuredProviderFixtures = (items: unknown[]) => providerFixtures(items).filter((p) => isFeaturedLeague(p.fixture.league))

/** Drops the matches outside the featured leagues from a list of fixtures. */
function featuredOnly(result: Loaded): Loaded {
  const { outcome } = result
  if (!outcome.ok || !Array.isArray(outcome.data)) return result
  const data = (outcome.data as { league?: { id?: number; name?: string } }[]).filter((f) => isFeaturedLeague(f.league))
  return { ...result, outcome: { ...outcome, data } }
}

const isProviderLive = (f: ProviderFixture) => f.fixture.status.short === 'LIVE'

const liveOrFallback = async (ctx: FootballContext) =>
  featuredOnly(await withProviderFallback(ctx, await loadLive(ctx), isProviderLive))

async function live(ctx: FootballContext, _params: URLSearchParams, res: ServerResponse) {
  send(res, await liveOrFallback(ctx))
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * GET /api/football/fixtures?date=YYYY-MM-DD: one day's fixtures and results.
 * Only yesterday/today/tomorrow (UTC) are accepted, so a viewer's local "today"
 * always works but nobody can spend the daily quota on arbitrary dates.
 */
async function fixtures(ctx: FootballContext, params: URLSearchParams, res: ServerResponse) {
  const date = params.get('date') ?? ''
  const day = Date.parse(`${date}T00:00:00Z`)
  const today = Date.parse(`${new Date(ctx.cache.now()).toISOString().slice(0, 10)}T00:00:00Z`)
  if (!DATE.test(date) || Number.isNaN(day) || Math.abs(day - today) > DAY_MS) {
    return fail(res, 'bad-request')
  }
  const result = await cached(ctx, `fixtures:${date}`, () => callApi(ctx, 'fixtures', { date }), fixed(FOOTBALL_TTL.fixtures))
  send(res, featuredOnly(await withProviderFallback(ctx, result, (f) => f.fixture.date.slice(0, 10) === date)))
}

interface LeagueSeason {
  year: number
  start?: string
  end?: string
  current?: boolean
}

/** Looks up a league's current season (never hard-coded). */
async function currentSeason(ctx: FootballContext, league: number): Promise<Outcome> {
  const { outcome } = await cached(
    ctx,
    `season:${league}`,
    async () => {
      const found = await callApi(ctx, 'leagues', { id: String(league), current: 'true' })
      if (!found.ok) return found
      const seasons = (found.data as { seasons?: LeagueSeason[] }[])[0]?.seasons ?? []
      const season = seasons.find((s) => s.current) ?? seasons.at(-1)
      if (!season) return { ok: false, reason: 'not-found' }
      return { ok: true, data: { year: season.year, start: season.start, end: season.end } }
    },
    fixed(FOOTBALL_TTL.season),
  )
  return outcome
}

/** GET /api/football/standings?league=39: the table for the league's current season. */
async function standings(ctx: FootballContext, params: URLSearchParams, res: ServerResponse) {
  const league = Number(params.get('league'))
  if (!FOOTBALL_LEAGUES.some((l) => l.id === league)) return fail(res, 'bad-request')

  const season = await currentSeason(ctx, league)
  if (!season.ok) return fail(res, season.reason)
  const info = season.data as LeagueSeason

  const result = await cached(
    ctx,
    `standings:${league}:${info.year}`,
    () => callApi(ctx, 'standings', { league: String(league), season: String(info.year) }),
    fixed(FOOTBALL_TTL.standings),
  )
  send(res, { ...result, outcome: { ...result.outcome, extra: { season: info } } })
}

const FINISHED = new Set(['FT', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO'])
const MATCH_ID = /^[1-9]\d{0,9}$/

/** One match with events, lineups and statistics, through the cache. */
function loadMatch(ctx: FootballContext, id: string) {
  return cached(
    ctx,
    `match:${id}`,
    async () => {
      const found = await callApi(ctx, 'fixtures', { id })
      if (!found.ok) return found
      const fixture = (found.data as unknown[])[0]
      return fixture ? { ok: true, data: fixture } : { ok: false, reason: 'not-found' }
    },
    (outcome) => {
      const status = outcome.ok
        ? (outcome.data as { fixture?: { status?: { short?: string } } }).fixture?.status?.short
        : undefined
      return status && FINISHED.has(status) ? FOOTBALL_TTL.matchFinished : FOOTBALL_TTL.matchLive
    },
  )
}

/** GET /api/football/match?id=123: one match with events, lineups and statistics. */
async function match(ctx: FootballContext, params: URLSearchParams, res: ServerResponse) {
  const id = params.get('id') ?? ''
  if (!MATCH_ID.test(id)) return fail(res, 'bad-request')
  if (isProviderMatchId(Number(id))) {
    const found = await findProviderMatch(ctx, Number(id))
    return found ? send(res, found.result) : fail(res, 'not-found')
  }
  send(res, await loadMatch(ctx, id))
}

/** A match that came from the stream provider's listing (id from providerMatchId). */
async function findProviderMatch(ctx: FootballContext, id: number) {
  if (!ctx.rapidKey) return null
  const listing = await loadStreamListing(ctx, ctx.rapidKey)
  if (!listing.outcome.ok) return null
  const items = listing.outcome.data as unknown[]
  const found = featuredProviderFixtures(items).find((p) => p.fixture.fixture.id === id)
  if (!found) return null
  const result: Loaded = { outcome: { ok: true, data: found.fixture }, maxAge: FOOTBALL_TTL.streams, stale: false }
  return { ...found, items, result }
}

/**
 * GET /api/football/stream?id=123: stream links and live commentary for one
 * of our matches, from the Football Live Stream API (RapidAPI). The match is
 * looked up here (it is usually cached already) and paired with the provider's
 * listing by team names. No pairing is not an error: it answers
 * { available: false }, so the match page simply shows "no stream".
 */
async function stream(ctx: FootballContext, params: URLSearchParams, res: ServerResponse) {
  const id = params.get('id') ?? ''
  if (!MATCH_ID.test(id)) return fail(res, 'bad-request')
  if (!ctx.rapidKey) return fail(res, 'not-configured')

  if (isProviderMatchId(Number(id))) {
    const provider = await findProviderMatch(ctx, Number(id))
    if (!provider) return fail(res, 'not-found')
    const { home, away } = provider.fixture.teams
    const { providerId: _ignored, ...paired } = findMatchStream(provider.items, home.name, away.name)
    const result: MatchStream = paired
    if (!result.streams.length) result.streams = await loadStreamLink(ctx, ctx.rapidKey, provider.providerId)
    result.available = result.streams.length > 0 || result.commentary.length > 0
    return send(res, { outcome: { ok: true, data: result }, maxAge: FOOTBALL_TTL.streams, stale: false })
  }

  const found = (await loadMatch(ctx, id)).outcome
  if (!found.ok) return fail(res, found.reason)
  const teams = (found.data as { teams?: { home?: { name?: string }; away?: { name?: string } } }).teams
  const home = teams?.home?.name
  const away = teams?.away?.name
  if (!home || !away) {
    return send(res, { outcome: { ok: true, data: NO_STREAM }, maxAge: FOOTBALL_TTL.streams, stale: false })
  }

  const listing = await loadStreamListing(ctx, ctx.rapidKey)
  if (!listing.outcome.ok) return send(res, listing)
  const { providerId, ...paired } = findMatchStream(listing.outcome.data as unknown[], home, away)
  const result: MatchStream = paired
  if (providerId && !result.streams.length) {
    result.streams = await loadStreamLink(ctx, ctx.rapidKey, providerId)
    result.available = result.streams.length > 0 || result.commentary.length > 0
  }
  send(res, { ...listing, outcome: { ok: true, data: result } })
}

/** The Football Live Stream API's match listing, shared by every match. */
function loadStreamListing(ctx: FootballContext, rapidKey: string) {
  return cached(
    ctx,
    'streams',
    async () => {
      const result = await fetchStreamListing(rapidKey, ctx.fetchImpl)
      return result.ok ? { ok: true, data: result.items } : { ok: false, reason: result.reason }
    },
    fixed(FOOTBALL_TTL.streams),
  )
}

/** One provider match's stream sources ([] when it has none). */
async function loadStreamLink(ctx: FootballContext, rapidKey: string, providerId: string) {
  const link = await cached(
    ctx,
    `stream-link:${providerId}`,
    async () => ({ ok: true, data: await fetchStreamLink(rapidKey, providerId, ctx.fetchImpl) }),
    (outcome) =>
      outcome.ok && (outcome.data as unknown[]).length ? FOOTBALL_TTL.streamLinks : FOOTBALL_TTL.noStreamLink,
  )
  return link.outcome.ok ? (link.outcome.data as MatchStream['streams']) : []
}

interface LiveFixture {
  fixture?: { id?: number }
  teams?: { home?: { name?: string }; away?: { name?: string } }
}

/**
 * GET /api/football/watchable: ids of the live matches that have a stream,
 * so the list can put them first. Each check is one provider request, so only
 * the featured leagues' live matches are checked (live is already limited to
 * them), and each answer is kept (FOOTBALL_TTL.streamLinks / noStreamLink).
 * Without RAPIDAPI_KEY, or when the stream provider fails, it is simply an
 * empty list and the page is unaffected.
 */
async function watchable(ctx: FootballContext, _params: URLSearchParams, res: ServerResponse) {
  const empty = { outcome: { ok: true, data: [] }, maxAge: FOOTBALL_TTL.watchable, stale: false } as const
  const rapidKey = ctx.rapidKey
  if (!rapidKey) return send(res, empty)
  const result = await cached(
    ctx,
    'watchable',
    async () => {
      const [liveNow, listing] = await Promise.all([liveOrFallback(ctx), loadStreamListing(ctx, rapidKey)])
      if (!liveNow.outcome.ok || !listing.outcome.ok) return { ok: true, data: [] }
      const items = listing.outcome.data as unknown[]
      // Matches from the provider itself already carry its id.
      const providerIds = new Map(providerFixtures(items).map((p) => [p.fixture.fixture.id, p.providerId]))
      const candidates = (liveNow.outcome.data as LiveFixture[]).flatMap((f) => {
        const id = f.fixture?.id
        const home = f.teams?.home?.name
        const away = f.teams?.away?.name
        if (!id || !home || !away) return []
        const own = providerIds.get(id)
        if (own) return [{ id, providerId: own, streams: [] }]
        const { providerId, streams } = findMatchStream(items, home, away)
        return providerId ? [{ id, providerId, streams }] : []
      })
      const checked = await Promise.all(
        candidates.map(async (c) =>
          c.streams.length || (await loadStreamLink(ctx, rapidKey, c.providerId)).length ? c.id : null,
        ),
      )
      return { ok: true, data: checked.filter((id) => id !== null) }
    },
    fixed(FOOTBALL_TTL.watchable),
  )
  send(res, result)
}

const ROUTES = { live, fixtures, standings, match, stream, watchable }

export type FootballRoute = keyof typeof ROUTES

/** Serves /api/football/{live,fixtures,standings,match,stream,watchable}. */
export async function handleFootball(
  ctx: FootballContext,
  method: string | undefined,
  route: string,
  params: URLSearchParams,
  res: ServerResponse,
) {
  if (method && method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ error: 'bad-request' }))
  }
  const handler = Object.hasOwn(ROUTES, route) ? ROUTES[route as FootballRoute] : undefined
  if (!handler) return fail(res, 'not-found')
  if (!ctx.key) return fail(res, 'not-configured')
  await handler(ctx, params, res)
}

/** Splits `/live?x=1` (or `/api/football/live?x=1`) into the route name and query. */
export function splitFootballUrl(rawUrl: string) {
  const url = new URL(rawUrl, 'http://localhost')
  const route = url.pathname.replace(/^\/api\/football/, '').replace(/^\/+|\/+$/g, '')
  return { route, params: url.searchParams }
}

/** One cache per server process (or warm Vercel function instance). */
export const sharedFootballCache = createFootballCache()
