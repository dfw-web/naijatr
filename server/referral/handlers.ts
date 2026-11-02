import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAdmin } from '../live/handlers.js'
import {
  adFreeState,
  checkClaim,
  checkCount,
  extendAdFree,
  hashIp,
  isInviteCode,
  lagosDayStart,
  lagosWeek,
  newInviteCode,
  normalizeEmail,
  rankWeek,
  readReferralConfig,
  rewardsDue,
  weekOf,
  weeklyWinner,
  type ReferralConfig,
} from './rules.js'
import { supabaseStore, type AuthUser, type Profile, type ReferralStore } from './store.js'

/**
 * /api/referral/*: the account-based referral program and the ad-free reward.
 *
 * - GET  status (or ad-free): the signed-in user's ad-free state (checked here,
 *   from their session: the browser can't fake it), invite code and progress.
 *   Without a session: just the goal.
 * - POST claim { code, openedAt }: a new account attaches the invite link it came by.
 * - POST watched: the invited account played a movie, episode or match: the
 *   referral counts (email confirmed, within the network's daily limit), and
 *   every `goal` counted referrals adds ad-free time to the referrer.
 * - GET  admin?week=YYYY-MM-DD / POST decide (ADMIN_PASSWORD): /admin/referrals.
 *
 * Needs SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.
 * Optional: AD_FREE_EMAILS, AD_FREE_DAYS, REFERRAL_GOAL, REFERRAL_IP_DAILY_LIMIT,
 * REFERRAL_SALT, and RESEND_API_KEY + RESEND_FROM for the unlock email.
 */

export interface ReferralEnv {
  url: string
  serviceKey: string
  adminPassword: string
  siteUrl: string
  resendKey: string
  resendFrom: string
  config: ReferralConfig
}

export function readReferralEnv(env: Record<string, string | undefined>): ReferralEnv {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    serviceKey: (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    siteUrl: (env.SITE_URL || 'https://www.naijatr.com').replace(/\/+$/, ''),
    resendKey: (env.RESEND_API_KEY ?? '').trim(),
    resendFrom: (env.RESEND_FROM ?? '').trim(),
    config: readReferralConfig(env),
  }
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 4096) return {}
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]

/** The visitor's IP (Vercel puts it first in x-forwarded-for); only ever hashed. */
const clientIp = (req: IncomingMessage) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || String(req.headers['x-real-ip'] ?? '') || req.socket?.remoteAddress || 'unknown'

/** The user's profile with an invite code, their normalized email and network noted (written only when changed). */
async function ensureProfile(store: ReferralStore, user: AuthUser, ipHash: string): Promise<Profile> {
  let profile = await store.getProfile(user.id)
  const emailNormalized = normalizeEmail(user.email)
  if (profile && profile.invite_code && profile.email_normalized === emailNormalized && profile.last_ip_hash === ipHash) return profile
  const patch: Partial<Profile> = { email_normalized: emailNormalized, last_ip_hash: ipHash }
  if (profile?.invite_code) return store.saveProfile(user.id, patch)
  // A new code; tried again on the rare clash with someone else's.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      profile = await store.saveProfile(user.id, { ...patch, invite_code: newInviteCode() })
      if (profile) return profile
    } catch {
      // Taken: another code.
    }
  }
  throw new Error('no invite code')
}

/** Gives the referrer every unlock they've earned (stacked), once each even with two counts at the same moment. */
export async function grantRewards(env: ReferralEnv, store: ReferralStore, referrerId: string, now: number, fetchImpl: typeof fetch): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const profile = await store.getProfile(referrerId)
    if (!profile) return 0
    const counted = (await store.referralsOf(referrerId)).filter((r) => r.status === 'counted').length
    const due = rewardsDue(counted, profile.rewards_granted, env.config.goal)
    if (due === 0) return 0
    const until = extendAdFree(profile.ad_free_until, now, env.config.adFreeDays, due)
    if (await store.grantReward(referrerId, profile.rewards_granted, profile.rewards_granted + due, until)) {
      await sendUnlockEmail(env, store, referrerId, fetchImpl).catch(() => undefined)
      return due
    }
  }
  return 0
}

