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
 * Every league's matches are served. Only the requests that cost one call per
 * league or per match (the schedule, a stream link check from the watchable
 * list) are kept to the featured leagues (server/football/priority.ts); the
 * live list, one request for every live match, covers the others.
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { ServerResponse } from 'node:http'
import {
  fetchStreamLink,
  fetchStreamListing,
  findMatchStream,
  hlsPlays,
  isProviderMatchId,
  NO_STREAM,
  nearTeam,
  providerFixtures,
  sameName,
  sameTeam,
  streamingFixture,
  type MatchStream,
  type StreamSource,
  type ProviderFixture,
} from './stream.js'
import { isFeaturedLeague } from './priority.js'
import { isAdmin, WINDOW_MS } from '../live/handlers.js'
import { redis, type RedisEnv } from '../redis.js'
import {
  findStreamingMatch,
  loadStreaming,
  refreshStreamingMatch,
  STREAMING_TTL_MS,
  streamingAdmin,
  streamsForMatch,
  type StreamingDeps,
} from './streamingStore.js'
import { fetchStreamingLeague, fetchStreamingLeagues, serverLabel } from './streaming.js'

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
  /** A day's list: API-Football is only a backup for fixtures now (its free plan has 100 requests a day), and pairs our matches with its ids. */
  fixtures: 3 * 60 * 60,
  standings: 60 * 60,
  season: 12 * 60 * 60,
  matchLive: 5 * 60,
  matchFinished: 60 * 60,
  /** Out of requests: wait before asking again. */
  rateLimited: 5 * 60,
  /** Not in the plan (e.g. this season's standings on the free plan): don't ask again today. */
  plan: 24 * 60 * 60,
  /** Key rejected or account suspended: it won't fix itself in a minute. */
  rejected: 30 * 60,
  /** Any other failure, while the last good answer is served. */
  failed: 60,
  /** Which live matches have a stream (see watchable). */
  watchable: 5 * 60,
  /** The stream provider's listing (one request, shared by every match). */
  streams: 5 * 60,
  /** ...and around kick-off, so a match shows as live (and its stream) within a minute or so. */
  kickoff: 60,
  /** A match's stream link rarely changes, and each check is one provider request. */
  streamLinks: 2 * 60 * 60,
  /** A match without a stream yet is checked again later, as streams start near kick-off. */
  noStreamLink: 15 * 60,
  /** A link whose feed isn't playing: asked for again soon, in case the provider replaces it. */
  brokenStreamLink: 2 * 60,
  /** The Live Streaming API's league names (to find the featured ones' exact names). */
  scheduleLeagues: 12 * 60 * 60,
  /** Its featured leagues' live and upcoming matches (live scores come from the live list, see freshSchedule). */
  schedule: 30 * 60,
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
  /** The Football Live Streaming API's shared live list (the main stream source). */
  streaming?: StreamingDeps
  /** For the /admin/live routes: ADMIN_PASSWORD, the request's Authorization header, and Redis for viewer counts. */
  admin?: { password: string; authorization?: string; redis?: RedisEnv }
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
  if (!ctx.key) return { ok: false, reason: 'not-configured' }
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
      ? Math.max(successTtl, FOOTBALL_TTL.plan)
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
 * (see providerFixture in stream.ts), or else from the Live Streaming API's
 * schedule (loadSchedule), so matches and scores keep showing.
 */
async function withProviderFallback(
  ctx: FootballContext,
  result: Loaded,
  pick: (fixture: ProviderFixture) => boolean,
): Promise<Loaded> {
  if (result.outcome.ok || !ctx.rapidKey) return result
  const listing = await loadStreamListing(ctx, ctx.rapidKey)
  if (listing.outcome.ok) {
    const data = providerFixtures(listing.outcome.data as unknown[])
      .map((p) => p.fixture)
      .filter(pick)
    return { outcome: { ok: true, data, extra: { source: 'rapidapi' } }, maxAge: listing.maxAge, stale: listing.stale }
  }
  const schedule = await freshSchedule(ctx, ctx.rapidKey)
  if (!schedule) return result
  const data = schedule.fixtures.filter(pick)
  return { outcome: { ok: true, data, extra: { source: 'rapidapi' } }, maxAge: schedule.maxAge, stale: false }
}

