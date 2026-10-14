/**
 * API-Football (api-sports.io) proxy for the Football section, shared by the
 * Vite dev/preview server (server/football/vite.ts) and the Vercel functions
 * in api/football/. The key (API_FOOTBALL_KEY) is only ever read here, on the
 * server, and is sent upstream in the x-apisports-key header.
 *
 * The free plan allows 100 requests a day (10 a minute), so every answer is
 * cached in memory and, through s-maxage, on Vercel's CDN. When the upstream
 * call fails, the last good answer is served instead, marked `stale`.
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { ServerResponse } from 'node:http'
import { fetchStreamLink, fetchStreamListing, findMatchStream, NO_STREAM, type MatchStream } from './stream.js'

export const FOOTBALL_ORIGIN = 'https://v3.football.api-sports.io'
const UPSTREAM_TIMEOUT_MS = 10000

/** Leagues with standings tabs. Only these may be requested from /standings. */
export const FOOTBALL_LEAGUES = [
  { id: 39, name: 'Premier League' },
  { id: 140, name: 'La Liga' },
  { id: 135, name: 'Serie A' },
  { id: 78, name: 'Bundesliga' },
  { id: 61, name: 'Ligue 1' },
  { id: 2, name: 'Champions League' },
  { id: 399, name: 'NPFL' },
] as const

/** Cache lifetimes, in seconds. */
export const FOOTBALL_TTL = {
  live: 60,
  fixtures: 5 * 60,
  standings: 60 * 60,
  season: 12 * 60 * 60,
  matchLive: 60,
  matchFinished: 60 * 60,
  rateLimited: 60,
  /** The stream provider's listing (one request, shared by every match). */
  streams: 2 * 60,
  /** A match's stream link rarely changes, and each check is one provider request. */
  streamLinks: 30 * 60,
  /** A match without a stream yet is checked again sooner, as streams start near kick-off. */
  noStreamLink: 5 * 60,
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
}

/** In-memory cache. Entries are kept after they expire, as a stale fallback. */
export function createFootballCache(now: () => number = Date.now) {
  const entries = new Map<string, CacheEntry>()
  return {
    now,
    get: (key: string) => entries.get(key),
    set: (key: string, outcome: Outcome, ttl: number) =>
      entries.set(key, { outcome, expires: now() + ttl * 1000 }),
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
        : 0

/**
 * Returns the cached outcome while it is fresh, otherwise calls `load`. A
 * failed refresh falls back to the last good answer, marked stale.
 */
async function cached(
  ctx: FootballContext,
  cacheKey: string,
  load: () => Promise<Outcome>,
  successTtl: (outcome: Outcome) => number,
): Promise<{ outcome: Outcome; maxAge: number; stale: boolean }> {
  const now = ctx.cache.now()
  const entry = ctx.cache.get(cacheKey)
  if (entry && entry.expires > now) {
    return { outcome: entry.outcome, maxAge: Math.ceil((entry.expires - now) / 1000), stale: false }
  }
  const outcome = await load()
  if (!outcome.ok && entry?.outcome.ok) {
    return { outcome: entry.outcome, maxAge: 0, stale: true }
  }
  const ttl = ttlFor(outcome, successTtl(outcome))
  if (ttl > 0) ctx.cache.set(cacheKey, outcome, ttl)
  return { outcome, maxAge: ttl, stale: false }
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

async function live(ctx: FootballContext, _params: URLSearchParams, res: ServerResponse) {
  send(res, await loadLive(ctx))
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
  send(
    res,
    await cached(ctx, `fixtures:${date}`, () => callApi(ctx, 'fixtures', { date }), fixed(FOOTBALL_TTL.fixtures)),
  )
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
  send(res, await loadMatch(ctx, id))
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
 * so the list can put them first. Without RAPIDAPI_KEY, or when the stream
 * provider fails, it is simply an empty list and the page is unaffected.
 */
async function watchable(ctx: FootballContext, _params: URLSearchParams, res: ServerResponse) {
  const empty = { outcome: { ok: true, data: [] }, maxAge: FOOTBALL_TTL.streams, stale: false } as const
  const rapidKey = ctx.rapidKey
  if (!rapidKey) return send(res, empty)
  const result = await cached(
    ctx,
    'watchable',
    async () => {
      const [liveNow, listing] = await Promise.all([loadLive(ctx), loadStreamListing(ctx, rapidKey)])
      if (!liveNow.outcome.ok || !listing.outcome.ok) return { ok: true, data: [] }
      const items = listing.outcome.data as unknown[]
      const candidates = (liveNow.outcome.data as LiveFixture[]).flatMap((f) => {
        const id = f.fixture?.id
        const home = f.teams?.home?.name
        const away = f.teams?.away?.name
        if (!id || !home || !away) return []
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
    fixed(FOOTBALL_TTL.streams),
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