/** "You've unlocked NAIJA TR ad-free!" by email, when Resend is set up (RESEND_API_KEY, RESEND_FROM). */
async function sendUnlockEmail(env: ReferralEnv, store: ReferralStore, userId: string, fetchImpl: typeof fetch) {
  if (!env.resendKey || !env.resendFrom) return
  const email = await store.emailOf(userId)
  if (!email) return
  await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.resendFrom,
      to: [email],
      subject: '🎉 You’ve unlocked NAIJA TR ad-free!',
      text: `Your friends joined NAIJA TR, so you've unlocked the ad-free version. Enjoy! Sign in on any device to watch without ads.\n\nKeep inviting: ${env.siteUrl}/invite`,
    }),
  })
}

export async function handleReferral(
  env: ReferralEnv,
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
  options: { store?: ReferralStore; fetchImpl?: typeof fetch; now?: number } = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now()
  const configured = Boolean(env.url && env.serviceKey)
  const store = options.store ?? (configured ? supabaseStore({ url: env.url, serviceKey: env.serviceKey }, fetchImpl) : null)
  const { goal } = env.config

  try {
    if (action === 'admin' || action === 'decide') return await handleAdmin(env, action, req, res, store, now)

    if (action === 'status' || action === 'ad-free') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' })
      const token = bearer(req)
      if (!token || !store) return sendJson(res, 200, { goal, signedIn: false, adFree: false })
      const user = await store.userFromToken(token)
      if (!user) return sendJson(res, 401, { error: 'unauthorized', goal })
      const profile = await ensureProfile(store, user, hashIp(env.config.salt, clientIp(req)))
      const ad = adFreeState(user.email, profile.ad_free_until, env.config, now)
      const referrals = await store.referralsOf(user.id)
      const counted = referrals.filter((r) => r.status === 'counted')
      const week = lagosWeek(now)
      return sendJson(res, 200, {
        goal,
        signedIn: true,
        userId: user.id,
        adFree: ad.adFree,
        adFreeUntil: ad.until,
        permanent: ad.permanent,
        code: profile.invite_code,
        link: `${env.siteUrl}/r/${profile.invite_code}`,
        counted: counted.length,
        pending: referrals.filter((r) => r.status === 'pending' || r.status === 'held').length,
        weekCount: counted.filter((r) => r.counted_at && Date.parse(r.counted_at) >= week.start && Date.parse(r.counted_at) < week.end).length,
        rewards: profile.rewards_granted,
      })
    }

    if (action === 'claim' || action === 'watched') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
      if (!store) return sendJson(res, 503, { error: 'not-configured' })
      const token = bearer(req)
      const user = token ? await store.userFromToken(token) : null
      if (!user) return sendJson(res, 401, { error: 'unauthorized' })
      const ipHash = hashIp(env.config.salt, clientIp(req))

      if (action === 'claim') {
        const body = await readBody(req)
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
        if (!isInviteCode(code)) return sendJson(res, 400, { error: 'code' })
        const [referrer, existing] = await Promise.all([store.profileByCode(code), store.referralOf(user.id)])
        const emailNormalized = normalizeEmail(user.email)
        const verdict = checkClaim({
          userId: user.id,
          email: user.email,
          createdAt: user.createdAt,
          openedAt: typeof body.openedAt === 'number' ? body.openedAt : null,
          referrer: referrer ? { userId: referrer.user_id, emailNormalized: referrer.email_normalized } : null,
          inboxTaken: await store.inboxTaken(emailNormalized, user.id),
          alreadyReferred: existing !== null,
          now,
        })
        // The new account's own profile (its code, and its inbox for later duplicate checks).
        await ensureProfile(store, user, ipHash)
        if (!verdict.ok) {
          if (verdict.record && referrer) {
            await store.insertReferral({ referrer_id: referrer.user_id, referred_user_id: user.id, status: 'rejected', reason: verdict.reason, ip_hash: ipHash })
          }
          return sendJson(res, 200, { status: existing?.status ?? 'rejected', reason: verdict.reason })
        }
        const row = await store.insertReferral({ referrer_id: referrer!.user_id, referred_user_id: user.id, status: 'pending', reason: null, ip_hash: ipHash })
        return sendJson(res, 200, { status: row ? 'pending' : 'rejected', reason: row ? null : 'already' })
      }

      // watched
      const referral = await store.referralOf(user.id)
      if (!referral) return sendJson(res, 200, { status: 'none' })
      if (referral.status !== 'pending') return sendJson(res, 200, { status: referral.status })
      const [fromIp, referrer, siblings] = await Promise.all([
        store.countedFromIp(ipHash, new Date(lagosDayStart(now)).toISOString()),
        store.getProfile(referral.referrer_id),
        store.referralsOf(referral.referrer_id),
      ])
      const verdict = checkCount({
        status: referral.status,
        emailConfirmed: user.emailConfirmed,
        countedFromIpToday: fromIp,
        referrerSameIp: referrer?.last_ip_hash === ipHash,
        siblingsSameIp: siblings.filter((r) => r.id !== referral.id && r.ip_hash === ipHash).length,
        claimsLastHour: siblings.filter((r) => Date.parse(r.created_at) > now - 60 * 60_000).length,
        ipDailyLimit: env.config.ipDailyLimit,
      })
      if (verdict.result === 'skip') return sendJson(res, 200, { status: referral.status })
      const changed = await store.updateReferral(referral.id, 'pending', {
        status: verdict.result,
        flags: verdict.flags,
        ip_hash: ipHash,
        counted_at: verdict.result === 'counted' ? new Date(now).toISOString() : null,
      })
      if (changed && verdict.result === 'counted') await grantRewards(env, store, referral.referrer_id, now, fetchImpl)
      return sendJson(res, 200, { status: changed ? verdict.result : 'counted' })
    }
  } catch {
    return sendJson(res, 502, { error: 'upstream' })
  }
  sendJson(res, 404, { error: 'not-found' })
}