/** The schedule with each match in play taken from the live list (5 minutes old at most): its score, and live as soon as it kicks off. */
async function freshSchedule(ctx: FootballContext, rapidKey: string) {
  const [schedule, live] = await Promise.all([loadSchedule(ctx, rapidKey), ctx.streaming ? loadStreaming(ctx.streaming) : null])
  if (!schedule.outcome.ok) return null
  const { fixtures: listed, streams } = schedule.outcome.data as Schedule
  const fixtures = listed.map((f) => {
    const playing = findStreamingMatch(live?.snapshot ?? null, f.teams.home.name, f.teams.away.name, Date.parse(f.fixture.date))
    if (!playing) return f
    const now = streamingFixture({ ...playing, live: true })
    return { ...now, fixture: { ...now.fixture, id: f.fixture.id }, league: f.league, teams: {
      home: { ...now.teams.home, logo: f.teams.home.logo || now.teams.home.logo },
      away: { ...now.teams.away, logo: f.teams.away.logo || now.teams.away.logo },
    } }
  })
  return { fixtures, streams, maxAge: shorterAge(schedule.maxAge, FOOTBALL_TTL.streams) }
}

/** The schedule's matches, and the stream servers it lists with each (by our match id): a second source when the live list misses one. */
interface Schedule {
  fixtures: ProviderFixture[]
  streams: Record<number, StreamSource[]>
}

/**
 * The featured leagues' live and upcoming matches from the Football Live
 * Streaming API, as fixtures: one request per league (filtered by its exact
 * name, looked up twice a day). It keeps about two days ahead and drops
 * matches once they end, so there are no results, events or line-ups.
 */
function loadSchedule(ctx: FootballContext, rapidKey: string) {
  return cached(
    ctx,
    // v4: English feeds first (v3: with the streams, and leagues under their second names, "Spain La Liga").
    'schedule:v4',
    async (): Promise<Outcome> => {
      const names = await cached(
        ctx,
        'schedule-leagues:v2',
        async () => {
          const all = await fetchStreamingLeagues(rapidKey, ctx.fetchImpl)
          return all ? { ok: true, data: all.filter((name) => isFeaturedLeague({ name })) } : { ok: false, reason: 'upstream-error' }
        },
        fixed(FOOTBALL_TTL.scheduleLeagues),
      )
      if (!names.outcome.ok) return names.outcome
      const leagues = await Promise.all((names.outcome.data as string[]).map((name) => fetchStreamingLeague(rapidKey, name, ctx.fetchImpl)))
      if (leagues.every((l) => l === null)) return { ok: false, reason: 'upstream-error' }
      const out: ProviderFixture[] = []
      const streams: Record<number, StreamSource[]> = {}
      // Some matches are listed twice, once with Vietnamese names ("thành phố Manchester"): live first, so one listed twice
      // keeps its score, then plain English names.
      const foreign = (m: { home: string; away: string }) => Number(/[^\x20-\x7E]/.test(m.home + m.away))
      const all = leagues.flatMap((l) => l ?? []).sort((a, b) => Number(b.live) - Number(a.live) || foreign(a) - foreign(b))
      for (const match of all) {
        const fixture = streamingFixture(match)
        // A team plays once at a time: one team in common around the same kick-off is the same match
        // (the copies can differ by an hour, and spell the other team differently).
        const names = (f: ProviderFixture) => [f.teams.home.name, f.teams.away.name]
        const twice = (f: ProviderFixture) =>
          Math.abs(f.fixture.timestamp - fixture.fixture.timestamp) * 1000 <= SAME_FIXTURE_MS &&
          ((sameTeam(f.teams.home.name, fixture.teams.home.name) && f.fixture.timestamp === fixture.fixture.timestamp) ||
            names(f).some((x) => names(fixture).some((y) => sameName(x, y))))
        const same = out.find(twice)
        if (!same) out.push(fixture)
        const id = (same ?? fixture).fixture.id
        const known = streams[id] ?? []
        streams[id] = [...known, ...match.streams.filter((s) => !known.some((k) => k.url === s.url))]
      }
      const data: Schedule = { fixtures: out.sort((a, b) => a.fixture.timestamp - b.fixture.timestamp), streams }
      return { ok: true, data }
    },
    fixed(FOOTBALL_TTL.schedule),
  )
}

const isProviderLive = (f: ProviderFixture) => f.fixture.status.short === 'LIVE'

