/**
 * The Football Live Streaming API's live list, shared by every server
 * instance through Upstash Redis (in memory when Redis isn't configured, as
 * in local dev and tests):
 *
 * - fb:sl:live     the last list ({ fetchedAt, matches }), refreshed every
 *                  5 minutes while people are looking, and kept 6 hours as a
 *                  fallback. Nobody on the site → no requests.
 * - fb:sl:lock     held while one instance asks the API, so many people
 *                  opening matches at once cause a single request.
 * - fb:sl:quota    the plan's limit and what's left, from the last response's
 *                  headers. At 95% used, the API isn't asked again (cached
 *                  data is served) until the count resets.
 * - fb:sl:calls    the last 10 requests, for /admin/live.
 * - fb:sl:refresh:<match>  a match's manual refresh, at most every 10 minutes.
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import { hasRedis, redis, type RedisEnv } from '../redis.js'
import { nearTeam, sameTeam } from './stream.js'
import { fetchStreamingLive, type StreamingMatch, type StreamingQuota } from './streaming.js'

export const STREAMING_TTL_MS = 5 * 60_000
/** A live match missing from the list is looked for again after this long (it may have just kicked off). */
export const STREAMING_MISSING_MS = 60_000
/** The list is kept this long as a fallback for when the API fails or the quota runs low. */
const SNAPSHOT_KEEP_S = 6 * 60 * 60
/** Stop asking the API at this share of the plan's limit. */
export const QUOTA_STOP = 0.95
/** A quota reading this old no longer stops requests (the count has reset). */
const QUOTA_VALID_MS = 24 * 60 * 60_000
const LOCK_MS = 15_000
/** How long a request waits for another instance's fetch to finish. */
const WAIT_TRIES = 8
const WAIT_STEP_MS = 500
export const MANUAL_REFRESH_EVERY_MS = 10 * 60_000
const CALLS_KEPT = 10

const LIVE_KEY = 'fb:sl:live'
const LOCK_KEY = 'fb:sl:lock'
const QUOTA_KEY = 'fb:sl:quota'
const CALLS_KEY = 'fb:sl:calls'
const refreshKey = (match: string) => `fb:sl:refresh:${match}`

export interface StreamingSnapshot {
  fetchedAt: number
  matches: StreamingMatch[]
}

export interface StreamingQuotaReading extends StreamingQuota {
  at: number
}

export interface StreamingCall {
  at: number
  ok: boolean
  status: number
  requests: number
  matches: number
  ms: number
  remaining: number | null
  why: string
}

export interface StreamingStore {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>
  /** True if the lock was taken (also when the store is unreachable: better one extra request than none). */
  lock(key: string, ttlMs: number): Promise<boolean>
  unlock(key: string): Promise<void>
  /** Milliseconds left on a key, or 0. */
  ttl(key: string): Promise<number>
  log(call: StreamingCall): Promise<void>
  calls(): Promise<StreamingCall[]>
}

export function createMemoryStore(now: () => number = Date.now): StreamingStore {
  const values = new Map<string, { value: unknown; expires: number }>()
  const live = (key: string) => {
    const entry = values.get(key)
    return entry && entry.expires > now() ? entry : undefined
  }
  const log: StreamingCall[] = []
  return {
    async get<T>(key: string) {
      return (live(key)?.value as T | undefined) ?? null
    },
    async set(key, value, ttlSeconds) {
      values.set(key, { value, expires: now() + ttlSeconds * 1000 })
    },
    async lock(key, ttlMs) {
      if (live(key)) return false
      values.set(key, { value: 1, expires: now() + ttlMs })
      return true
    },
    async unlock(key) {
      values.delete(key)
    },
    async ttl(key) {
      const entry = live(key)
      return entry ? entry.expires - now() : 0
    },
    async log(call) {
      log.unshift(call)
      log.length = Math.min(log.length, CALLS_KEPT)
    },
    async calls() {
      return [...log]
    },
  }
}

const parse = <T>(value: unknown): T | null => {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export function createRedisStore(env: RedisEnv, fetchImpl: typeof fetch = fetch): StreamingStore {
  const run = (...commands: (string | number)[][]) => redis(env, commands, fetchImpl)
  return {
    async get<T>(key: string) {
      return parse<T>((await run(['GET', key]))?.[0])
    },
    async set(key, value, ttlSeconds) {
      await run(['SET', key, JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSeconds))])
    },
    async lock(key, ttlMs) {
      const result = await run(['SET', key, '1', 'NX', 'PX', ttlMs])
      return result === null || result[0] === 'OK'
    },
    async unlock(key) {
      await run(['DEL', key])
    },
    async ttl(key) {
      const left = Number((await run(['PTTL', key]))?.[0])
      return Number.isFinite(left) && left > 0 ? left : 0
    },
    async log(call) {
      await run(['LPUSH', CALLS_KEY, JSON.stringify(call)], ['LTRIM', CALLS_KEY, 0, CALLS_KEPT - 1])
    },
    async calls() {
      const list = (await run(['LRANGE', CALLS_KEY, 0, CALLS_KEPT - 1]))?.[0]
      return Array.isArray(list) ? list.map((entry) => parse<StreamingCall>(entry)).filter((c): c is StreamingCall => c !== null) : []
    },
  }
}

/** Redis when configured, otherwise this process's memory. */
export const createStreamingStore = (env: RedisEnv, fetchImpl: typeof fetch = fetch) =>
  hasRedis(env) ? createRedisStore(env, fetchImpl) : createMemoryStore()