async function handleAdmin(env: ReferralEnv, action: string, req: IncomingMessage, res: ServerResponse, store: ReferralStore | null, now: number) {
  if (!isAdmin({ redisUrl: '', redisToken: '', adminPassword: env.adminPassword }, req.headers.authorization)) {
    return sendJson(res, 401, { error: 'unauthorized' })
  }
  if (!store) return sendJson(res, 503, { error: 'not-configured' })
  const url = new URL(req.url ?? '', 'http://localhost')

  if (action === 'decide') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const body = await readBody(req)
    const week = typeof body.week === 'string' ? weekOf(body.week) : null
    const userId = typeof body.userId === 'string' ? body.userId : ''
    const decision = body.decision
    if (!week || !userId || !['winner', 'disqualified', 'clear'].includes(String(decision))) return sendJson(res, 400, { error: 'bad-request' })
    if (decision === 'clear') {
      await store.clearDecision(week.key, userId)
      return sendJson(res, 200, { ok: true })
    }
    const ranking = rankWeek(await store.countedBetween(new Date(week.start).toISOString(), new Date(week.end).toISOString()), week)
    const referrals = ranking.find((r) => r.userId === userId)?.count ?? 0
    const ok = await store.setDecision({ week_start: week.key, user_id: userId, decision: decision as 'winner' | 'disqualified', referrals })
    return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: 'winner-exists' })
  }

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' })
  const week = weekOf(url.searchParams.get('week') ?? '') ?? lagosWeek(now)
  const rows = await store.countedBetween(new Date(week.start).toISOString(), new Date(week.end).toISOString())
  const ranking = rankWeek(rows, week)
  const [decisions, allDecisions, totals] = await Promise.all([store.decisions(week.key), store.decisions(), store.totals()])
  const decided = new Map(decisions.map((d) => [d.user_id, d.decision]))
  const disqualified = new Set(decisions.filter((d) => d.decision === 'disqualified').map((d) => d.user_id))
  const top = await Promise.all(
    ranking.slice(0, 10).map(async (r) => {
      const [email, theirs] = await Promise.all([store.emailOf(r.userId), store.referralsOf(r.userId)])
      const thisWeek = rows.filter((row) => row.referrer_id === r.userId)
      const flags = [...new Set(thisWeek.flatMap((row) => row.flags))]
      return {
        userId: r.userId,
        email,
        count: r.count,
        reachedAt: new Date(r.reachedAt).toISOString(),
        flags,
        flagged: thisWeek.filter((row) => row.flags.length > 0).length,
        held: theirs.filter((row) => row.status === 'held').length,
        rejected: theirs.filter((row) => row.status === 'rejected').length,
        decision: decided.get(r.userId) ?? null,
      }
    }),
  )
  const winners = await Promise.all(
    allDecisions
      .filter((d) => d.decision === 'winner')
      .map(async (d) => ({ week: d.week_start, userId: d.user_id, email: await store.emailOf(d.user_id), referrals: d.referrals, decidedAt: d.decided_at })),
  )
  return sendJson(res, 200, {
    week: { key: week.key, start: new Date(week.start).toISOString(), end: new Date(week.end).toISOString(), current: week.key === lagosWeek(now).key },
    top,
    suggested: weeklyWinner(ranking, disqualified)?.userId ?? null,
    winners,
    totals,
  })
}