/**
 * Lists come from the Live Streaming API's schedule first, saving API-Football's
 * small daily quota for match details (events, line-ups, statistics); API-Football
 * (then the older stream listing) only when the schedule fails.
 */
async function scheduleFirst(ctx: FootballContext, pick: (fixture: ProviderFixture) => boolean, fromApi: () => Promise<Loaded>): Promise<Loaded> {
  const schedule = ctx.rapidKey ? await freshSchedule(ctx, ctx.rapidKey) : null
  if (schedule) {
    return { outcome: { ok: true, data: schedule.fixtures.filter(pick), extra: { source: 'rapidapi' } }, maxAge: schedule.maxAge, stale: false }
  }
  return withProviderFallback(ctx, await fromApi(), pick)
}

const liveOrFallback = async (ctx: FootballContext) =>
  withStreamingMatches(ctx, await scheduleFirst(ctx, isProviderLive, () => loadLive(ctx)))

/** Three hours: the same teams within this of each other are the same match. */
const SAME_FIXTURE_MS = 3 * 60 * 60 * 1000

/** Whether two matches are the same one: one team in common, kicking off about the same time. */
function sameFixture(a: unknown, b: unknown) {
  const x = describeFixture(a)
  const y = describeFixture(b)
  if (!x.home || !x.away || !y.home || !y.away) return false
  if (x.kickoff && y.kickoff && Math.abs(x.kickoff - y.kickoff) > SAME_FIXTURE_MS) return false
  return nearTeam(x.home, y.home) || nearTeam(x.away, y.away) || nearTeam(x.home, y.away) || nearTeam(x.away, y.home)
}

/**
 * The live matches with streams that only the Football Live Streaming API
 * lists, as fixtures (streamingFixture): every league outside the schedule's
 * featured ones, and any match the other listings miss. It lists some twice:
 * the entry with the most streams is kept.
 */
async function streamingOnlyFixtures(ctx: FootballContext, known: unknown[]): Promise<ProviderFixture[]> {
  if (!ctx.streaming) return []
  const { snapshot } = await loadStreaming(ctx.streaming)
  const out: ProviderFixture[] = []
  const candidates = (snapshot?.matches ?? [])
    .filter((m) => m.live && m.streams.length)
    .sort((a, b) => b.streams.length - a.streams.length)
  for (const match of candidates) {
    const fixture = streamingFixture(match)
    if (known.some((f) => sameFixture(f, fixture)) || out.some((f) => sameFixture(f, fixture))) continue
    out.push(fixture)
  }
  return out
}

async function withStreamingMatches(ctx: FootballContext, result: Loaded, pick: (fixture: ProviderFixture) => boolean = () => true): Promise<Loaded> {
  if (!result.outcome.ok || !Array.isArray(result.outcome.data)) return result
  const extra = (await streamingOnlyFixtures(ctx, result.outcome.data)).filter(pick)
  if (!extra.length) return result
  return { ...result, outcome: { ...result.outcome, data: [...result.outcome.data, ...extra] } }
}

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
  const fromApi = () => loadDay(ctx, date)
  const onDate = (f: ProviderFixture) => f.fixture.date.slice(0, 10) === date
  // The schedule covers the featured leagues; the live list adds every other league's matches in play.
  send(res, await withStreamingMatches(ctx, await scheduleFirst(ctx, onDate, fromApi), onDate))
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
    if (!found) return fail(res, 'not-found')
    return send(res, (await withApiDetails(ctx, found.fixture)) ?? found.result)
  }
  send(res, await loadMatch(ctx, id))
}

/** API-Football's fixtures on one day (UTC), through the cache. */
const loadDay = (ctx: FootballContext, date: string) =>
  cached(ctx, `fixtures:${date}`, () => callApi(ctx, 'fixtures', { date }), fixed(FOOTBALL_TTL.fixtures))

/**
 * One of the schedule's matches with API-Football's events, line-ups and
 * statistics: found in its list for that day (one request every few hours)
 * by teams and kick-off, then loaded like any match. Keeps our id. Null when
 * API-Football doesn't have it or fails, and the plain fixture is shown.
 */
