/**
 * "🔔 Request this title": titles a viewer found on no server ("No server
 * found" in the player), for /api/live/{request,requests,requests-check}
 * (server/live/handlers.ts routes them; no Vercel function of its own).
 *
 * - POST /api/live/request { item, title, ep, device } saves one request,
 *   once per person per title: per device, and per account when signed in
 *   (Authorization: the Supabase access token, checked by Supabase). At
 *   ALERT_AT requests the admin gets a Telegram message (once per title).
 *   Nobody is emailed.
 * - GET /api/live/requests (ADMIN_PASSWORD): "Most requested" on /admin/live.
 * - POST /api/live/playing { item, ep, server }: a viewer's player (either
 *   server, EmbedMaster included) started playing a title. Kept only for
 *   requested titles, per network (hashed IP).
 * - GET /api/live/requests-check (CRON_SECRET, from the daily Vercel cron in
 *   vercel.json, or ADMIN_PASSWORD): each waiting title counts as playing when
 *   viewers on PLAYS_NEEDED different networks saw it play since the last
 *   request (no call on any key; EmbedMaster can't be asked from a server:
 *   its player's source list is encrypted), else NextStream's own source
 *   lookup (one call on our key) is asked. Playable now: marked so on
 *   /admin/live, and a line to the admin on Telegram.
 *
 * Redis (server/redis.ts):
 * - requests:count          sorted set of titles ("movie:550", "tv:1399") by requests.
 * - requests:who:<item>     set of who asked: "d:<device>", "u:<user id>".
 * - requests:users:<item>   (no longer kept: deleted when seen; nobody is emailed.)
 * - requests:meta:<item>    hash: title, type, ep (series: "s1e3"), first, last (ms),
 *                           alerted (ms, Telegram sent), availableAt (ms), foundBy
 *                           (viewers / nextstream), playedAt, playedOn.
 * - requests:played:<item>  sorted set of the (hashed) networks a viewer's player played it on, by time.
 * - requests:limit:<who>:<day>  today's requests from a device or (hashed) IP.
 * Nothing personal is kept: user ids only (to count each account once), IPs hashed.
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import { createHash } from 'node:crypto'
import { checkPlayable, readTmdbCredentials, tmdbUpstreamUrl, type TmdbCredentials } from '../handlers.js'
import { readNextStreamConfig, type NextStreamConfig } from '../nextstream.js'
import { hasRedis, readRedisEnv, redis, type Command, type RedisEnv } from '../redis.js'

/** The admin hears about a title on Telegram when it reaches this many requests. */
export const ALERT_AT = 5
/** Requests a device may make a day, and an IP address (several people may share one). */
export const DAILY_PER_DEVICE = 20
export const DAILY_PER_IP = 60
/** Titles re-checked per daily run (most requested first), and how many at once. */
export const CHECK_MAX = 40
const CHECK_PARALLEL = 4
const LIST_SIZE = 25
const TIMEOUT_MS = 5000

const COUNT_KEY = 'requests:count'
const whoKey = (item: string) => `requests:who:${item}`
/** Signed-in requesters, kept by the first version to email them: cleared, never read. */
const usersKey = (item: string) => `requests:users:${item}`
const metaKey = (item: string) => `requests:meta:${item}`
const limitKey = (who: string, day: string) => `requests:limit:${who}:${day}`
const playedKey = (item: string) => `requests:played:${item}`

/** Plays from this many different networks (after the last request) count as "it plays now". */
export const PLAYS_NEEDED = 2
const PLAYED_TTL_S = 30 * 24 * 60 * 60
const SERVERS = ['nextstream', 'embedmaster'] as const

export interface PlayingReport {
  item: string
  ep: string | null
  server: (typeof SERVERS)[number]
}

/** A valid "it's playing" report from a viewer's player, or null. */
export function parsePlaying(body: unknown): PlayingReport | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return null
  if (typeof b.item !== 'string' || !ITEM.test(b.item)) return null
  if (!SERVERS.includes(b.server as PlayingReport['server'])) return null
  const ep = b.item.startsWith('tv:') && typeof b.ep === 'string' && EP.test(b.ep) ? b.ep : null
  return { item: b.item, ep, server: b.server as PlayingReport['server'] }
}

const hashIp = (ip: string) => createHash('sha256').update(`requests|${ip}`).digest('hex').slice(0, 24)

/**
 * A requested title playing in a viewer's player (EmbedMaster or NextStream):
 * noted per network (hashed IP), for the daily check. Ignored for titles
 * nobody asked for, ones already found playing, and (series) another
 * episode than the one asked for. True when noted.
 */
