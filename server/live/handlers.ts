/**
 * Live viewer counter, shared by the Vercel function api/live/[action].ts.
 *
 * Vercel Analytics only sees page views, so someone watching a film for two
 * hours looks gone after a few minutes. Instead, the site sends a small
 * heartbeat once a minute while its tab is visible (src/live/heartbeat.ts):
 * an anonymous random id, whether it's watching or browsing, and what (e.g.
 * "movie:550", "match:123"). Heartbeats go into Upstash Redis (free tier,
 * Vercel Marketplace) and anyone silent for WINDOW_MS no longer counts.
 *
 * Redis (server/redis.ts):
 * - live:now      sorted set of "state|item|sid", scored by the last heartbeat (ms).
 * - live:m:<id>   sorted set of the sids watching football match <id>, for
 *                 "X watching now" on its page; expires when nobody is.
 * - ads:<day>     hash of today's direct-link ads (Lagos date): opened by
 *                 trigger (card, play, football, search, list, episode,
 *                 server), held back by the cooldown or the daily cap, and
 *                 "Too many ads?" banners shown (src/ads/adManager.ts); and the
 *                 Monetag Multitags loaded, or blocked, by zone
 *                 (src/ads/monetag.ts). Kept 8 days.
 * - ads:test:306795  when the second Multitag (zone 306795) first loaded
 *                 anywhere (ms): the "ad test started" marker on /admin/live.
 * - players:<day> hash of today's player stats (Lagos date), "<server>:<event>":
 *                 loads, no playable start within 10 s (most likely the
 *                 viewer's daily limit), automatic switches away, the "daily
 *                 limit" message shown (src/live/playerStats.ts), and calls on
 *                 our NextStream key (/api/play). Kept 8 days.
 * - codespecter:key  hash of when NextStream last took ("ok") and refused
 *                 ("rejected") our API key, in ms.
 * A heartbeat is one Redis command (three or four on a football match page).
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { redis, readRedisEnv, type Command, type RedisEnv } from '../redis.js'

/** Anyone without a heartbeat for this long has left. */
export const WINDOW_MS = 2 * 60 * 1000
/** How long a match's watcher set outlives its last watcher. */
const MATCH_KEY_TTL_S = 5 * 60
/** Old heartbeats are cleared on about one heartbeat in this many (and on every count). */
const CLEANUP_EVERY = 20
const TOP_COUNT = 5

const NOW_KEY = 'live:now'
const matchKey = (id: string) => `live:m:${id}`

const adsKey = (day: string) => `ads:${day}`
const ADS_KEY_TTL_S = 8 * 24 * 60 * 60
export const AD_EVENTS = [
  'card', 'play', 'football', 'search', 'list', 'episode', 'server', 'cooldown', 'cap', 'upsell',
  'multitag-302667', 'multitag-302667-blocked', 'multitag-306795', 'multitag-306795-blocked',
] as const
/** Set the first time the second Multitag loads. */
const AD_TEST_KEY = 'ads:test:306795'
export type AdEvent = (typeof AD_EVENTS)[number]
export type AdCounts = Record<AdEvent, number>

const playersKey = (day: string) => `players:${day}`
const KEY_STATUS = 'codespecter:key'
export const PLAYER_SERVERS = ['nextstream', 'embedmaster'] as const
export const PLAYER_EVENTS = ['load', 'nostart', 'fallback', 'limited'] as const
export type PlayerServer = (typeof PLAYER_SERVERS)[number]
export type PlayerEvent = (typeof PLAYER_EVENTS)[number]
/** Per server: today's counts of each player event, and (NextStream) the calls on our key. */
export type PlayerCounts = Record<PlayerServer, Record<PlayerEvent, number>> & { calls: number }
/** CodeSpecter keys are valid for 30 days from the day they're issued. */
export const KEY_VALID_DAYS = 30