async function withApiDetails(ctx: FootballContext, fixture: ProviderFixture): Promise<Loaded | null> {
  if (!ctx.key) return null
  const day = (await loadDay(ctx, fixture.fixture.date.slice(0, 10))).outcome
  if (!day.ok || !Array.isArray(day.data)) return null
  const home = fixture.teams.home.name
  const away = fixture.teams.away.name
  const kickoff = Date.parse(fixture.fixture.date)
  const near = (day.data as FixtureLike[]).filter((f) => {
    const d = describeFixture(f)
    return !d.kickoff || Math.abs(d.kickoff - kickoff) <= SAME_FIXTURE_MS
  })
  const both = (x?: string, y?: string) => Boolean(x && y) && ((sameTeam(x!, home) && nearTeam(y!, away)) || (nearTeam(x!, home) && sameTeam(y!, away)))
  const loose = near.filter((f) => sameFixture(f, fixture))
  const found = near.find((f) => both(f.teams?.home?.name, f.teams?.away?.name)) ?? (loose.length === 1 ? loose[0] : undefined)
  const apiId = (found as { fixture?: { id?: number } } | undefined)?.fixture?.id
  if (!apiId) return null
  const detailed = await loadMatch(ctx, String(apiId))
  if (!detailed.outcome.ok) return null
  const data = detailed.outcome.data as { fixture: Record<string, unknown> }
  return { ...detailed, outcome: { ok: true, data: { ...data, fixture: { ...data.fixture, id: fixture.fixture.id } } } }
}

/** A match that came from the stream provider's listing (id from providerMatchId). */
async function findProviderMatch(ctx: FootballContext, id: number) {
  if (!ctx.rapidKey) return null
  const listing = await loadStreamListing(ctx, ctx.rapidKey)
  const items = listing.outcome.ok ? (listing.outcome.data as unknown[]) : []
  let found: { fixture: ProviderFixture; providerId?: string } | undefined = providerFixtures(items).find(
    (p) => p.fixture.fixture.id === id,
  )
  // Or a match only the streaming list has.
  found ??= ctx.streaming
    ? await loadStreaming(ctx.streaming).then(({ snapshot }) => {
        const match = snapshot?.matches.find((m) => streamingFixture(m).fixture.id === id)
        return match ? { fixture: streamingFixture(match) } : undefined
      })
    : undefined
  // Or one from the schedule (upcoming, or live before the live list has it).
  found ??= await freshSchedule(ctx, ctx.rapidKey).then((schedule) => {
    const fixture = schedule?.fixtures.find((f) => f.fixture.id === id)
    return fixture ? { fixture } : undefined
  })
  if (!found) return null
  const result: Loaded = { outcome: { ok: true, data: found.fixture }, maxAge: FOOTBALL_TTL.streams, stale: false }
  return { ...found, items, result }
}

interface FixtureLike {
  fixture?: { date?: string; status?: { short?: string } }
  teams?: { home?: { name?: string }; away?: { name?: string } }
}

const NOT_LIVE = new Set(['TBD', 'NS', 'FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO'])

/** Teams, kick-off and whether it's in play, for pairing with the streaming list. */
function describeFixture(data: unknown) {
  const f = data as FixtureLike
  const kickoff = Date.parse(f.fixture?.date ?? '')
  const status = f.fixture?.status?.short
  return {
    home: f.teams?.home?.name,
    away: f.teams?.away?.name,
    kickoff: Number.isNaN(kickoff) ? 0 : kickoff,
    live: Boolean(status && !NOT_LIVE.has(status)),
  }
}

/**
 * GET /api/football/stream?id=123: stream links and live commentary for one
 * of our matches. The streams come from the Football Live Streaming API
 * (streamingStore.ts) when it lists the match, else from the older Football
 * Live Stream API. The match is looked up here (it is usually cached already)
 * and paired with each listing by team names. No pairing is not an error: it
 * answers { available: false }, so the match page shows "Stream not available yet".
 */