export async function recordPlaying(env: RequestsEnv, report: PlayingReport, ip: string, now: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!hasRedis(env)) return false
  const { item } = report
  const state = await redis(env, [['ZSCORE', COUNT_KEY, item], ['HGET', metaKey(item), 'availableAt'], ['HGET', metaKey(item), 'ep']], fetchImpl)
  if (!state || state[0] === null || state[0] === undefined || state[1]) return false
  const wanted = typeof state[2] === 'string' ? state[2] : null
  if (wanted && report.ep !== wanted) return false
  await redis(
    env,
    [
      ['ZADD', playedKey(item), now, hashIp(ip)],
      ['EXPIRE', playedKey(item), PLAYED_TTL_S],
      ['HSET', metaKey(item), 'playedAt', now, 'playedOn', report.server],
    ],
    fetchImpl,
  )
  return true
}

const ITEM = /^(movie|tv):[1-9]\d{0,8}$/
const EP = /^s([1-9]\d{0,2})e([1-9]\d{0,3})$/
const DEVICE = /^[A-Za-z0-9_-]{16,64}$/
const MAX_TITLE = 120

export interface RequestsEnv extends RedisEnv {
  adminPassword: string
  /** Vercel sends it on its cron calls (Authorization: Bearer <CRON_SECRET>). */
  cronSecret: string
  supabaseUrl: string
  supabaseKey: string
  telegramToken: string
  telegramChatId: string
  nextstream: NextStreamConfig
  tmdb: TmdbCredentials
}

export function readRequestsEnv(env: Record<string, string | undefined>): RequestsEnv {
  return {
    ...readRedisEnv(env),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    cronSecret: (env.CRON_SECRET ?? '').trim(),
    supabaseUrl: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    supabaseKey: (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
    telegramChatId: env.ADMIN_TELEGRAM_CHAT_ID?.trim() ?? '',
    nextstream: readNextStreamConfig(env),
    tmdb: readTmdbCredentials(env),
  }
}

/** Lagos date (UTC+1), as the rest of /admin/live counts days. */
const lagosDay = (now: number) => new Date(now + 60 * 60_000).toISOString().slice(0, 10)

/** Plain text only: no tags, links or control characters, single-spaced, at most `max` long. */
export function cleanTitle(value: unknown, max = MAX_TITLE): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ng|xyz|info|ru|co|me|tv|link|site|online|top|app)(?:\/\S*)?/gi, ' ')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export interface TitleRequest {
  /** "movie:550" or "tv:1399". */
  item: string
  title: string
  /** Series: the episode that wouldn't play ("s1e3"). */
  ep: string | null
  device: string
}

/** A valid request, or null. */
export function parseTitleRequest(body: unknown): TitleRequest | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return null
  if (typeof b.item !== 'string' || !ITEM.test(b.item)) return null
  if (typeof b.device !== 'string' || !DEVICE.test(b.device)) return null
  const ep = b.item.startsWith('tv:') && typeof b.ep === 'string' && EP.test(b.ep) ? b.ep : null
  return { item: b.item, title: cleanTitle(b.title), ep, device: b.device }
}

