/**
 * The admin-only stream test (/admin/streams-test): every "direct" stream the
 * Football Live Streaming API (RapidAPI) lists for today's live and upcoming
 * matches, played in the browser to tag each one's commentary language.
 * Nothing here reaches the public site.
 *
 * - Only `type: "direct"` servers: "referer" and "drm" ones are dropped (no
 *   proxying, no header spoofing, no DRM).
 * - Each query's answer is cached in Upstash for 180 s (and kept a day as a
 *   fallback), and every request to the API is counted per day. At the daily
 *   cap (STREAMS_TEST_DAILY_CAP, default 50: the free plan) the API isn't
 *   asked again until tomorrow; the last answer is served instead.
 * - Tags (English, Arabic…) are kept per match and stream name.
 *
 * Without Redis (local dev, tests) all of it lives in this process's memory.
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import { hasRedis, redis, type RedisEnv } from '../redis.js'
import { STREAMING_ORIGIN } from './streaming.js'

const HOST = new URL(STREAMING_ORIGIN).host
const TIMEOUT_MS = 10_000
export const CACHE_S = 180
/** The last answer, kept for when the cap is reached or the API fails. */
const STALE_S = 24 * 60 * 60
/** Pages read per query (20 matches each): enough for a day, without burning the plan. */
export const MAX_PAGES = 3
export const DEFAULT_DAILY_CAP = 50

export const TAGS = ['english', 'arabic', 'french', 'other', 'none', 'broken'] as const
export type StreamTag = (typeof TAGS)[number]

export type StreamFormat = 'hls' | 'flv' | 'mp4' | 'other'

export interface TestServer {
  name: string
  url: string
  format: StreamFormat
  /** The name or URL path suggests English commentary ("EN", "Sky", "beIN EN"…). Only a hint. */
  englishHint: boolean
}

/** Words in a name or URL path that suggest English commentary. */
export const ENGLISH_HINT = /(^|[^a-z])(en|eng|english|sky|bt|tnt|bein[ _-]?en|espn|supersport)([^a-z]|$)/i

export interface TestMatch {
  /** league|home|away|kick-off seconds: stable for the day, used for tags. */
  key: string
  home: string
  away: string
  homeLogo: string | null
  awayLogo: string | null
  score: string | null
  /** The API's status: "live", "vs" (not started)… */
  status: string
  league: string
  leagueLogo: string | null
  /** Kick-off, epoch ms (0 when unknown). */
  time: number
  servers: TestServer[]
}

export interface TestQuery {
  status: 'live' | 'vs'
  /** DDMMYYYY */
  date: string
  league: string
}

export interface TestListing {
  matches: TestMatch[]
  /** When the API answered (ms). */
  fetchedAt: number | null
  /** Served from the cache. */
  cached: boolean
  /** The cap is reached, or the API failed: the last answer, possibly old (or nothing). */
  stale: boolean
  /** More pages than MAX_PAGES: not every match is here. */
  truncated: boolean
  error: string | null
}

export interface TagRecord {
  match: string
  name: string
  tag: StreamTag
  url: string
  host: string
  title: string
  at: number
}

export interface TestDeps {
  key: string
  redis: RedisEnv
  now: () => number
  cap: number
  fetchImpl?: typeof fetch
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const image = (value: unknown) => {
  const url = str(value)
  return url && url.startsWith('https://') && !/nologo/i.test(url) ? url : null
}

export const formatOf = (url: string): StreamFormat => {
  const path = new URL(url).pathname.toLowerCase()
  return path.endsWith('.m3u8') ? 'hls' : path.endsWith('.flv') ? 'flv' : path.endsWith('.mp4') ? 'mp4' : 'other'
}

/** The direct servers only, https, each URL once. */
export function directServers(servers: unknown): TestServer[] {
  if (!Array.isArray(servers)) return []
  const out: TestServer[] = []
  servers.forEach((server, index) => {
    if (!isObject(server) || server.type !== 'direct') return
    const raw = str(server.url)
    if (!raw) return
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return
    }
    if (url.protocol !== 'https:' || out.some((s) => s.url === url.href)) return
    const name = str(server.name) ?? `Server ${index + 1}`
    out.push({ name, url: url.href, format: formatOf(url.href), englishHint: ENGLISH_HINT.test(name) || ENGLISH_HINT.test(url.pathname) })
  })
  return out
}

export function parseTestMatch(item: unknown): TestMatch | null {
  if (!isObject(item)) return null
  const home = str(item.home_team_name)
  const away = str(item.away_team_name)
  if (!home || !away) return null
  const league = str(item.league_name) ?? ''
  const seconds = Number(item.match_time)
  const time = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
  const homeScore = str(String(item.homeTeamScore ?? ''))
  const awayScore = str(String(item.awayTeamScore ?? ''))
  return {
    key: `${league}|${home}|${away}|${time / 1000}`,
    home,
    away,
    homeLogo: image(item.home_team_logo),
    awayLogo: image(item.away_team_logo),
    score: homeScore !== null && awayScore !== null ? `${homeScore} - ${awayScore}` : null,
    status: str(item.match_status) ?? '',
    league,
    leagueLogo: image(item.league_logo),
    time,
    servers: directServers(item.servers),
  }
}

