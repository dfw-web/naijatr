import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAdmin, lagosDay } from '../live/handlers.js'
import { promoInfo, readPromo, type PromoInfo, type PromoWindow } from '../promo.js'

/**
 * /api/account/{delete,stats}: the parts of the optional accounts that need
 * Supabase's service role key, which never leaves the server.
 *
 * - POST /api/account/delete (the user's own access token): deletes the login;
 *   the database deletes its rows with it (on delete cascade).
 * - GET /api/account/stats (ADMIN_PASSWORD): registered users, today's
 *   sign-ups (Lagos time) and, with a Free Ad-Free Week set (PROMO_START,
 *   PROMO_END), its state and the sign-ups since it started, for /admin/live.
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
  sendJson(res, 404, { error: 'not-found' })
}
