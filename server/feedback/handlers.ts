/**
 * Feedback and ratings from visitors, for the Vercel function
 * api/feedback/[action].ts:
 *
 * - POST /api/feedback/send   saves one item (the Feedback form, or a "Rate
 *   this" rating on a title) in Upstash Redis and forwards it to the admin on
 *   Telegram (@naijatr_bot → ADMIN_TELEGRAM_CHAT_ID). A Telegram failure
 *   doesn't lose the item.
 * - GET  /api/feedback/list   (admin) the newest items, average rating and
 *   the most requested titles.
 * - POST /api/feedback/update (admin) marks an item done/not done or deletes it.
 *
 * Nothing personal is kept: no IP address, only what the form asks for, the
 * page, a device type (mobile/desktop) and the time. Spam protection: a
 * hidden honeypot field, 3 messages (and 20 ratings) a day per device, HTML
 * and links stripped, empty or long messages refused.
 *
 * Redis (server/redis.ts):
 * - feedback:items          sorted set of item ids by time (ms)
 * - feedback:item:<id>      the item (JSON)
 * - feedback:limit:<kind>:<device>:<day>   today's count for a device
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAdmin } from '../live/handlers.js'
import { hasRedis, readRedisEnv, redis, type RedisEnv } from '../redis.js'

export const FEEDBACK_TYPES = ['review', 'bug', 'request', 'other', 'rating'] as const
export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

const TYPE_LABEL: Record<FeedbackType, string> = {
  review: 'Review',
  bug: 'Bug',
  request: 'Request',
  other: 'Other',
  rating: 'Rating',
}

export const MAX_MESSAGE = 500
const MAX_NAME = 60
const MAX_TITLE = 120
const MAX_PAGE = 200
/** Messages a device may send a day (the Feedback form)... */
export const DAILY_MESSAGES = 3
/** ...and "Rate this" ratings. */
export const DAILY_RATINGS = 20
const LIST_SIZE = 300
const TELEGRAM_TIMEOUT_MS = 5000

const ITEMS_KEY = 'feedback:items'
const itemKey = (id: string) => `feedback:item:${id}`
const limitKey = (kind: string, device: string, day: string) => `feedback:limit:${kind}:${device}:${day}`

const DEVICE = /^[A-Za-z0-9_-]{16,64}$/
const ITEM_ID = /^[a-z0-9]{8,40}$/

export interface FeedbackEnv extends RedisEnv {
  adminPassword: string
  telegramToken: string
  telegramChatId: string
}

export function readFeedbackEnv(env: Record<string, string | undefined>): FeedbackEnv {
  return {
    ...readRedisEnv(env),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
    telegramChatId: env.ADMIN_TELEGRAM_CHAT_ID?.trim() ?? '',
  }
}

export interface FeedbackItem {
  id: string
  type: FeedbackType
  rating: number | null
  message: string
  name: string
  page: string
  title: string
  device: 'mobile' | 'desktop'
  at: number
  done: boolean
}