/** The date in Lagos (UTC+1 all year), as the site's daily ad cap counts it. */
export const lagosDay = (now: number) => new Date(now + 60 * 60_000).toISOString().slice(0, 10)

const SID = /^[A-Za-z0-9_-]{16,64}$/
const ITEM = /^(movie|tv|match):[1-9]\d{0,11}$/

export type LiveState = 'watch' | 'browse'

export interface LiveEnv extends RedisEnv {
  adminPassword: string
  /** NEXTSTREAM_KEY_ISSUED (YYYY-MM-DD): the day our CodeSpecter key was issued, for its expiry warning. */
  keyIssued?: string
}

export function readLiveEnv(env: Record<string, string | undefined>): LiveEnv {
  return { ...readRedisEnv(env), adminPassword: env.ADMIN_PASSWORD ?? '', keyIssued: env.NEXTSTREAM_KEY_ISSUED?.trim() ?? '' }
}

export interface Heartbeat {
  sid: string
  state: LiveState
  item: string | null
}

/** A valid heartbeat, or null. Watching needs an item; browsing may name the page's (e.g. a match). */
export function parseHeartbeat(body: unknown): Heartbeat | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return null
  const { sid, state, item } = b
  if (typeof sid !== 'string' || !SID.test(sid)) return null
  if (state !== 'watch' && state !== 'browse') return null
  if (item !== undefined && item !== null && (typeof item !== 'string' || !ITEM.test(item))) return null
  if (state === 'watch' && !item) return null
  return { sid, state, item: (item as string | null | undefined) ?? null }
}

/** Records a heartbeat. For a football match, also answers how many are watching it. */
export async function recordHeartbeat(
  env: LiveEnv,
  beat: Heartbeat,
  now: number,
  fetchImpl: typeof fetch = fetch,
  random: () => number = Math.random,
): Promise<{ watching?: number }> {
  const since = now - WINDOW_MS
  const match = beat.item?.startsWith('match:') ? beat.item.slice('match:'.length) : null
  const commands: Command[] = [['ZADD', NOW_KEY, now, `${beat.state}|${beat.item ?? ''}|${beat.sid}`]]
  if (random() < 1 / CLEANUP_EVERY) commands.push(['ZREMRANGEBYSCORE', NOW_KEY, '-inf', `(${since}`])
  if (match) {
    if (beat.state === 'watch') commands.push(['ZADD', matchKey(match), now, beat.sid], ['EXPIRE', matchKey(match), MATCH_KEY_TTL_S])
    commands.push(['ZCOUNT', matchKey(match), since, '+inf'])
  }
  const results = await redis(env, commands, fetchImpl)
  if (!match || !results) return {}
  const watching = Number(results.at(-1))
  return Number.isFinite(watching) ? { watching } : {}
}

/** A valid ad report ({ event }), or null. */
export function parseAdEvent(body: unknown): AdEvent | null {
  const event = (body as { event?: unknown } | null)?.event
  return AD_EVENTS.includes(event as AdEvent) ? (event as AdEvent) : null
}

/** Counts one ad event for today. */
export async function recordAdEvent(env: LiveEnv, event: AdEvent, now: number, fetchImpl: typeof fetch = fetch) {
  const key = adsKey(lagosDay(now))
  const commands: Command[] = [['HINCRBY', key, event, 1], ['EXPIRE', key, ADS_KEY_TTL_S]]
  if (event === 'multitag-306795') commands.push(['SET', AD_TEST_KEY, now, 'NX'])
  await redis(env, commands, fetchImpl)
}

/** Redis's HGETALL answer ([field, value, ...]) as today's counts. */
function adCounts(flat: unknown): AdCounts {
  const counts = Object.fromEntries(AD_EVENTS.map((event) => [event, 0])) as AdCounts
  if (!Array.isArray(flat)) return counts
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const event = String(flat[i]) as AdEvent
    if (AD_EVENTS.includes(event)) counts[event] = Number(flat[i + 1]) || 0
  }
  return counts
}

