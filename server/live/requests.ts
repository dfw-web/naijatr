/**
 * "🔔 Request this title": titles a viewer found on no server ("No server
 * found" in the player), for /api/live/{request,requests,requests-check}
 * (server/live/handlers.ts routes them; no Vercel function of its own).
 *
 * - POST /api/live/request { item, title, ep, device } saves one request,
 *   once per person per title: per device, and per account when signed in
 *   (Authorization: the Supabase access token, checked by Supabase). A
 *   signed-in requester is emailed when the title starts playing. At
 *   ALERT_AT requests the admin gets a Telegram message (once per title).
 * - GET /api/live/requests (ADMIN_PASSWORD): "Most requested" on /admin/live.
 * - GET /api/live/requests-check (CRON_SECRET, from the daily Vercel cron in
 *   vercel.json, or ADMIN_PASSWORD): checks each waiting title with
 *   NextStream's own source lookup (the one the player makes). Playable now:
 *   "🎬 <Title> is now on NAIJA TR" to everyone signed in who asked
 *   (Resend), and a line to the admin on Telegram.
 *
 * Redis (server/redis.ts):
 * - requests:count          sorted set of titles ("movie:550", "tv:1399") by requests.
 * - requests:who:<item>     set of who asked: "d:<device>", "u:<user id>".
 * - requests:users:<item>   set of the signed-in user ids to email; emptied once emailed.
 * - requests:meta:<item>    hash: title, type, ep (series: "s1e3"), first, last (ms),
 *                           alerted (ms, Telegram sent), availableAt (ms), emailed (count).
 * - requests:limit:<who>:<day>  today's requests from a device or (hashed) IP.
 * Nothing personal is kept: user ids only (emails are looked up when sending), IPs hashed.
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
const usersKey = (item: string) => `requests:users:${item}`
const metaKey = (item: string) => `requests:meta:${item}`
const limitKey = (who: string, day: string) => `requests:limit:${who}:${day}`

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
  resendKey: string
  resendFrom: string
  siteUrl: string
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
    resendKey: (env.RESEND_API_KEY ?? '').trim(),
    resendFrom: (env.RESEND_FROM ?? '').trim(),
    siteUrl: (env.SITE_URL || 'https://www.naijatr.com').replace(/\/+$/, ''),
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

/** The title's name from TMDB (so nobody can name a title for the emails), else the requester's. */
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
  | { status: 200; body: { ok: true; count: number; already: boolean; email: boolean } }
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
  const ipHash = createHash('sha256').update(`requests|${ip}`).digest('hex').slice(0, 24)
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
  if (userId) commands.push(['SADD', whoKey(item), `u:${userId}`], ['SADD', usersKey(item), userId])
  commands.push(
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
  return { status: 200, body: { ok: true, count, already: !isNew, email: Boolean(userId) } }
}

export interface RequestedTitle {
  item: string
  count: number
  title: string
  ep: string | null
  first: number | null
  last: number | null
  /** Signed-in requesters still to be emailed. */
  waiting: number
  /** When the daily check found it playing, and how many were emailed then. */
  availableAt: number | null
  emailed: number
}