/** Plain text only: no HTML tags, no links, no control characters, single-spaced. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ng|xyz|info|ru|co|me|tv|link|site|online|top|app)(?:\/\S*)?/gi, ' ')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

export type ParsedFeedback =
  | { ok: true; spam: false; item: Omit<FeedbackItem, 'id' | 'at' | 'done'>; deviceId: string }
  | { ok: true; spam: true }
  | { ok: false; error: 'bad-request' | 'empty' | 'too-long' }

/** A submission from the site, checked and cleaned. */
export function parseFeedback(body: unknown): ParsedFeedback {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad-request' }
  // The honeypot: a field people never see, so only bots fill it in.
  if (typeof b.website === 'string' && b.website.trim()) return { ok: true, spam: true }
  const type = b.type as FeedbackType
  if (!FEEDBACK_TYPES.includes(type)) return { ok: false, error: 'bad-request' }
  const deviceId = typeof b.device === 'string' && DEVICE.test(b.device) ? b.device : ''
  if (!deviceId) return { ok: false, error: 'bad-request' }
  const rating = b.rating === undefined || b.rating === null ? null : Number(b.rating)
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return { ok: false, error: 'bad-request' }
  if (typeof b.message === 'string' && b.message.trim().length > MAX_MESSAGE) return { ok: false, error: 'too-long' }
  const message = cleanText(b.message, MAX_MESSAGE)
  const title = cleanText(b.title, MAX_TITLE)
  if (type === 'rating') {
    if (rating === null || !title) return { ok: false, error: 'bad-request' }
  } else if (!message) {
    return { ok: false, error: 'empty' }
  }
  const page = typeof b.page === 'string' && b.page.startsWith('/') ? b.page.slice(0, MAX_PAGE) : '/'
  return {
    ok: true,
    spam: false,
    deviceId,
    item: {
      type,
      rating,
      message,
      name: cleanText(b.name, MAX_NAME),
      page,
      title,
      device: b.mobile === true ? 'mobile' : 'desktop',
    },
  }
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)
const newId = (at: number) => `${at.toString(36)}${randomBytes(5).toString('hex')}`

/** The Telegram message for an item. */
export function telegramText(item: FeedbackItem): string {
  const time = new Date(item.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })
  const head = [item.rating ? `⭐ ${item.rating}/5` : null, TYPE_LABEL[item.type], item.device].filter(Boolean).join(' · ')
  return [
    head,
    item.title ? `🎬 ${item.title}` : null,
    item.message ? `"${item.message}"` : null,
    item.name ? `From: ${item.name}` : null,
    `Page: ${item.page} · ${time}`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function sendToTelegram(env: FeedbackEnv, item: FeedbackItem, fetchImpl: typeof fetch) {
  if (!env.telegramToken || !env.telegramChatId) return false
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.telegramChatId, text: telegramText(item), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

export type SendResult =
  | { status: 200; body: { ok: true } }
  | { status: 400 | 429 | 503; body: { error: string } }

/** Saves one submission and tells the admin on Telegram. */
export async function saveFeedback(env: FeedbackEnv, body: unknown, now: number, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const parsed = parseFeedback(body)
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
  // Bots get the same answer as people, and nothing is saved.
  if (parsed.spam) return { status: 200, body: { ok: true } }
  if (!hasRedis(env)) return { status: 503, body: { error: 'not-configured' } }

  const kind = parsed.item.type === 'rating' ? 'rating' : 'message'
  const key = limitKey(kind, parsed.deviceId, day(now))
  const counted = await redis(env, [['INCR', key], ['EXPIRE', key, 2 * 24 * 60 * 60]], fetchImpl)
  if (!counted) return { status: 503, body: { error: 'store-unavailable' } }
  if (Number(counted[0]) > (kind === 'rating' ? DAILY_RATINGS : DAILY_MESSAGES)) return { status: 429, body: { error: 'limit' } }

  const item: FeedbackItem = { ...parsed.item, id: newId(now), at: now, done: false }
  const saved = await redis(env, [['SET', itemKey(item.id), JSON.stringify(item)], ['ZADD', ITEMS_KEY, now, item.id]], fetchImpl)
  if (!saved) return { status: 503, body: { error: 'store-unavailable' } }
  await sendToTelegram(env, item, fetchImpl)
  return { status: 200, body: { ok: true } }
}

const parseItem = (value: unknown): FeedbackItem | null => {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value) as FeedbackItem
  } catch {
    return null
  }
}