/** A valid player report ({ server, event }), or null. */
export function parsePlayerEvent(body: unknown): { server: PlayerServer; event: PlayerEvent } | null {
  const b = body as { server?: unknown; event?: unknown } | null
  if (!PLAYER_SERVERS.includes(b?.server as PlayerServer) || !PLAYER_EVENTS.includes(b?.event as PlayerEvent)) return null
  return { server: b!.server as PlayerServer, event: b!.event as PlayerEvent }
}

/** Counts one player event for today. */
export async function recordPlayerEvent(env: RedisEnv, server: PlayerServer, event: PlayerEvent, now: number, fetchImpl: typeof fetch = fetch) {
  const key = playersKey(lagosDay(now))
  await redis(env, [['HINCRBY', key, `${server}:${event}`, 1], ['EXPIRE', key, ADS_KEY_TTL_S]], fetchImpl)
}

/** What /api/play saw: a call on our NextStream key, or NextStream taking or refusing the key. */
export async function recordPlayReport(env: RedisEnv, report: 'call' | 'key-ok' | 'key-rejected', now: number, fetchImpl: typeof fetch = fetch) {
  if (report === 'call') {
    const key = playersKey(lagosDay(now))
    await redis(env, [['HINCRBY', key, 'nextstream:calls', 1], ['EXPIRE', key, ADS_KEY_TTL_S]], fetchImpl)
  } else {
    await redis(env, [['HSET', KEY_STATUS, report === 'key-ok' ? 'ok' : 'rejected', now]], fetchImpl)
  }
}

/** Redis's HGETALL answer ([field, value, ...]) as an object. */
function hash(flat: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!Array.isArray(flat)) return out
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = Number(flat[i + 1]) || 0
  return out
}

function playerCounts(flat: unknown): PlayerCounts {
  const fields = hash(flat)
  const counts = { calls: fields['nextstream:calls'] ?? 0 } as PlayerCounts
  for (const server of PLAYER_SERVERS) {
    counts[server] = Object.fromEntries(PLAYER_EVENTS.map((event) => [event, fields[`${server}:${event}`] ?? 0])) as Record<PlayerEvent, number>
  }
  return counts
}

export interface KeyStatus {
  /** NEXTSTREAM_KEY_ISSUED, when set and valid. */
  issued: string | null
  /** 30 days after it was issued (ms), or null without NEXTSTREAM_KEY_ISSUED. */
  expiresAt: number | null
  /** When NextStream last took / refused the key (ms). */
  okAt: number | null
  rejectedAt: number | null
}

function keyStatus(env: LiveEnv, flat: unknown): KeyStatus {
  const fields = hash(flat)
  const given = env.keyIssued ?? ''
  const issued = /^\d{4}-\d{2}-\d{2}$/.test(given) && !Number.isNaN(Date.parse(given)) ? given : null
  return {
    issued,
    expiresAt: issued ? Date.parse(`${issued}T00:00:00Z`) + KEY_VALID_DAYS * 24 * 60 * 60_000 : null,
    okAt: fields.ok || null,
    rejectedAt: fields.rejected || null,
  }
}

export interface LiveCount {
  watching: number
  browsing: number
  /** What's being watched, most viewers first. */
  top: { item: string; viewers: number }[]
  /** Today's direct-link ads and Multitag loads (Lagos date). */
  ads: AdCounts
  /** When the second Multitag (zone 306795) first loaded (ms), or null. */
  adTestStartedAt: number | null
  /** Today's player stats per server (Lagos date). */
  players: PlayerCounts
  /** Our CodeSpecter (NextStream) API key. */
  key: KeyStatus
}

