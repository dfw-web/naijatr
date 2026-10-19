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

const SID = /^[A-Za-z0-9_-]{16,64}$/
const ITEM = /^(movie|tv|match):[1-9]\d{0,11}$/

export type LiveState = 'watch' | 'browse'

export interface LiveEnv extends RedisEnv {
  adminPassword: string
}

export function readLiveEnv(env: Record<string, string | undefined>): LiveEnv {
  return { ...readRedisEnv(env), adminPassword: env.ADMIN_PASSWORD ?? '' }
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

export interface LiveCount {
  watching: number
  browsing: number
  /** What's being watched, most viewers first. */
  top: { item: string; viewers: number }[]
}

/** Everyone seen in the last WINDOW_MS, each counted once (their latest heartbeat). */
export async function countLive(env: LiveEnv, now: number, fetchImpl: typeof fetch = fetch): Promise<LiveCount | null> {
  const since = now - WINDOW_MS
  const results = await redis(
    env,
    [
      ['ZREMRANGEBYSCORE', NOW_KEY, '-inf', `(${since}`],
      ['ZRANGE', NOW_KEY, since, '+inf', 'BYSCORE', 'WITHSCORES'],
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
  return { watching, browsing, top }
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

/** Serves POST /api/live/heartbeat and GET /api/live/count (admin only). */
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
