import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAdmin, lagosDay } from '../live/handlers.js'
import { promoInfo, readPromo, type PromoInfo, type PromoWindow } from '../promo.js'
import { normalizeEmail } from '../referral/rules.js'

/**
 * /api/account/{delete,stats,email-status}: the parts of the optional accounts that need
 * Supabase's service role key, which never leaves the server.
 *
 * - POST /api/account/delete (the user's own access token): deletes the login;
 *   the database deletes its rows with it (on delete cascade).
 * - GET /api/account/stats (ADMIN_PASSWORD): registered users, today's
 *   sign-ups (Lagos time) and, with a Free Ad-Free Week set (PROMO_START,
 *   PROMO_END), its state and the sign-ups since it started, for /admin/live.
 * - POST /api/account/email-status { email }: before "Create account" sends
 *   anything, whether that inbox already has a login (Gmail dots and +tags
 *   ignored): { status: 'new' }, or 'confirmed' / 'unconfirmed' with the
 *   login's own address (to log in with, or resend to). Never sends an email,
 *   never creates anything. At most EMAIL_CHECKS_PER_MINUTE per IP.
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY in Vercel (Settings → Environment
 * Variables, Production + Preview). No VITE_ prefix: it must never reach the
 * browser. Without it both answer 503 { error: 'not-configured' }.
 */

export interface AccountEnv {
  url: string
  serviceKey: string
  adminPassword: string
  promo: PromoWindow | null
}

export function readAccountEnv(env: Record<string, string | undefined>): AccountEnv {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    serviceKey: (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    promo: readPromo(env),
  }
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

const asService = (env: AccountEnv) => ({ apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` })

/** The user an access token belongs to, checked by Supabase itself. */
async function userOf(env: AccountEnv, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  const response = await fetchImpl(`${env.url}/auth/v1/user`, { headers: { apikey: env.serviceKey, Authorization: `Bearer ${token}` } })
  if (!response.ok) return null
  const body = (await response.json().catch(() => null)) as { id?: unknown } | null
  return typeof body?.id === 'string' ? body.id : null
}

export interface AccountCounts {
  users: number
  today: number
  /** The Free Ad-Free Week, with the accounts made since it started (up to now, or its end). */
  promo: (PromoInfo & { signups: number }) | null
}

/** Registered users, today's sign-ups and the promo's; reads at most 10 pages of 1000. */
export async function countUsers(env: AccountEnv, now: number, fetchImpl: typeof fetch): Promise<AccountCounts | null> {
  const today = lagosDay(now)
  let users = 0
  let signups = 0
  let promoSignups = 0
  const promo = env.promo
  for (let page = 1; page <= 10; page++) {
    const response = await fetchImpl(`${env.url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: asService(env) })
    if (!response.ok) return null
    const body = (await response.json().catch(() => null)) as { users?: { created_at?: string }[] } | null
    const list = body?.users ?? []
    users += list.length
    signups += list.filter((user) => user.created_at && lagosDay(Date.parse(user.created_at)) === today).length
    if (promo) {
      promoSignups += list.filter((user) => {
        const at = user.created_at ? Date.parse(user.created_at) : NaN
        return at >= promo.start && at <= promo.end
      }).length
    }
    if (list.length < 1000) break
  }
  const info = promoInfo(promo, now)
  return { users, today: signups, promo: info ? { ...info, signups: promoSignups } : null }
}

export type EmailStatus = { status: 'new' } | { status: 'confirmed' | 'unconfirmed'; email: string }

interface AuthUser {
  id?: string
  email?: string | null
  email_confirmed_at?: string | null
  confirmed_at?: string | null
}

const isConfirmed = (user: AuthUser) => Boolean(user.email_confirmed_at || user.confirmed_at)

/** The best of several logins for one inbox: a confirmed one first. */
function pick(users: AuthUser[]): EmailStatus {
  const withEmail = users.filter((user) => user.email)
  if (withEmail.length === 0) return { status: 'new' }
  const confirmed = withEmail.find(isConfirmed)
  const chosen = confirmed ?? withEmail[0]
  return { status: confirmed ? 'confirmed' : 'unconfirmed', email: chosen.email! }
}

/**
 * Whether `email`'s inbox already has a login: first through profiles.email_normalized
 * (every account that has signed in since referrals started), then every login,
 * 1000 at a time (at most 20 pages), compared with Gmail dots and +tags ignored.
 */