/** Everyone seen in the last WINDOW_MS, each counted once (their latest heartbeat). */
export async function countLive(env: LiveEnv, now: number, fetchImpl: typeof fetch = fetch): Promise<LiveCount | null> {
  const since = now - WINDOW_MS
  const results = await redis(
    env,
    [
      ['ZREMRANGEBYSCORE', NOW_KEY, '-inf', `(${since}`],
      ['ZRANGE', NOW_KEY, since, '+inf', 'BYSCORE', 'WITHSCORES'],
      ['HGETALL', adsKey(lagosDay(now))],
      ['HGETALL', playersKey(lagosDay(now))],
      ['HGETALL', KEY_STATUS],
      ['GET', AD_TEST_KEY],
    ],
    fetchImpl,
  )
  const flat = results?.[1]
  if (!Array.isArray(flat)) return null
  const latest = new Map<string, { state: string; item: string; at: number }>()
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [state, item, sid] = String(flat[i]).split('|')
    const at = Number(flat[i + 1])
    if (!sid) continue
    const seen = latest.get(sid)
    if (!seen || at > seen.at) latest.set(sid, { state, item, at })
  }
  const viewers = new Map<string, number>()
  let watching = 0
  let browsing = 0
  for (const { state, item } of latest.values()) {
    if (state === 'watch' && item) {
      watching++
      viewers.set(item, (viewers.get(item) ?? 0) + 1)
    } else {
      browsing++
    }
  }
  const top = [...viewers]
    .map(([item, count]) => ({ item, viewers: count }))
    .sort((a, b) => b.viewers - a.viewers || a.item.localeCompare(b.item))
    .slice(0, TOP_COUNT)
  return { watching, browsing, top, ads: adCounts(results?.[2]), adTestStartedAt: Number(results?.[5]) || null, players: playerCounts(results?.[3]), key: keyStatus(env, results?.[4]) }
}

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Constant-time password check. Never true while ADMIN_PASSWORD is unset. */
export function isAdmin(env: LiveEnv, authorization: string | undefined): boolean {
  if (!env.adminPassword) return false
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? ''
  return timingSafeEqual(digest(given), digest(env.adminPassword))
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** The request's JSON body (Vercel may have parsed it already). */
async function readJsonBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body)
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 2048) throw new Error('too large')
  }
  return JSON.parse(raw || 'null')
}

/** Serves POST /api/live/heartbeat, POST /api/live/ad, POST /api/live/player and GET /api/live/count (admin only). */
export async function handleLive(
  env: LiveEnv,
  action: string,
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  if (action === 'heartbeat') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      return sendJson(res, 400, { error: 'bad-request' })
    }
    const beat = parseHeartbeat(body)
    if (!beat) return sendJson(res, 400, { error: 'bad-request' })
    return sendJson(res, 200, await recordHeartbeat(env, beat, now, fetchImpl))
  }
  if (action === 'ad') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      return sendJson(res, 400, { error: 'bad-request' })
    }
    const event = parseAdEvent(body)
    if (!event) return sendJson(res, 400, { error: 'bad-request' })
    await recordAdEvent(env, event, now, fetchImpl)
    return sendJson(res, 200, {})
  }
  if (action === 'player') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      return sendJson(res, 400, { error: 'bad-request' })
    }
    const report = parsePlayerEvent(body)
    if (!report) return sendJson(res, 400, { error: 'bad-request' })
    await recordPlayerEvent(env, report.server, report.event, now, fetchImpl)
    return sendJson(res, 200, {})
  }
  if (action === 'count') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' })
    if (!env.adminPassword) return sendJson(res, 503, { error: 'not-configured' })
    if (!isAdmin(env, req.headers.authorization)) return sendJson(res, 401, { error: 'unauthorized' })
    if (!env.redisUrl || !env.redisToken) return sendJson(res, 503, { error: 'no-store' })
    const count = await countLive(env, now, fetchImpl)
    return count ? sendJson(res, 200, count) : sendJson(res, 502, { error: 'store-unavailable' })
  }
  sendJson(res, 404, { error: 'not-found' })
}