async function stream(ctx: FootballContext, params: URLSearchParams, res: ServerResponse) {
  const id = params.get('id') ?? ''
  if (!MATCH_ID.test(id)) return fail(res, 'bad-request')
  if (!ctx.rapidKey) return fail(res, 'not-configured')

  let fixture: unknown
  let paired: MatchStream = NO_STREAM
  let providerId: string | undefined
  let maxAge: number = FOOTBALL_TTL.streams
  let listingFailed: Loaded | null = null

  if (isProviderMatchId(Number(id))) {
    const provider = await findProviderMatch(ctx, Number(id))
    if (!provider) return fail(res, 'not-found')
    fixture = provider.fixture
    const { home, away } = provider.fixture.teams
    paired = withoutProviderId(findMatchStream(provider.items, home.name, away.name))
    providerId = provider.providerId
  } else {
    const found = (await loadMatch(ctx, id)).outcome
    if (!found.ok) return fail(res, found.reason)
    fixture = found.data
    const { home, away } = describeFixture(fixture)
    if (!home || !away) {
      return send(res, { outcome: { ok: true, data: NO_STREAM }, maxAge: FOOTBALL_TTL.streams, stale: false })
    }
    const listing = await loadStreamListing(ctx, ctx.rapidKey)
    if (listing.outcome.ok) {
      const found = findMatchStream(listing.outcome.data as unknown[], home, away)
      paired = withoutProviderId(found)
      providerId = found.providerId
      maxAge = listing.maxAge
    } else {
      listingFailed = listing
    }
  }

  const result: MatchStream = { ...paired }
  const described = describeFixture(fixture)
  const streaming =
    ctx.streaming && described.home && described.away
      ? (await streamsForMatch(ctx.streaming, described.home, described.away, described.kickoff, described.live)).match
      : null
  // The schedule's servers for the match, when the live list has none (one of its reads may have skipped it).
  const scheduled =
    !streaming?.streams.length && described.live && isProviderMatchId(Number(id)) && ctx.rapidKey
      ? ((await freshSchedule(ctx, ctx.rapidKey))?.streams[Number(id)] ?? [])
      : []
  if (streaming?.streams.length) {
    result.streams = streaming.streams
    result.status ??= { status: 'Live', score: streaming.score, minute: null }
    // Within a minute of a new list.
    maxAge = shorterAge(maxAge, 60)
  } else if (scheduled.length) {
    result.streams = scheduled.slice(0, 8).map((s, i) => ({ ...s, label: serverLabel(s.url, i) }))
    maxAge = shorterAge(maxAge, 60)
  } else if (listingFailed) {
    return send(res, listingFailed)
  } else if (providerId && !result.streams.length) {
    const link = await loadStreamLink(ctx, ctx.rapidKey, providerId)
    result.streams = link.streams
    maxAge = shorterAge(maxAge, link.maxAge)
  }
  result.available = result.streams.length > 0 || result.commentary.length > 0
  // No stream yet: ask again within a minute (the CDN would otherwise keep "not available" for up to twice the age).
  if (!result.streams.length) maxAge = shorterAge(maxAge, 60)
  send(res, { outcome: { ok: true, data: result }, maxAge, stale: false })
}

/** The provider's own id isn't sent to the browser. */
function withoutProviderId(stream: MatchStream): MatchStream {
  const { providerId: _providerId, ...rest } = stream
  return rest
}

/** The shorter of two cache ages, where 0 means "don't cache". */
const shorterAge = (a: number, b: number) => (a > 0 && b > 0 ? Math.min(a, b) : 0)

/** Around a featured match's kick-off: from 2 minutes before until it shows as started (at most 20 minutes after). */
const KICKOFF_BEFORE_MS = 2 * 60 * 1000
const KICKOFF_AFTER_MS = 20 * 60 * 1000

/** Whether a featured match in the listing is about to kick off, or has but isn't listed as started yet. */
export function kickoffDue(items: unknown[], now: number): boolean {
  return providerFixtures(items).some(({ fixture: { fixture } }) => {
    const kickoff = Date.parse(fixture.date)
    return fixture.status.short === 'NS' && kickoff - KICKOFF_BEFORE_MS <= now && now <= kickoff + KICKOFF_AFTER_MS
  })
}

/**
 * The Football Live Stream API's match listing, shared by every match. Kept
 * for 5 minutes, but only 1 around kick-offs, so a match moves to "Live now"
 * soon after it starts.
 */
function loadStreamListing(ctx: FootballContext, rapidKey: string) {
  return cached(
    ctx,
    'streams',
    async () => {
      const result = await fetchStreamListing(rapidKey, ctx.fetchImpl)
      return result.ok ? { ok: true, data: result.items } : { ok: false, reason: result.reason }
    },
    (outcome) =>
      outcome.ok && kickoffDue(outcome.data as unknown[], ctx.cache.now()) ? FOOTBALL_TTL.kickoff : FOOTBALL_TTL.streams,
  )
}