/** A request's wording, for grouping requests for the same title. */
const requestKey = (message: string) =>
  message
    .toLowerCase()
    .replace(/\b(please|pls|plz|add|upload|the|movie|series|season|i want|can you|kindly)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export interface FeedbackSummary {
  items: FeedbackItem[]
  total: number
  averageRating: number | null
  ratings: number
  topRequests: { text: string; count: number }[]
}

export function summarise(items: FeedbackItem[]): FeedbackSummary {
  const rated = items.filter((i) => i.rating !== null)
  const requests = new Map<string, { text: string; count: number }>()
  for (const item of items) {
    if (item.type !== 'request') continue
    const key = requestKey(item.message)
    if (!key) continue
    const entry = requests.get(key) ?? { text: item.message.slice(0, 80), count: 0 }
    entry.count += 1
    requests.set(key, entry)
  }
  return {
    items,
    total: items.length,
    averageRating: rated.length ? Math.round((rated.reduce((sum, i) => sum + (i.rating ?? 0), 0) / rated.length) * 10) / 10 : null,
    ratings: rated.length,
    topRequests: [...requests.values()].sort((a, b) => b.count - a.count).slice(0, 10),
  }
}

/** The newest items (up to LIST_SIZE), newest first. */
export async function listFeedback(env: RedisEnv, fetchImpl: typeof fetch = fetch): Promise<FeedbackItem[] | null> {
  const ids = (await redis(env, [['ZRANGE', ITEMS_KEY, 0, LIST_SIZE - 1, 'REV']], fetchImpl))?.[0]
  if (!Array.isArray(ids)) return null
  if (!ids.length) return []
  const values = (await redis(env, [['MGET', ...ids.map((id) => itemKey(String(id)))]], fetchImpl))?.[0]
  if (!Array.isArray(values)) return null
  return values.map(parseItem).filter((item): item is FeedbackItem => item !== null)
}

/** Marks an item done (or not), or deletes it. */
export async function updateFeedback(
  env: RedisEnv,
  id: string,
  action: 'done' | 'undone' | 'delete',
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (action === 'delete') return (await redis(env, [['DEL', itemKey(id)], ['ZREM', ITEMS_KEY, id]], fetchImpl)) !== null
  const item = parseItem((await redis(env, [['GET', itemKey(id)]], fetchImpl))?.[0])
  if (!item) return false
  item.done = action === 'done'
  return (await redis(env, [['SET', itemKey(id), JSON.stringify(item)]], fetchImpl)) !== null
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
    if (raw.length > 4096) throw new Error('too large')
  }
  return JSON.parse(raw || 'null')
}

/** Serves /api/feedback/{send,list,update}. */
export async function handleFeedback(
  env: FeedbackEnv,
  action: string,
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  const post = req.method === 'POST'
  if (action === 'send') {
    if (!post) return sendJson(res, 405, { error: 'method' })
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      return sendJson(res, 400, { error: 'bad-request' })
    }
    const result = await saveFeedback(env, body, now, fetchImpl)
    return sendJson(res, result.status, result.body)
  }
  if (action !== 'list' && action !== 'update') return sendJson(res, 404, { error: 'not-found' })
  if (action === 'list' ? req.method !== 'GET' : !post) return sendJson(res, 405, { error: 'method' })
  if (!env.adminPassword) return sendJson(res, 503, { error: 'not-configured' })
  if (!isAdmin({ ...env, adminPassword: env.adminPassword }, req.headers?.authorization)) {
    return sendJson(res, 401, { error: 'unauthorized' })
  }
  if (!hasRedis(env)) return sendJson(res, 503, { error: 'no-store' })

  if (action === 'list') {
    const items = await listFeedback(env, fetchImpl)
    return items ? sendJson(res, 200, { ...summarise(items), telegram: Boolean(env.telegramToken && env.telegramChatId) }) : sendJson(res, 502, { error: 'store-unavailable' })
  }
  let body: { id?: unknown; action?: unknown }
  try {
    body = ((await readJsonBody(req)) ?? {}) as typeof body
  } catch {
    return sendJson(res, 400, { error: 'bad-request' })
  }
  const id = typeof body.id === 'string' && ITEM_ID.test(body.id) ? body.id : ''
  const change = body.action
  if (!id || (change !== 'done' && change !== 'undone' && change !== 'delete')) return sendJson(res, 400, { error: 'bad-request' })
  return (await updateFeedback(env, id, change, fetchImpl)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not-found' })
}