export async function emailStatus(env: AccountEnv, email: string, fetchImpl: typeof fetch): Promise<EmailStatus> {
  const wanted = normalizeEmail(email)
  const rows = await fetchImpl(
    `${env.url}/rest/v1/profiles?select=user_id&email_normalized=eq.${encodeURIComponent(wanted)}&limit=5`,
    { headers: asService(env) },
  )
  if (rows.ok) {
    const list = ((await rows.json().catch(() => [])) as { user_id?: string }[]) ?? []
    const found: AuthUser[] = []
    for (const row of list) {
      if (!row.user_id) continue
      const response = await fetchImpl(`${env.url}/auth/v1/admin/users/${encodeURIComponent(row.user_id)}`, { headers: asService(env) })
      if (!response.ok) continue
      const user = (await response.json().catch(() => null)) as AuthUser | null
      if (user?.email && normalizeEmail(user.email) === wanted) found.push(user)
    }
    if (found.length > 0) return pick(found)
  }
  const matches: AuthUser[] = []
  for (let page = 1; page <= 20; page++) {
    const response = await fetchImpl(`${env.url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: asService(env) })
    if (!response.ok) throw new Error(`supabase ${response.status}`)
    const body = (await response.json().catch(() => null)) as { users?: AuthUser[] } | null
    const users = body?.users ?? []
    for (const user of users) if (user.email && normalizeEmail(user.email) === wanted) matches.push(user)
    if (users.length < 1000) break
  }
  return pick(matches)
}

/** Email checks per IP per minute (each instance counts its own). */
export const EMAIL_CHECKS_PER_MINUTE = 20
const checks = new Map<string, { minute: number; count: number }>()

function allowCheck(ip: string, now: number): boolean {
  const minute = Math.floor(now / 60_000)
  const entry = checks.get(ip)
  if (!entry || entry.minute !== minute) {
    if (checks.size > 5000) checks.clear()
    checks.set(ip, { minute, count: 1 })
    return true
  }
  entry.count += 1
  return entry.count <= EMAIL_CHECKS_PER_MINUTE
}

/** Test helper. */
export const resetEmailChecks = () => checks.clear()

const clientIp = (req: IncomingMessage) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || String(req.headers['x-real-ip'] ?? '') || req.socket?.remoteAddress || 'unknown'

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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function handleAccount(
  env: AccountEnv,
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  if (action === 'delete') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    if (!env.url || !env.serviceKey) return sendJson(res, 503, { error: 'not-configured' })
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!token) return sendJson(res, 401, { error: 'unauthorized' })
    const userId = await userOf(env, token, fetchImpl).catch(() => null)
    if (!userId) return sendJson(res, 401, { error: 'unauthorized' })
    const response = await fetchImpl(`${env.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: asService(env),
    }).catch(() => null)
    return response?.ok ? sendJson(res, 200, { deleted: true }) : sendJson(res, 502, { error: 'upstream' })
  }
  if (action === 'stats') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' })
    if (!isAdmin({ redisUrl: '', redisToken: '', adminPassword: env.adminPassword }, req.headers.authorization)) {
      return sendJson(res, 401, { error: 'unauthorized' })
    }
    if (!env.url || !env.serviceKey) return sendJson(res, 503, { error: 'not-configured' })
    const counts = await countUsers(env, now, fetchImpl).catch(() => null)
    return counts ? sendJson(res, 200, counts) : sendJson(res, 502, { error: 'upstream' })
  }
  if (action === 'email-status') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    if (!env.url || !env.serviceKey) return sendJson(res, 503, { error: 'not-configured' })
    if (!allowCheck(clientIp(req), now)) return sendJson(res, 429, { error: 'rate' })
    let email = ''
    try {
      const body = (await readJsonBody(req)) as { email?: unknown } | null
      email = typeof body?.email === 'string' ? body.email.trim() : ''
    } catch {
      // Below.
    }
    if (!email || email.length > 254 || !EMAIL.test(email)) return sendJson(res, 400, { error: 'email' })
    const result = await emailStatus(env, email, fetchImpl).catch(() => null)
    return result ? sendJson(res, 200, result) : sendJson(res, 502, { error: 'upstream' })
  }
  sendJson(res, 404, { error: 'not-found' })
}