/**
 * One provider match's stream sources ([] when it has none), and how long
 * they're kept. A link is kept for 2 hours only if its feed plays; a dead one
 * (the provider sometimes hands out a feed that refuses everyone) is asked for
 * again after 2 minutes, so a replacement shows up during the match.
 */
async function loadStreamLink(ctx: FootballContext, rapidKey: string, providerId: string) {
  let broken = false
  const link = await cached(
    ctx,
    // v2: links saved before feeds were checked are checked afresh.
    `stream-link:v2:${providerId}`,
    async () => {
      const streams = await fetchStreamLink(rapidKey, providerId, ctx.fetchImpl)
      // Only HLS feeds can be checked; an embedded player is taken as given.
      if (streams.length && streams.every((s) => s.kind === 'hls')) {
        const plays = await Promise.all(streams.map((s) => hlsPlays(s.url, ctx.fetchImpl)))
        broken = !plays.some(Boolean)
      }
      return { ok: true, data: streams }
    },
    (outcome) =>
      !outcome.ok || !(outcome.data as unknown[]).length
        ? FOOTBALL_TTL.noStreamLink
        : broken
          ? FOOTBALL_TTL.brokenStreamLink
          : FOOTBALL_TTL.streamLinks,
  )
  return { streams: link.outcome.ok ? (link.outcome.data as MatchStream['streams']) : [], maxAge: link.maxAge }
}

interface LiveFixture extends FixtureLike {
  fixture?: { id?: number; date?: string; status?: { short?: string } }
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
  let listingAge: number = FOOTBALL_TTL.watchable
  const result = await cached(
    ctx,
    'watchable',
    async () => {
      const [liveNow, listing, streaming] = await Promise.all([
        liveOrFallback(ctx),
        loadStreamListing(ctx, rapidKey),
        ctx.streaming ? loadStreaming(ctx.streaming) : null,
      ])
      listingAge = listing.maxAge > 0 ? listing.maxAge : FOOTBALL_TTL.watchable
      if (!liveNow.outcome.ok) return { ok: true, data: [] }
      const items = listing.outcome.ok ? (listing.outcome.data as unknown[]) : []
      // Matches from the provider itself already carry its id.
      const providerIds = new Map(providerFixtures(items).map((p) => [p.fixture.fixture.id, p.providerId]))
      const viaStreaming: number[] = []
      const candidates = (liveNow.outcome.data as LiveFixture[]).flatMap((f) => {
        const id = f.fixture?.id
        const { home, away, kickoff } = describeFixture(f)
        if (!id || !home || !away) return []
        // The streaming list already has the links: no request needed.
        if (findStreamingMatch(streaming?.snapshot ?? null, home, away, kickoff)?.streams.length) {
          viaStreaming.push(id)
          return []
        }
        // A link check is a request per match: only for the featured leagues (the others are many).
        if (!isFeaturedLeague((f as { league?: { id?: number; name?: string } }).league)) return []
        const own = providerIds.get(id)
        if (own) return [{ id, providerId: own, streams: [] }]
        const { providerId, streams } = findMatchStream(items, home, away)
        return providerId ? [{ id, providerId, streams }] : []
      })
      const checked = await Promise.all(
        candidates.map(async (c) =>
          c.streams.length || (await loadStreamLink(ctx, rapidKey, c.providerId)).streams.length ? c.id : null,
        ),
      )
      return { ok: true, data: [...viaStreaming, ...checked.filter((id) => id !== null)] }
    },
    // Follows the listing: every minute around kick-offs.
    () => Math.min(FOOTBALL_TTL.watchable, listingAge),
  )
  send(res, result)
}

const sendPrivate = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Admin routes need ADMIN_PASSWORD as a Bearer token. Answers the request itself when they don't have it. */
function adminAllowed(ctx: FootballContext, res: ServerResponse) {
  const admin = ctx.admin
  if (!admin?.password) return sendPrivate(res, 503, { error: 'not-configured' }), false
  const env = { adminPassword: admin.password, redisUrl: '', redisToken: '' }
  if (!isAdmin(env, admin.authorization)) return sendPrivate(res, 401, { error: 'unauthorized' }), false
  if (!ctx.streaming) return sendPrivate(res, 503, { error: 'no-streaming' }), false
  return true
}