/** Today in Lagos as DDMMYYYY. */
export function lagosDate(now: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date(now))
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('day')}${part('month')}${part('year')}`
}

/** The query from ?status=&date=&league=, or null when it's malformed. */
export function readTestQuery(params: URLSearchParams, now: number): TestQuery | null {
  const status = params.get('status') ?? 'live'
  const date = params.get('date') || lagosDate(now)
  const league = (params.get('league') ?? '').trim()
  if (status !== 'live' && status !== 'vs') return null
  if (!/^\d{8}$/.test(date) || league.length > 100) return null
  return { status, date, league }
}

// --- Storage: Redis, or memory without it ---------------------------------

const memory = new Map<string, { value: string; expires: number }>()
const memoryTags = new Map<string, string>()

/** For tests. */
export function resetStreamsTestMemory() {
  memory.clear()
  memoryTags.clear()
}

const CACHE_PREFIX = 'st:cache:'
const STALE_PREFIX = 'st:stale:'
const COUNT_PREFIX = 'st:req:'
const TAGS_KEY = 'st:tags'

const countKey = (now: number) => `${COUNT_PREFIX}${lagosDate(now)}`
const queryKey = (q: TestQuery) => `${q.status}:${q.date}:${q.league.toLowerCase()}`

async function getValue(deps: TestDeps, key: string): Promise<string | null> {
  if (!hasRedis(deps.redis)) {
    const hit = memory.get(key)
    return hit && hit.expires > deps.now() ? hit.value : null
  }
  const result = await redis(deps.redis, [['GET', key]], deps.fetchImpl)
  return typeof result?.[0] === 'string' ? result[0] : null
}

async function setValue(deps: TestDeps, key: string, value: string, ttlS: number) {
  if (!hasRedis(deps.redis)) return void memory.set(key, { value, expires: deps.now() + ttlS * 1000 })
  await redis(deps.redis, [['SET', key, value, 'EX', ttlS]], deps.fetchImpl)
}

/** Requests made to the API today (Lagos day). */
export async function requestsToday(deps: TestDeps): Promise<number> {
  return Number(await getValue(deps, countKey(deps.now()))) || 0
}

async function countRequest(deps: TestDeps) {
  const key = countKey(deps.now())
  if (!hasRedis(deps.redis)) {
    const n = (Number(memory.get(key)?.value) || 0) + 1
    return void memory.set(key, { value: String(n), expires: deps.now() + 3 * 86_400_000 })
  }
  await redis(deps.redis, [['INCR', key], ['EXPIRE', key, 3 * 86_400]], deps.fetchImpl)
}

// --- The API ---------------------------------------------------------------

type Fetched = { ok: true; matches: TestMatch[]; truncated: boolean } | { ok: false; error: string; matches: TestMatch[] }

async function fetchPages(deps: TestDeps, q: TestQuery): Promise<Fetched> {
  const matches: TestMatch[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // Each page is a request: none past the cap, even mid-query.
    if ((await requestsToday(deps)) >= deps.cap) return { ok: false, error: 'daily-cap', matches }
    const search = new URLSearchParams({ status: q.status, date: q.date, type: 'direct' })
    if (q.league) search.set('league', q.league)
    if (page > 1) search.set('page', String(page))
    await countRequest(deps)
    let response: Response
    try {
      response = await (deps.fetchImpl ?? fetch)(`${STREAMING_ORIGIN}/matches?${search}`, {
        headers: { 'X-RapidAPI-Key': deps.key, 'X-RapidAPI-Host': HOST, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return { ok: false, error: 'unreachable', matches }
    }
    if (response.status === 429) return { ok: false, error: 'rate-limited', matches }
    if (response.status === 401 || response.status === 403) return { ok: false, error: 'auth', matches }
    let body: unknown = null
    try {
      body = response.ok ? await response.json() : null
    } catch {
      body = null
    }
    if (!isObject(body) || !Array.isArray(body.matches)) return { ok: false, error: 'upstream-error', matches }
    for (const item of body.matches) {
      const match = parseTestMatch(item)
      if (match && !matches.some((m) => m.key === match.key)) matches.push(match)
    }
    const pagination = isObject(body.pagination) ? body.pagination : {}
    if (pagination.hasNext !== true) return { ok: true, matches, truncated: false }
  }
  return { ok: true, matches, truncated: true }
}

interface Cached {
  matches: TestMatch[]
  fetchedAt: number
  truncated: boolean
}

/** One query's matches: from the 180-second cache, else the API (within the cap), else the last answer. */
export async function loadTestListing(deps: TestDeps, q: TestQuery): Promise<TestListing> {
  const id = queryKey(q)
  const parse = (raw: string | null) => {
    try {
      return raw ? (JSON.parse(raw) as Cached) : null
    } catch {
      return null
    }
  }
  const fresh = parse(await getValue(deps, CACHE_PREFIX + id))
  if (fresh) return { ...fresh, cached: true, stale: false, error: null }
  const fallback = async (error: string): Promise<TestListing> => {
    const old = parse(await getValue(deps, STALE_PREFIX + id))
    return { matches: old?.matches ?? [], fetchedAt: old?.fetchedAt ?? null, truncated: old?.truncated ?? false, cached: true, stale: true, error }
  }
  if (!deps.key) return fallback('not-configured')
  if ((await requestsToday(deps)) >= deps.cap) return fallback('daily-cap')
  const result = await fetchPages(deps, q)
  if (!result.ok) return fallback(result.error)
  const value: Cached = { matches: result.matches, fetchedAt: deps.now(), truncated: result.truncated }
  const json = JSON.stringify(value)
  await setValue(deps, CACHE_PREFIX + id, json, CACHE_S)
  await setValue(deps, STALE_PREFIX + id, json, STALE_S)
  return { ...value, cached: false, stale: false, error: null }
}

// --- Tags ------------------------------------------------------------------

/** Field of a tag in the hash: match key and stream name. */
export const tagField = (match: string, name: string) => `${match}␟${name}`

export async function readTags(deps: TestDeps): Promise<TagRecord[]> {
  let values: string[]
  if (!hasRedis(deps.redis)) values = [...memoryTags.values()]
  else {
    const result = (await redis(deps.redis, [['HVALS', TAGS_KEY]], deps.fetchImpl))?.[0]
    values = Array.isArray(result) ? result.filter((v): v is string => typeof v === 'string') : []
  }
  return values.flatMap((raw) => {
    try {
      const record = JSON.parse(raw) as TagRecord
      return record && TAGS.includes(record.tag) ? [record] : []
    } catch {
      return []
    }
  })
}

/** Saves (or with tag null, clears) a stream's tag. */
export async function saveTag(
  deps: TestDeps,
  input: { match: string; name: string; tag: StreamTag | null; url: string; title: string },
): Promise<void> {
  const field = tagField(input.match, input.name)
  if (input.tag === null) {
    if (!hasRedis(deps.redis)) return void memoryTags.delete(field)
    return void (await redis(deps.redis, [['HDEL', TAGS_KEY, field]], deps.fetchImpl))
  }
  let host = ''
  try {
    host = new URL(input.url).host
  } catch {
    // Kept without a host.
  }
  const record: TagRecord = { match: input.match, name: input.name, tag: input.tag, url: input.url, host, title: input.title, at: deps.now() }
  if (!hasRedis(deps.redis)) return void memoryTags.set(field, JSON.stringify(record))
  await redis(deps.redis, [['HSET', TAGS_KEY, field, JSON.stringify(record)]], deps.fetchImpl)
}

/** A tag body from the page, or null when it's malformed. */
export function readTagInput(body: unknown) {
  if (!isObject(body)) return null
  const match = str(body.match)
  const name = str(body.name)
  const url = str(body.url) ?? ''
  const title = str(body.title) ?? ''
  const tag = body.tag === null ? null : TAGS.find((t) => t === body.tag)
  if (!match || !name || tag === undefined || match.length > 300 || name.length > 100 || url.length > 2000 || title.length > 200) return null
  return { match, name, tag, url, title }
}

export interface GroupSummary {
  /** The server name ("Server 3") or the stream host. */
  value: string
  tagged: number
  english: number
  /** At least 3 tags (2 for hosts…) and 80% of them English. */
  consistent: boolean
}

/** Which server names and stream hosts keep turning out English, across every tag saved. */
export function summarizeTags(tags: TagRecord[]) {
  const group = (by: (t: TagRecord) => string): GroupSummary[] => {
    const map = new Map<string, { tagged: number; english: number }>()
    for (const t of tags) {
      if (t.tag === 'broken') continue
      const key = by(t)
      if (!key) continue
      const entry = map.get(key) ?? { tagged: 0, english: 0 }
      entry.tagged += 1
      if (t.tag === 'english') entry.english += 1
      map.set(key, entry)
    }
    return [...map.entries()]
      .map(([value, e]) => ({ value, ...e, consistent: e.tagged >= 3 && e.english / e.tagged >= 0.8 }))
      .sort((a, b) => b.english - a.english || b.tagged - a.tagged || a.value.localeCompare(b.value))
  }
  return { byName: group((t) => t.name), byHost: group((t) => t.host) }
}