export interface StreamingDeps {
  key: string
  store: StreamingStore
  now: () => number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export interface StreamingLoad {
  snapshot: StreamingSnapshot | null
  /** The quota is at its 95% stop: cached data only. */
  limited: boolean
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Whether the last quota reading is at the stop. */
export async function quotaStopped(deps: StreamingDeps): Promise<boolean> {
  const quota = await deps.store.get<StreamingQuotaReading>(QUOTA_KEY)
  return Boolean(
    quota && deps.now() - quota.at < QUOTA_VALID_MS && quota.limit - quota.remaining >= quota.limit * QUOTA_STOP,
  )
}

/**
 * The live list, at most `maxAgeMs` old when the API can be asked. Only one
 * instance asks at a time; the others wait briefly for its answer.
 */
export async function loadStreaming(
  deps: StreamingDeps,
  { maxAgeMs = STREAMING_TTL_MS, why = 'list' }: { maxAgeMs?: number; why?: string } = {},
): Promise<StreamingLoad> {
  const { store, now } = deps
  const snapshot = await store.get<StreamingSnapshot>(LIVE_KEY)
  if (!deps.key || (snapshot && now() - snapshot.fetchedAt < maxAgeMs)) return { snapshot, limited: false }
  if (await quotaStopped(deps)) return { snapshot, limited: true }

  if (!(await store.lock(LOCK_KEY, LOCK_MS))) {
    // Another instance is asking: use its answer when it lands.
    const sleep = deps.sleep ?? wait
    for (let i = 0; i < WAIT_TRIES; i += 1) {
      await sleep(WAIT_STEP_MS)
      const fresh = await store.get<StreamingSnapshot>(LIVE_KEY)
      if (fresh && fresh.fetchedAt !== snapshot?.fetchedAt) return { snapshot: fresh, limited: false }
    }
    return { snapshot, limited: false }
  }

  const started = now()
  try {
    const result = await fetchStreamingLive(deps.key, deps.fetchImpl)
    const at = now()
    if (result.quota) await store.set(QUOTA_KEY, { ...result.quota, at }, QUOTA_VALID_MS / 1000)
    await store.log({
      at,
      ok: result.ok,
      status: result.status,
      requests: result.requests,
      matches: result.ok ? result.matches.length : 0,
      ms: at - started,
      remaining: result.quota?.remaining ?? null,
      why,
    })
    if (!result.ok) return { snapshot, limited: false }
    const fresh = { fetchedAt: at, matches: withMissed(result.matches, snapshot) }
    await store.set(LIVE_KEY, fresh, SNAPSHOT_KEEP_S)
    return { snapshot: fresh, limited: false }
  } finally {
    await store.unlock(LOCK_KEY)
  }
}

/**
 * The list is read page by page while matches start and end, so entries shift
 * between pages and one read can skip a match that is still on. A match from
 * the last list that this read lacks is kept once (marked missed); missing
 * twice in a row, it's gone.
 */
export function withMissed(matches: StreamingMatch[], previous: StreamingSnapshot | null): StreamingMatch[] {
  const keys = new Set(matches.map((m) => m.key))
  const kept = (previous?.matches ?? []).filter((m) => !m.missed && !keys.has(m.key)).map((m) => ({ ...m, missed: true }))
  return [...matches, ...kept]
}

/** Kick-offs further apart than this are different matches between the same teams. */
const SAME_MATCH_MS = 3 * 60 * 60_000

/** Our match (by team names and kick-off) in the list, or null. */
export function findStreamingMatch(snapshot: StreamingSnapshot | null, home: string, away: string, kickoff = 0) {
  for (const match of snapshot?.matches ?? []) {
    const pairs = (x: string, y: string) => (sameTeam(x, home) && nearTeam(y, away)) || (nearTeam(x, home) && sameTeam(y, away))
    if (!pairs(match.home, match.away) && !pairs(match.away, match.home)) continue
    if (kickoff && match.kickoff && Math.abs(kickoff - match.kickoff) > SAME_MATCH_MS) continue
    return match
  }
  return null
}

/**
 * The streams for one of our matches. A live match not in the list is looked
 * for again once the list is a minute old, since it may have just started.
 */
export async function streamsForMatch(deps: StreamingDeps, home: string, away: string, kickoff: number, live: boolean) {
  let load = await loadStreaming(deps)
  let match = findStreamingMatch(load.snapshot, home, away, kickoff)
  if (!match && live && !load.limited) {
    load = await loadStreaming(deps, { maxAgeMs: STREAMING_MISSING_MS, why: 'match started' })
    match = findStreamingMatch(load.snapshot, home, away, kickoff)
  }
  return { match, load }
}

/**
 * /admin/live's "Refresh stream": asks the API again now, at most once per
 * match every 10 minutes. Returns when it may be asked again otherwise.
 */
export async function refreshStreamingMatch(deps: StreamingDeps, matchId: string) {
  const key = refreshKey(matchId)
  if (!(await deps.store.lock(key, MANUAL_REFRESH_EVERY_MS))) {
    return { ok: false as const, retryInMs: await deps.store.ttl(key) }
  }
  const load = await loadStreaming(deps, { maxAgeMs: 0, why: `refresh match ${matchId}` })
  return { ok: true as const, load }
}

export interface StreamingAdmin {
  quota: StreamingQuotaReading | null
  stopped: boolean
  snapshot: StreamingSnapshot | null
  calls: StreamingCall[]
}

export async function streamingAdmin(deps: StreamingDeps): Promise<StreamingAdmin> {
  const [quota, snapshot, calls, stopped] = await Promise.all([
    deps.store.get<StreamingQuotaReading>(QUOTA_KEY),
    deps.store.get<StreamingSnapshot>(LIVE_KEY),
    deps.store.calls(),
    quotaStopped(deps),
  ])
  return { quota, stopped, snapshot, calls }
}