/**
 * GET /api/football/admin-streams (admin): the Live Streaming API's usage,
 * the cached live list with our match ids and viewers, and the last calls.
 */
async function adminStreams(ctx: FootballContext, _params: URLSearchParams, res: ServerResponse) {
  if (!adminAllowed(ctx, res) || !ctx.streaming) return
  const now = ctx.streaming.now()
  const [info, listing] = await Promise.all([
    streamingAdmin(ctx.streaming),
    ctx.rapidKey ? loadStreamListing(ctx, ctx.rapidKey) : null,
  ])
  const ours = listing?.outcome.ok ? providerFixtures(listing.outcome.data as unknown[]) : []
  const rows = (info.snapshot?.matches ?? []).map((m) => {
    const our = ours.find(({ fixture }) =>
      findStreamingMatch({ fetchedAt: 0, matches: [m] }, fixture.teams.home.name, fixture.teams.away.name, Date.parse(fixture.fixture.date)),
    )
    // Every live match with streams is on the site: under its listing's id, or as the streaming list's own fixture.
    const matchId = our?.fixture.fixture.id ?? (m.live && m.streams.length ? streamingFixture(m).fixture.id : null)
    return { key: m.key, matchId, home: m.home, away: m.away, league: m.league, score: m.score, servers: m.streams.length }
  })
  // Viewers of the matches shown on the site (the live counter's per-match sets).
  const ids = rows.flatMap((r) => (r.matchId ? [r.matchId] : []))
  const counts = ids.length && ctx.admin?.redis
    ? await redis(ctx.admin.redis, ids.map((id) => ['ZCOUNT', `live:m:${id}`, now - WINDOW_MS, '+inf']), ctx.fetchImpl)
    : null
  const streams = rows
    .map((r) => ({ ...r, viewers: r.matchId && counts ? Number(counts[ids.indexOf(r.matchId)]) || 0 : null }))
    .sort((a, b) => Number(b.matchId !== null) - Number(a.matchId !== null) || b.servers - a.servers)
  const fetchedAt = info.snapshot?.fetchedAt ?? null
  sendPrivate(res, 200, {
    usage: info.quota && { limit: info.quota.limit, used: info.quota.limit - info.quota.remaining, at: info.quota.at },
    stopped: info.stopped,
    fetchedAt,
    expiresAt: fetchedAt && fetchedAt + STREAMING_TTL_MS,
    streams,
    calls: info.calls,
  })
}

const STREAM_KEY = /^[^\n]{1,300}$/

/** POST /api/football/admin-refresh?match=<key> (admin): asks the API again now, at most once per match every 10 minutes. */
async function adminRefresh(ctx: FootballContext, params: URLSearchParams, res: ServerResponse) {
  if (!adminAllowed(ctx, res) || !ctx.streaming) return
  const match = params.get('match') ?? ''
  if (!STREAM_KEY.test(match)) return sendPrivate(res, 400, { error: 'bad-request' })
  const result = await refreshStreamingMatch(ctx.streaming, match)
  if (!result.ok) return sendPrivate(res, 429, { error: 'too-soon', retryInMs: result.retryInMs })
  sendPrivate(res, 200, { ok: true, limited: result.load.limited, fetchedAt: result.load.snapshot?.fetchedAt ?? null })
}

const ROUTES = { live, fixtures, standings, match, stream, watchable, 'admin-streams': adminStreams, 'admin-refresh': adminRefresh }

/** Routes that change something, and so take POST. */
const POST_ROUTES = new Set(['admin-refresh'])

export type FootballRoute = keyof typeof ROUTES

/** Serves /api/football/{live,fixtures,standings,match,stream,watchable} and the admin-streams/admin-refresh routes. */
export async function handleFootball(
  ctx: FootballContext,
  method: string | undefined,
  route: string,
  params: URLSearchParams,
  res: ServerResponse,
) {
  const allowed = POST_ROUTES.has(route) ? ['POST'] : ['GET', 'HEAD']
  if (method && !allowed.includes(method)) {
    res.statusCode = 405
    res.setHeader('Allow', allowed.join(', '))
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ error: 'bad-request' }))
  }
  const handler = Object.hasOwn(ROUTES, route) ? ROUTES[route as FootballRoute] : undefined
  if (!handler) return fail(res, 'not-found')
  if (!ctx.key && !ctx.rapidKey) return fail(res, 'not-configured')
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
