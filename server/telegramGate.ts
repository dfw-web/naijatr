/**
 * The Telegram gate's server side (/api/telegram/*), shared by the Vercel
 * function in api/telegram/ and the Vite dev/preview server:
 *
 * - config:  the bot's public numeric id, for the Login Widget's popup.
 * - verify:  checks a Telegram Login Widget login, then asks the Bot API
 *            whether that user is in the channel; if so, returns a gate token.
 * - recheck: the same membership check for a gate token issued earlier.
 *
 * A gate token holds only the Telegram user id and when membership was last
 * confirmed, signed with NAIJATR_GATE_SECRET. TELEGRAM_BOT_TOKEN never leaves
 * the server and is never logged.
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const GATE_CHANNEL = '@naijatr'
export const GATE_COOKIE = 'naijatr_gate'
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60
/** Telegram logins older than this are refused. */
const MAX_AUTH_AGE_S = 24 * 60 * 60
const TELEGRAM_TIMEOUT_MS = 8000

export interface GateEnv {
  botToken: string
  secret: string
}

export function readGateEnv(env: Record<string, string | undefined>): GateEnv {
  return {
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
    secret: env.NAIJATR_GATE_SECRET?.trim() ?? '',
  }
}

/** What the browser is told. "unavailable": Telegram (or our setup) failed, so let the visitor through. */
export type GateStatus = 'joined' | 'not-joined' | 'invalid' | 'unavailable'

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Checks a Telegram Login Widget result (https://core.telegram.org/widgets/login#checking-authorization).
 * Returns the Telegram user id, or null if the hash is wrong or the login is too old.
 */
export function checkTelegramLogin(
  data: Record<string, unknown>,
  botToken: string,
  nowS = Math.floor(Date.now() / 1000),
): number | null {
  const { hash, ...fields } = data
  if (typeof hash !== 'string' || !botToken) return null
  const checkString = Object.keys(fields)
    .filter((key) => typeof fields[key] === 'string' || typeof fields[key] === 'number')
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n')
  const secretKey = createHash('sha256').update(botToken).digest()
  const expected = createHmac('sha256', secretKey).update(checkString).digest('hex')
  if (!sameText(expected, hash.toLowerCase())) return null
  const authDate = Number(fields.auth_date)
  // A few minutes' allowance for clocks running ahead.
  if (!Number.isFinite(authDate) || nowS - authDate > MAX_AUTH_AGE_S || authDate - nowS > 300) return null
  const id = Number(fields.id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** A gate token: "<payload>.<signature>", the payload being {uid, iat} (iat: last confirmed, in seconds). */
export function signGateToken(uid: number, secret: string, nowS = Math.floor(Date.now() / 1000)): string {
  const payload = b64url(JSON.stringify({ uid, iat: nowS }))
  return `${payload}.${b64url(createHmac('sha256', secret).update(payload).digest())}`
}

export function readGateToken(token: unknown, secret: string): { uid: number; iat: number } | null {
  if (typeof token !== 'string' || !secret) return null
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) return null
  if (!sameText(b64url(createHmac('sha256', secret).update(payload).digest()), signature)) return null
  try {
    const { uid, iat } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { uid?: unknown; iat?: unknown }
    return typeof uid === 'number' && typeof iat === 'number' ? { uid, iat } : null
  } catch {
    return null
  }
}

/** Asks the Bot API whether the user is in the channel. "unavailable" when Telegram can't say. */
export async function channelMembership(
  botToken: string,
  uid: number,
  fetchFn: typeof fetch = fetch,
): Promise<'joined' | 'not-joined' | 'unavailable'> {
  const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(GATE_CHANNEL)}&user_id=${uid}`
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) })
    const body = (await response.json()) as {
      ok?: boolean
      description?: string
      result?: { status?: string; is_member?: boolean }
    }
    if (!body.ok) {
      // Telegram doesn't know this user in the channel at all: not a member.
      return /user not found|PARTICIPANT_ID_INVALID/i.test(body.description ?? '') ? 'not-joined' : 'unavailable'
    }
    const { status, is_member: isMember } = body.result ?? {}
    if (status === 'creator' || status === 'administrator' || status === 'member') return 'joined'
    if (status === 'restricted') return isMember ? 'joined' : 'not-joined'
    if (status === 'left' || status === 'kicked') return 'not-joined'
    return 'unavailable'
  } catch {
    // Network error or timeout. Nothing is logged: the request URL holds the bot token.
    return 'unavailable'
  }
}

const gateCookie = (token: string | null) =>
  token
    ? `${GATE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; Secure; SameSite=Lax`
    : `${GATE_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`

const sendJson = (res: ServerResponse, status: number, body: unknown, cookie?: string) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  // Set from the server, so Safari keeps it for the full year (script-set cookies last 7 days).
  if (cookie) res.setHeader('Set-Cookie', cookie)
  res.end(JSON.stringify(body))
}

/** The request's JSON body (Vercel may have parsed it already). */
export async function readJsonBody(req: IncomingMessage & { body?: unknown }): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>
  if (typeof req.body === 'string') return JSON.parse(req.body) as Record<string, unknown>
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 10_000) throw new Error('Body too large')
  }
  const parsed: unknown = raw ? JSON.parse(raw) : {}
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

/** The last path segment: /api/telegram/verify → "verify". */
export const gateAction = (rawUrl: string) =>
  new URL(rawUrl, 'http://localhost').pathname.replace(/\/+$/, '').split('/').pop() ?? ''

export async function handleGate(
  env: GateEnv,
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  fetchFn: typeof fetch = fetch,
  nowS = Math.floor(Date.now() / 1000),
): Promise<void> {
  const action = gateAction(req.url ?? '')
  const configured = Boolean(env.botToken && env.secret)

  if (action === 'config' && req.method === 'GET') {
    // The numeric bot id is public (Telegram's own widget shows it); the rest of the token is not.
    const botId = configured ? Number(env.botToken.split(':')[0]) || null : null
    return sendJson(res, 200, botId ? { botId } : { status: 'unavailable' })
  }
  if ((action !== 'verify' && action !== 'recheck') || req.method !== 'POST') {
    return sendJson(res, 404, { error: 'Not found' })
  }

  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { status: 'invalid' satisfies GateStatus })
  }
  if (!configured) return sendJson(res, 200, { status: 'unavailable' satisfies GateStatus })

  let uid: number | null
  if (action === 'verify') {
    uid = checkTelegramLogin(body, env.botToken, nowS)
  } else {
    uid = readGateToken(body.token, env.secret)?.uid ?? null
  }
  if (uid === null) return sendJson(res, 400, { status: 'invalid' satisfies GateStatus }, action === 'recheck' ? gateCookie(null) : undefined)

  const membership = await channelMembership(env.botToken, uid, fetchFn)
  if (membership === 'joined') {
    const token = signGateToken(uid, env.secret, nowS)
    return sendJson(res, 200, { status: 'joined' satisfies GateStatus, token }, gateCookie(token))
  }
  if (membership === 'not-joined') {
    return sendJson(res, 200, { status: 'not-joined' satisfies GateStatus }, action === 'recheck' ? gateCookie(null) : undefined)
  }
  return sendJson(res, 200, { status: 'unavailable' satisfies GateStatus })
}