/** The signed-in user an access token belongs to, checked by Supabase itself; null if none. */
export async function userOfToken(env: RequestsEnv, token: string | undefined, fetchImpl: typeof fetch): Promise<string | null> {
  if (!token || !env.supabaseUrl || !env.supabaseKey) return null
  try {
    const response = await fetchImpl(`${env.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: env.supabaseKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null
    return typeof body?.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : null
  } catch {
    return null
  }
}

/** Redis's HGETALL answer ([field, value, ...]) as an object. */
function fields(flat: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(flat)) return out
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1])
  return out
}

/** The title's name from TMDB (so nobody can name a title in your Telegram), else the requester's. */
async function nameOf(env: RequestsEnv, item: string, fallback: string, fetchImpl: typeof fetch): Promise<string> {
  const [kind, id] = item.split(':')
  const url = env.tmdb.readToken || env.tmdb.apiKey ? tmdbUpstreamUrl(env.tmdb, `/${kind}/${id}`, new URLSearchParams({ language: 'en-US' })) : null
  if (url) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', ...(env.tmdb.readToken ? { Authorization: `Bearer ${env.tmdb.readToken}` } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { title?: unknown; name?: unknown } | null
        const name = cleanTitle(body?.title ?? body?.name)
        if (name) return name
      }
    } catch {
      // The requester's name for it.
    }
  }
  return fallback || (kind === 'tv' ? `Series ${id}` : `Movie ${id}`)
}

async function telegram(env: RequestsEnv, text: string, fetchImpl: typeof fetch): Promise<boolean> {
  if (!env.telegramToken || !env.telegramChatId) return false
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.telegramChatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

const label = (item: string, ep: string | null) => `${item.startsWith('tv:') ? 'series' : 'movie'} ${item.split(':')[1]}${ep ? ` ${ep.toUpperCase()}` : ''}`

/** The Telegram message when a title reaches ALERT_AT requests. */
export const alertText = (title: string, item: string, ep: string | null, count: number) =>
  `🔔 ${count} requests: "${title}" (${label(item, ep)})\nIt's on no server yet ("No server found").\nSee /admin/live → Most requested.`

export type RequestResult =
  | { status: 200; body: { ok: true; count: number; already: boolean } }
  | { status: 400 | 429 | 503; body: { error: string } }

/**
 * Saves one request: counted once per person per title (device, and account
 * when signed in). Asking again is fine, just not counted again.
 */
export async function saveTitleRequest(
  env: RequestsEnv,
  request: TitleRequest,
  userId: string | null,
  ip: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RequestResult> {
  if (!hasRedis(env)) return { status: 503, body: { error: 'not-configured' } }
  const day = lagosDay(now)
  const ipHash = hashIp(ip)
  const limits = await redis(
    env,
    [
      ['INCR', limitKey(`d:${request.device}`, day)],
      ['EXPIRE', limitKey(`d:${request.device}`, day), 2 * 24 * 60 * 60],
      ['INCR', limitKey(`ip:${ipHash}`, day)],
      ['EXPIRE', limitKey(`ip:${ipHash}`, day), 2 * 24 * 60 * 60],
    ],
    fetchImpl,
  )
  if (!limits) return { status: 503, body: { error: 'store-unavailable' } }
  if (Number(limits[0]) > DAILY_PER_DEVICE || Number(limits[2]) > DAILY_PER_IP) return { status: 429, body: { error: 'limit' } }

  const { item } = request
  const commands: Command[] = [['SADD', whoKey(item), `d:${request.device}`]]
  if (userId) commands.push(['SADD', whoKey(item), `u:${userId}`])
  commands.push(
    ['DEL', usersKey(item)],
    ['HSETNX', metaKey(item), 'first', now],
    ['HSETNX', metaKey(item), 'title', request.title || ''],
    ['HSET', metaKey(item), 'last', now, 'type', item.split(':')[0]],
    // Asked for again after it was found playing: it's missing again, so it's checked again.
    ['HDEL', metaKey(item), 'availableAt'],
  )
  if (request.ep) commands.push(['HSET', metaKey(item), 'ep', request.ep])
  const saved = await redis(env, commands, fetchImpl)
  if (!saved) return { status: 503, body: { error: 'store-unavailable' } }
  const isNew = Number(saved[0]) === 1 && (!userId || Number(saved[1]) === 1)
  const counted = await redis(env, [isNew ? ['ZINCRBY', COUNT_KEY, 1, item] : ['ZSCORE', COUNT_KEY, item]], fetchImpl)
  const count = Number(counted?.[0]) || (isNew ? 1 : 0)

  if (count >= ALERT_AT) {
    const first = await redis(env, [['HSETNX', metaKey(item), 'alerted', now], ['HGET', metaKey(item), 'title'], ['HGET', metaKey(item), 'ep']], fetchImpl)
    if (first && Number(first[0]) === 1) {
      const title = await nameOf(env, item, String(first[1] ?? ''), fetchImpl)
      await telegram(env, alertText(title, item, (first[2] as string | null) ?? null, count), fetchImpl)
    }
  }
  return { status: 200, body: { ok: true, count, already: !isNew } }
}

export interface RequestedTitle {
  item: string
  count: number
  title: string
  ep: string | null
  first: number | null
  last: number | null
  /** When the daily check found it playing. */
  availableAt: number | null
  /** Networks that saw it playing since the last request (PLAYS_NEEDED counts as playing). */
  seenPlaying: number
  /** How the daily check found it playing. */
  foundBy: 'viewers' | 'nextstream' | null
}

/** The most requested titles, for /admin/live. */
export async function listTitleRequests(env: RequestsEnv, fetchImpl: typeof fetch = fetch, size = LIST_SIZE): Promise<{ titles: RequestedTitle[]; total: number } | null> {
  const top = await redis(env, [['ZRANGE', COUNT_KEY, 0, size - 1, 'REV', 'WITHSCORES'], ['ZCARD', COUNT_KEY]], fetchImpl)
  if (!top) return null
  const flat = Array.isArray(top[0]) ? (top[0] as unknown[]) : []
  const ranked: { item: string; count: number }[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) ranked.push({ item: String(flat[i]), count: Number(flat[i + 1]) || 0 })
  if (ranked.length === 0) return { titles: [], total: Number(top[1]) || 0 }
  const details = await redis(env, ranked.flatMap(({ item }): Command[] => [['HGETALL', metaKey(item)], ['ZRANGE', playedKey(item), 0, -1, 'WITHSCORES']]), fetchImpl)
  const titles = ranked.map(({ item, count }, index): RequestedTitle => {
    const meta = fields(details?.[index * 2])
    const played = details?.[index * 2 + 1]
    const since = Number(meta.last) || 0
    let seenPlaying = 0
    if (Array.isArray(played)) for (let i = 1; i < played.length; i += 2) if (Number(played[i]) >= since) seenPlaying++
    return {
      item,
      count,
      title: meta.title ?? '',
      ep: meta.ep ?? null,
      first: Number(meta.first) || null,
      last: Number(meta.last) || null,
      availableAt: Number(meta.availableAt) || null,
      seenPlaying,
      foundBy: meta.foundBy === 'viewers' || meta.foundBy === 'nextstream' ? (meta.foundBy as RequestedTitle['foundBy']) : null,
    }
  })
  return { titles, total: Number(top[1]) || 0 }
}

/** The path the player plays a requested title on: the episode that failed, else S1 E1. */
export function playPath(item: string, ep: string | null): string {
  const [kind, id] = item.split(':')
  if (kind === 'movie') return `/movie/${id}`
  const match = EP.exec(ep ?? '')
  return `/tv/${id}/${match?.[1] ?? 1}/${match?.[2] ?? 1}`
}

export interface CheckSummary {
  checked: number
  /** Playable now (marked so on /admin/live). */
  nowPlaying: { item: string; title: string; via: 'viewers' | 'nextstream' }[]
  stillMissing: number
  /** Couldn't tell (NextStream unreachable or not set up). */
  unknown: number
  error?: string
}

/**
 * The daily re-check of each waiting title (most requested first, at most
 * CHECK_MAX): seen playing by viewers on PLAYS_NEEDED networks (EmbedMaster
 * included), else NextStream's own source lookup. Playable now: marked so,
 * and a Telegram line to the admin. Nobody is emailed.
 */
export async function checkRequestedTitles(env: RequestsEnv, now: number, fetchImpl: typeof fetch = fetch): Promise<CheckSummary | null> {
  const summary: CheckSummary = { checked: 0, nowPlaying: [], stillMissing: 0, unknown: 0 }
  const top = await redis(env, [['ZRANGE', COUNT_KEY, 0, 199, 'REV']], fetchImpl)
  if (!top) return null
  const items = (Array.isArray(top[0]) ? (top[0] as unknown[]) : []).map(String).filter((item) => ITEM.test(item))
  if (items.length === 0) return summary
  const metas = await redis(env, items.map((item): Command => ['HGETALL', metaKey(item)]), fetchImpl)
  const waiting = items
    .map((item, index) => ({ item, meta: fields(metas?.[index]) }))
    .filter(({ meta }) => !meta.availableAt)
    .slice(0, CHECK_MAX)

  // Seen playing by viewers (either server, EmbedMaster included) since the last request.
  const plays = waiting.length
    ? await redis(env, waiting.map(({ item, meta }): Command => ['ZCOUNT', playedKey(item), Number(meta.last) || 0, '+inf']), fetchImpl)
    : []
  const queue = waiting.map((entry, index) => ({ ...entry, seen: Number(plays?.[index]) || 0 }))
  let nextstreamOff = false
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { item, meta, seen } = next
      const ep = meta.ep && EP.test(meta.ep) ? meta.ep : null
      let via: 'viewers' | 'nextstream' = 'viewers'
      if (seen < PLAYS_NEEDED) {
        // Not seen enough: NextStream's own source lookup (one call on our key).
        if (nextstreamOff) continue
        const { available, reason } = await checkPlayable(env.nextstream, playPath(item, ep), fetchImpl)
        if (reason === 'not-configured') {
          nextstreamOff = true
          summary.error = 'NextStream isn’t set up (NEXTSTREAM_*): only titles viewers saw playing were checked'
          continue
        }
        summary.checked++
        if (available === null) {
          summary.unknown++
          continue
        }
        if (!available) {
          summary.stillMissing++
          continue
        }
        via = 'nextstream'
      } else {
        summary.checked++
      }
      const title = await nameOf(env, item, meta.title ?? '', fetchImpl)
      await redis(env, [['HSET', metaKey(item), 'availableAt', now, 'foundBy', via], ['DEL', usersKey(item)]], fetchImpl)
      summary.nowPlaying.push({ item, title, via })
    }
  }
  await Promise.all(Array.from({ length: CHECK_PARALLEL }, worker))

  if (summary.nowPlaying.length > 0) {
    const lines = summary.nowPlaying.map(
      ({ title, via }) => `✅ ${title}: playing now${via === 'viewers' ? ' (seen playing by viewers)' : ''}`,
    )
    await telegram(env, ['🎬 Requested titles now on NAIJA TR', ...lines].join('\n'), fetchImpl)
  }
  return summary
}