/** The most requested titles, for /admin/live. */
export async function listTitleRequests(env: RequestsEnv, fetchImpl: typeof fetch = fetch, size = LIST_SIZE): Promise<{ titles: RequestedTitle[]; total: number } | null> {
  const top = await redis(env, [['ZRANGE', COUNT_KEY, 0, size - 1, 'REV', 'WITHSCORES'], ['ZCARD', COUNT_KEY]], fetchImpl)
  if (!top) return null
  const flat = Array.isArray(top[0]) ? (top[0] as unknown[]) : []
  const ranked: { item: string; count: number }[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) ranked.push({ item: String(flat[i]), count: Number(flat[i + 1]) || 0 })
  if (ranked.length === 0) return { titles: [], total: Number(top[1]) || 0 }
  const details = await redis(env, ranked.flatMap(({ item }): Command[] => [['HGETALL', metaKey(item)], ['SCARD', usersKey(item)]]), fetchImpl)
  const titles = ranked.map(({ item, count }, index) => {
    const meta = fields(details?.[index * 2])
    return {
      item,
      count,
      title: meta.title ?? '',
      ep: meta.ep ?? null,
      first: Number(meta.first) || null,
      last: Number(meta.last) || null,
      waiting: Number(details?.[index * 2 + 1]) || 0,
      availableAt: Number(meta.availableAt) || null,
      emailed: Number(meta.emailed) || 0,
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

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The email to a requester. */
export function availableEmail(env: RequestsEnv, title: string, item: string) {
  const [kind, id] = item.split(':')
  const link = `${env.siteUrl}/?title=${kind === 'tv' ? 'series' : 'movie'}-${id}`
  return {
    subject: `🎬 ${title} is now on NAIJA TR`,
    text: `Good news! ${title}, which you asked for, is now on NAIJA TR.\n\nWatch it here: ${link}\n\nThanks for requesting it.\nNAIJA TR`,
    html: `<p>Good news! <strong>${escapeHtml(title)}</strong>, which you asked for, is now on NAIJA TR.</p><p><a href="${link}">▶ Watch it here</a></p><p>Thanks for requesting it.<br>NAIJA TR</p>`,
  }
}

/** The emails of these accounts (looked up now: none are kept). */
async function emailsOf(env: RequestsEnv, userIds: string[], fetchImpl: typeof fetch): Promise<string[]> {
  const emails: string[] = []
  for (const id of userIds) {
    try {
      const response = await fetchImpl(`${env.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        headers: { apikey: env.supabaseKey, Authorization: `Bearer ${env.supabaseKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) continue
      const user = (await response.json().catch(() => null)) as { email?: unknown } | null
      if (typeof user?.email === 'string' && user.email.includes('@')) emails.push(user.email)
    } catch {
      // Skipped.
    }
  }
  return [...new Set(emails)]
}

/** One email each, 100 a call (Resend's batch limit). Returns how many Resend took. */
async function sendEmails(env: RequestsEnv, to: string[], mail: ReturnType<typeof availableEmail>, fetchImpl: typeof fetch): Promise<number> {
  let sent = 0
  for (let i = 0; i < to.length; i += 100) {
    const batch = to.slice(i, i + 100).map((email) => ({ from: env.resendFrom, to: [email], ...mail }))
    try {
      const response = await fetchImpl('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) sent += batch.length
    } catch {
      // Tried again on the next daily check (they stay in the list).
    }
  }
  return sent
}

export interface CheckSummary {
  checked: number
  /** Playable now: the requesters were emailed. */
  nowPlaying: { item: string; title: string; emailed: number }[]
  stillMissing: number
  /** Couldn't tell (NextStream unreachable or not set up). */
  unknown: number
  error?: string
}

/**
 * The daily re-check: each waiting title (most requested first, at most
 * CHECK_MAX) through NextStream's own source lookup. Playable now: everyone
 * signed in who asked gets "🎬 <Title> is now on NAIJA TR", once.
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

  const queue = [...waiting]
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { item, meta } = next
      const ep = meta.ep && EP.test(meta.ep) ? meta.ep : null
      const { available, reason } = await checkPlayable(env.nextstream, playPath(item, ep), fetchImpl)
      if (reason === 'not-configured') {
        summary.error = 'NextStream isn’t set up (NEXTSTREAM_*): titles can’t be checked'
        queue.length = 0
        return
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
      const title = await nameOf(env, item, meta.title ?? '', fetchImpl)
      const users = await redis(env, [['SMEMBERS', usersKey(item)]], fetchImpl)
      const ids = (Array.isArray(users?.[0]) ? (users[0] as unknown[]) : []).map(String)
      let emailed = 0
      if (ids.length > 0 && env.resendKey && env.resendFrom && env.supabaseUrl && env.supabaseKey) {
        const emails = await emailsOf(env, ids, fetchImpl)
        emailed = await sendEmails(env, emails, availableEmail(env, title, item), fetchImpl)
        // Nobody could be emailed (Resend down): they stay for the next check.
        if (emails.length > 0 && emailed === 0) {
          summary.unknown++
          continue
        }
      }
      await redis(env, [['HSET', metaKey(item), 'availableAt', now, 'emailed', (Number(meta.emailed) || 0) + emailed], ['DEL', usersKey(item)]], fetchImpl)
      summary.nowPlaying.push({ item, title, emailed })
    }
  }
  await Promise.all(Array.from({ length: CHECK_PARALLEL }, worker))

  if (summary.nowPlaying.length > 0) {
    const lines = summary.nowPlaying.map(({ title, emailed }) => `✅ ${title}: playing now${emailed ? ` (emailed ${emailed})` : ''}`)
    await telegram(env, ['🎬 Requested titles now on NAIJA TR', ...lines].join('\n'), fetchImpl)
  }
  return summary
}
