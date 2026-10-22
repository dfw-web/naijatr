/**
 * Referrals and the one-time "Invite & Win" contest, for the Vercel function
 * api/referral/[action].ts. Everything lives in Upstash Redis.
 *
 * Public:
 *   GET  contest      the contest's phase, dates, prizes, and the winners for 3 days after they're announced
 *   GET  leaderboard  top 10 (and your own rank, when signed in)
 *   POST arrive       a device opened /r/CODE: { code, device, newDevice }
 *   POST count        that device played something: { device } (+ session, if signed in)
 * Signed in (Telegram Login Widget → session token):
 *   POST login        { auth: <widget data>, device } → { token, user }
 *   GET  me           your link, points, rank
 *   POST profile      { nickname?, hidden? }
 *   GET  claim?t=     a winner's claim link (only for that winner)
 *   POST claim        { t, accountName, provider, accountNumber, phone }
 * Admin (ADMIN_PASSWORD):
 *   GET  admin, POST admin-confirm { place }, admin-dq { id }, admin-paid { id }
 *
 * A referral counts once: a device new to the site that arrived by a link and
 * then plays a movie or a series episode (trailers and football don't count). Never your own device or Telegram id,
 * each device once per contest (once ever outside one), and at most IP_DAILY_CAP a day per referrer from one network
 * (a salted hash; raw IPs are never stored). Bank details are encrypted
 * (CLAIM_ENCRYPTION_KEY), never logged or sent anywhere, shown only on
 * /admin/challenge and deleted for good by "Mark as paid".
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAdmin } from '../live/handlers.js'
import { hasRedis, readRedisEnv, redis, type Command, type RedisEnv } from '../redis.js'
import { boardScore, contestPhase, PLACES, pointsOf, readContest, scoresAt, type Contest } from './contest.js'
import {
  bearer,
  claimToken,
  createSession,
  decrypt,
  encrypt,
  hashAgent,
  hashIp,
  readSession,
  verifyTelegramLogin,
} from './security.js'

export const SITE = 'https://www.naijatr.com'
/** Counted referrals a day from one network. */
export const IP_DAILY_CAP = 3
/** An arrival is kept this long: the link works for 7 days. */
export const ARRIVAL_TTL_S = 7 * 24 * 60 * 60
export const CLAIM_TTL_S = 48 * 60 * 60
/** The winners' banner shows this long after they're announced. */
export const WINNERS_BANNER_MS = 3 * 24 * 60 * 60 * 1000
const REFS_KEPT = 500
const TELEGRAM_TIMEOUT_MS = 5000

const DEVICE = /^[A-Za-z0-9_-]{16,64}$/
const CODE = /^[A-Z0-9]{4,12}$/

export interface ReferralEnv extends RedisEnv {
  adminPassword: string
  telegramToken: string
  adminChatId: string
  /** Signs sessions and salts IP hashes. */
  secret: string
  claimKey: string
  contest: Contest | null
}

export function readReferralEnv(env: Record<string, string | undefined>): ReferralEnv {
  return {
    ...readRedisEnv(env),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
    adminChatId: env.ADMIN_TELEGRAM_CHAT_ID?.trim() ?? '',
    secret: (env.REFERRAL_SECRET ?? env.NAIJATR_GATE_SECRET ?? '').trim(),
    claimKey: env.CLAIM_ENCRYPTION_KEY?.trim() ?? '',
    contest: readContest(env),
  }
}

export interface ReferralUser {
  id: number
  code: string
  nickname: string
  username: string | null
  hidden: boolean
  joinedAt: number
}

interface Arrival {
  code: string
  at: number
  newDevice: boolean
}

export interface ReferralRecord {
  at: number
  ip: string
  ua: string
  /** Seconds from opening the link to the first play. */
  delay: number
  contest: boolean
}

const k = {
  user: (id: number) => `ref:user:${id}`,
  code: (code: string) => `ref:code:${code}`,
  devices: (id: number) => `ref:devices:${id}`,
  arrival: (device: string) => `ref:arrive:${device}`,
  // A contest counts each device once on its own: a new contest (new start) lets everyone count again.
  counted: (device: string, c: Contest | null) => (c ? `contest:${c.id}:counted:${device}` : `ref:counted:${device}`),
  // Per referrer: mobile networks put many strangers behind one IP (CGNAT).
  ipDay: (id: number, ip: string, day: string) => `ref:ipday:${id}:${ip}:${day}`,
  refs: (id: number) => `ref:refs:${id}`,
  total: (id: number) => `ref:total:${id}`,
  points: (c: Contest) => `contest:${c.id}:points`,
  board: (c: Contest) => `contest:${c.id}:board`,
  dq: (c: Contest) => `contest:${c.id}:dq`,
  confirmed: (c: Contest) => `contest:${c.id}:confirmed`,
  announced: (c: Contest) => `contest:${c.id}:announced`,
  claimData: (c: Contest, id: number) => `contest:${c.id}:claim:${id}`,
  paid: (c: Contest) => `contest:${c.id}:paid`,
  claimLink: (token: string) => `claim:${token}`,
}

const parse = <T>(raw: unknown): T | null => {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

type Result = { status: number; body: unknown }
const ok = (body: unknown = { ok: true }): Result => ({ status: 200, body })
const fail = (status: number, error: string): Result => ({ status, body: { error } })

export const displayName = (user: Pick<ReferralUser, 'nickname' | 'hidden'>) => (user.hidden ? 'Hidden player' : user.nickname)

/** Letters and digits only, like "BRUNO23". */
export function codeBase(user: { username?: string; first_name?: string }) {
  const letters = (user.username || user.first_name || 'NAIJA').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return (letters || 'NAIJA').slice(0, 6)
}

export function cleanNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/<[^>]*>|https?:\/\/\S+|[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
  return text.length >= 2 && text.length <= 24 ? text : null
}

// ---- Users ----

async function getUser(env: ReferralEnv, id: number, fetchImpl: typeof fetch) {
  const [raw] = (await redis(env, [['GET', k.user(id)]], fetchImpl)) ?? []
  return parse<ReferralUser>(raw)
}

async function login(env: ReferralEnv, body: Record<string, unknown>, now: number, fetchImpl: typeof fetch): Promise<Result> {
  const tg = verifyTelegramLogin(body.auth, env.telegramToken, now)
  if (!tg) return fail(401, 'bad-login')
  const device = typeof body.device === 'string' && DEVICE.test(body.device) ? body.device : null
  let user = await getUser(env, tg.id, fetchImpl)
  if (!user) {
    const base = codeBase(tg)
    let code: string | null = null
    for (let attempt = 0; attempt < 8 && !code; attempt += 1) {
      const candidate = `${base}${Math.floor(10 + Math.random() * (attempt < 4 ? 90 : 9990))}`
      const [set] = (await redis(env, [['SET', k.code(candidate), tg.id, 'NX']], fetchImpl)) ?? []
      if (set === 'OK') code = candidate
    }
    if (!code) return fail(503, 'store-unavailable')
    user = {
      id: tg.id,
      code,
      nickname: tg.username ? `@${tg.username}` : tg.first_name.slice(0, 24) || 'Player',
      username: tg.username ?? null,
      hidden: false,
      joinedAt: now,
    }
  } else {
    user = { ...user, username: tg.username ?? user.username }
  }
  const commands: Command[] = [['SET', k.user(tg.id), JSON.stringify(user)]]
  // Devices that signed in as you can never count as your referrals.
  if (device) commands.push(['SADD', k.devices(tg.id), device])
  if (!(await redis(env, commands, fetchImpl))) return fail(503, 'store-unavailable')
  return ok({ token: createSession(env.secret, tg.id, now), user: publicUser(user) })
}

const publicUser = (user: ReferralUser) => ({
  code: user.code,
  nickname: user.nickname,
  hidden: user.hidden,
  link: `${SITE}/r/${user.code}`,
})

// ---- Referrals ----

async function arrive(env: ReferralEnv, body: Record<string, unknown>, now: number, fetchImpl: typeof fetch): Promise<Result> {
  const code = typeof body.code === 'string' ? body.code.toUpperCase() : ''
  const device = typeof body.device === 'string' ? body.device : ''
  if (!CODE.test(code) || !DEVICE.test(device)) return fail(400, 'bad-request')
  const arrival: Arrival = { code, at: now, newDevice: body.newDevice === true }
  // The first link a device opens is the one that counts.
  await redis(env, [['SET', k.arrival(device), JSON.stringify(arrival), 'EX', ARRIVAL_TTL_S, 'NX']], fetchImpl)
  return ok()
}

export type CountOutcome = 'counted' | 'no-invite' | 'not-new' | 'unknown-code' | 'self' | 'already' | 'ip-cap' | 'store-unavailable'

/** The device played something: count its referral if it qualifies. */
export async function countReferral(
  env: ReferralEnv,
  input: { device: string; sessionUser: number | null; ip: string; agent: string; arrival?: Arrival | null },
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CountOutcome> {
  const { device } = input
  const contest = env.contest
  const inContest = scoresAt(contest, now)
  const counted = k.counted(device, contest && inContest ? contest : null)
  const [rawArrival, rawCounted] = (await redis(env, [['GET', k.arrival(device)], ['GET', counted]], fetchImpl)) ?? []
  // The arrive call can be lost (flaky network, page left at once): the browser resends it with the play.
  const arrival = parse<Arrival>(rawArrival) ?? input.arrival ?? null
  if (!arrival) return 'no-invite'
  if (rawCounted) return 'already'
  if (!arrival.newDevice) return 'not-new'
  const [rawReferrer] = (await redis(env, [['GET', k.code(arrival.code)]], fetchImpl)) ?? []
  const referrer = Number(rawReferrer)
  if (!rawReferrer || !Number.isSafeInteger(referrer)) return 'unknown-code'
  if (input.sessionUser === referrer) return 'self'
  const [ownDevice] = (await redis(env, [['SISMEMBER', k.devices(referrer), device]], fetchImpl)) ?? []
  if (Number(ownDevice) === 1) return 'self'

  const ip = hashIp(env.secret, input.ip || 'unknown')
  const day = new Date(now + 3_600_000).toISOString().slice(0, 10) // Lagos day
  const [today] = (await redis(env, [['INCR', k.ipDay(referrer, ip, day)], ['EXPIRE', k.ipDay(referrer, ip, day), 2 * 86_400]], fetchImpl)) ?? []
  if (Number(today) > IP_DAILY_CAP) return 'ip-cap'
  // Each device once (per contest).
  const [claimed] = (await redis(env, [['SET', counted, referrer, 'NX']], fetchImpl)) ?? []
  if (claimed !== 'OK') return 'already'

  const record: ReferralRecord = {
    at: now,
    ip,
    ua: hashAgent(env.secret, input.agent),
    delay: Math.max(0, Math.round((now - arrival.at) / 1000)),
    contest: inContest,
  }
  const commands: Command[] = [
    ['LPUSH', k.refs(referrer), JSON.stringify(record)],
    ['LTRIM', k.refs(referrer), 0, REFS_KEPT - 1],
    ['INCR', k.total(referrer)],
  ]
  if (contest && inContest) commands.push(['HINCRBY', k.points(contest), referrer, 1])
  const results = await redis(env, commands, fetchImpl)
  if (!results) return 'store-unavailable'
  if (contest && inContest) {
    const points = Number(results[3])
    // GT: a slower, concurrent update never lowers the score.
    await redis(env, [['ZADD', k.board(contest), 'GT', boardScore(points, now, contest), referrer]], fetchImpl)
  }
  return 'counted'
}

// ---- Leaderboard ----

export interface Standing {
  id: number
  points: number
  rank: number
}

/** Everyone on the board, best first, without the disqualified. Ties go to whoever got there first. */
export async function standings(env: ReferralEnv, contest: Contest, fetchImpl: typeof fetch): Promise<Standing[] | null> {
  const results = await redis(env, [['ZRANGE', k.board(contest), 0, -1, 'REV', 'WITHSCORES'], ['SMEMBERS', k.dq(contest)]], fetchImpl)
  if (!results) return null
  const flat = Array.isArray(results[0]) ? (results[0] as string[]) : []
  const dq = new Set((Array.isArray(results[1]) ? (results[1] as string[]) : []).map(Number))
  const rows: { id: number; score: number }[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) rows.push({ id: Number(flat[i]), score: Number(flat[i + 1]) })
  return rows
    .filter((r) => !dq.has(r.id))
    .sort((a, b) => b.score - a.score)
    .map((r, index) => ({ id: r.id, points: pointsOf(r.score), rank: index + 1 }))
}

async function usersById(env: ReferralEnv, ids: number[], fetchImpl: typeof fetch) {
  if (!ids.length) return new Map<number, ReferralUser>()
  const [raw] = (await redis(env, [['MGET', ...ids.map(k.user)]], fetchImpl)) ?? []
  const list = Array.isArray(raw) ? raw.map((r) => parse<ReferralUser>(r)) : []
  return new Map(list.flatMap((u) => (u ? [[u.id, u] as const] : [])))
}

async function leaderboard(env: ReferralEnv, sessionUser: number | null, fetchImpl: typeof fetch): Promise<Result> {
  const contest = env.contest
  if (!contest) return ok({ top: [], me: null })
  const all = await standings(env, contest, fetchImpl)
  if (!all) return fail(502, 'store-unavailable')
  const top = all.slice(0, 10)
  const users = await usersById(env, top.map((s) => s.id), fetchImpl)
  const me = sessionUser === null ? null : (all.find((s) => s.id === sessionUser) ?? { id: sessionUser, points: 0, rank: null })
  return ok({
    top: top.map((s) => ({ rank: s.rank, points: s.points, name: users.get(s.id) ? displayName(users.get(s.id)!) : 'Player', me: s.id === sessionUser })),
    me: me && { rank: me.rank, points: me.points },
  })
}

async function me(env: ReferralEnv, userId: number, fetchImpl: typeof fetch): Promise<Result> {
  const user = await getUser(env, userId, fetchImpl)
  if (!user) return fail(401, 'signed-out')
  const contest = env.contest
  const [total] = (await redis(env, [['GET', k.total(userId)]], fetchImpl)) ?? []
  const all = contest ? await standings(env, contest, fetchImpl) : []
  const mine = all?.find((s) => s.id === userId)
  return ok({ user: publicUser(user), total: Number(total) || 0, points: mine?.points ?? 0, rank: mine?.rank ?? null })
}

async function profile(env: ReferralEnv, userId: number, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<Result> {
  const user = await getUser(env, userId, fetchImpl)
  if (!user) return fail(401, 'signed-out')
  const next = { ...user }
  if (body.nickname !== undefined) {
    const nickname = cleanNickname(body.nickname)
    if (!nickname) return fail(400, 'bad-nickname')
    next.nickname = nickname
  }
  if (typeof body.hidden === 'boolean') next.hidden = body.hidden
  await redis(env, [['SET', k.user(userId), JSON.stringify(next)]], fetchImpl)
  return ok({ user: publicUser(next) })
}

// ---- Contest info, winners ----

interface Confirmed {
  id: number
  place: number
  amount: number
  at: number
  name: string
  messaged: boolean
}

async function confirmedWinners(env: ReferralEnv, contest: Contest, fetchImpl: typeof fetch): Promise<Confirmed[]> {
  const [raw] = (await redis(env, [['HGETALL', k.confirmed(contest)]], fetchImpl)) ?? []
  const flat = Array.isArray(raw) ? (raw as string[]) : []
  const out: Confirmed[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const entry = parse<Confirmed>(flat[i + 1])
    if (entry) out.push(entry)
  }
  return out.sort((a, b) => a.place - b.place)
}

async function contestInfo(env: ReferralEnv, now: number, fetchImpl: typeof fetch): Promise<Result> {
  const contest = env.contest
  const phase = contestPhase(contest, now)
  let winners: string[] | null = null
  if (contest && phase === 'ended') {
    const [announced] = (await redis(env, [['GET', k.announced(contest)]], fetchImpl)) ?? []
    if (announced && now - Number(announced) < WINNERS_BANNER_MS) {
      winners = (await confirmedWinners(env, contest, fetchImpl)).map((w) => w.name)
    }
  }
  return ok({
    phase,
    start: contest?.start ?? null,
    end: contest?.end ?? null,
    // Prize wording only while it runs.
    prizes: phase === 'live' || phase === 'upcoming' ? contest!.prizes : null,
    winners,
  })
}

const naira = (amount: number) => `₦${amount.toLocaleString('en-NG')}`

async function telegram(env: ReferralEnv, chatId: string | number, text: string, fetchImpl: typeof fetch) {
  if (!env.telegramToken) return false
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

// ---- Admin ----

/** Patterns worth a look before paying out. */
export function suspicionFlags(refs: ReferralRecord[]): string[] {
  const counted = refs.filter((r) => r.contest)
  if (!counted.length) return []
  const flags: string[] = []
  const most = (key: 'ip' | 'ua') => Math.max(...Object.values(counted.reduce<Record<string, number>>((m, r) => ({ ...m, [r[key]]: (m[r[key]] ?? 0) + 1 }), {})))
  const sameIp = most('ip')
  if (sameIp >= 3) flags.push(`${sameIp} referrals from one network`)
  const fast = counted.filter((r) => r.delay < 15).length
  if (fast >= 3 && fast / counted.length >= 0.5) flags.push(`${fast} played within 15 seconds of opening the link`)
  const sameUa = most('ua')
  if (counted.length >= 5 && sameUa / counted.length >= 0.8) flags.push(`${sameUa} from the same phone and browser type`)
  return flags
}

async function adminView(env: ReferralEnv, contest: Contest, now: number, fetchImpl: typeof fetch): Promise<Result> {
  const all = await standings(env, contest, fetchImpl)
  if (!all) return fail(502, 'store-unavailable')
  const confirmed = await confirmedWinners(env, contest, fetchImpl)
  const top = all.slice(0, 10)
  const ids = [...new Set([...top.map((s) => s.id), ...confirmed.map((c) => c.id)])]
  const users = await usersById(env, ids, fetchImpl)
  const results =
    (await redis(
      env,
      [
        ...top.map((s): Command => ['LRANGE', k.refs(s.id), 0, REFS_KEPT - 1]),
        ...confirmed.map((c): Command => ['GET', k.claimData(contest, c.id)]),
        ['SMEMBERS', k.paid(contest)],
        ['SMEMBERS', k.dq(contest)],
      ],
      fetchImpl,
    )) ?? []
  const paid = new Set((Array.isArray(results.at(-2)) ? (results.at(-2) as string[]) : []).map(Number))
  const dq = (Array.isArray(results.at(-1)) ? (results.at(-1) as string[]) : []).map(Number)
  const dqUsers = await usersById(env, dq, fetchImpl)
  return ok({
    contest: { id: contest.id, phase: contestPhase(contest, now), start: contest.start, end: contest.end, prizes: contest.prizes },
    top: top.map((s, i) => {
      const user = users.get(s.id)
      const refs = (Array.isArray(results[i]) ? (results[i] as string[]) : []).flatMap((r) => parse<ReferralRecord>(r) ?? [])
      return {
        id: s.id,
        rank: s.rank,
        points: s.points,
        nickname: user?.nickname ?? '',
        username: user?.username ?? null,
        hidden: user?.hidden ?? false,
        flags: suspicionFlags(refs),
      }
    }),
    confirmed: confirmed.map((c, i) => {
      const sealed = results[top.length + i]
      const plain = typeof sealed === 'string' && env.claimKey ? decrypt(env.claimKey, sealed) : null
      return { ...c, username: users.get(c.id)?.username ?? null, paid: paid.has(c.id), claim: plain ? JSON.parse(plain) : null }
    }),
    disqualified: dq.map((id) => ({ id, nickname: dqUsers.get(id)?.nickname ?? String(id) })),
    telegram: Boolean(env.telegramToken),
    claimsReady: Boolean(env.claimKey),
  })
}

/** Confirms the next place (1st, then 2nd, then 3rd): messages the winner, and the admin once all 3 are in. */
export async function confirmPlace(env: ReferralEnv, contest: Contest, place: number, now: number, fetchImpl: typeof fetch): Promise<Result> {
  if (contestPhase(contest, now) !== 'ended') return fail(409, 'not-ended')
  const confirmed = await confirmedWinners(env, contest, fetchImpl)
  if (place !== confirmed.length + 1 || place > 3) return fail(409, 'confirm-in-order')
  const all = await standings(env, contest, fetchImpl)
  if (!all) return fail(502, 'store-unavailable')
  const taken = new Set(confirmed.map((c) => c.id))
  const winner = all.filter((s) => !taken.has(s.id))[0]
  if (!winner) return fail(404, 'no-one-left')
  const user = await getUser(env, winner.id, fetchImpl)
  const amount = contest.prizes[place - 1]
  const token = claimToken()
  const link = `${SITE}/challenge/claim?t=${token}`
  const messaged = await telegram(
    env,
    winner.id,
    `🎉 Congrats! You placed ${PLACES[place - 1]} and won ${naira(amount)} in the NAIJA TR Invite Challenge. Claim within 48h: ${link}`,
    fetchImpl,
  )
  const entry: Confirmed = { id: winner.id, place, amount, at: now, name: user ? displayName(user) : 'Player', messaged }
  const commands: Command[] = [
    ['SET', k.claimLink(token), JSON.stringify({ id: winner.id, place, amount, contest: contest.id }), 'EX', CLAIM_TTL_S],
    ['HSET', k.confirmed(contest), place, JSON.stringify(entry)],
  ]
  if (place === 3) commands.push(['SET', k.announced(contest), now])
  if (!(await redis(env, commands, fetchImpl))) return fail(502, 'store-unavailable')
  if (place === 3 && env.adminChatId) {
    const list = [...confirmed, entry]
      .map((c) => `${['🥇', '🥈', '🥉'][c.place - 1]} ${c.name}${c.name.startsWith('@') ? '' : ` (Telegram id ${c.id})`}: ${naira(c.amount)}${c.messaged ? '' : ' (DM failed: they must /start @naijatr_bot)'}`)
      .join('\n')
    await telegram(env, env.adminChatId, `🏆 NAIJA TR Invite Challenge winners\n${list}`, fetchImpl)
  }
  return ok({ confirmed: entry })
}

export async function disqualify(env: ReferralEnv, contest: Contest, id: number, fetchImpl: typeof fetch): Promise<Result> {
  const confirmed = await confirmedWinners(env, contest, fetchImpl)
  if (confirmed.some((c) => c.id === id)) return fail(409, 'already-confirmed')
  await redis(env, [['SADD', k.dq(contest), id]], fetchImpl)
  return ok()
}

/** Paid: the bank details are deleted for good. */
export async function markPaid(env: ReferralEnv, contest: Contest, id: number, fetchImpl: typeof fetch): Promise<Result> {
  const done = await redis(env, [['DEL', k.claimData(contest, id)], ['SADD', k.paid(contest), id]], fetchImpl)
  return done ? ok() : fail(502, 'store-unavailable')
}

// ---- Claims ----

interface ClaimLink {
  id: number
  place: number
  amount: number
  contest: string
}

async function readClaimLink(env: ReferralEnv, token: unknown, userId: number, fetchImpl: typeof fetch) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const [raw] = (await redis(env, [['GET', k.claimLink(token)]], fetchImpl)) ?? []
  const link = parse<ClaimLink>(raw)
  // Only the winner it was made for.
  return link && link.id === userId ? link : null
}

const field = (value: unknown, pattern: RegExp) => {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return pattern.test(text) ? text : null
}

export function parseClaim(body: Record<string, unknown>) {
  const accountName = field(body.accountName, /^[\p{L} .'-]{2,80}$/u)
  const provider = field(body.provider, /^[\p{L}\d &.'()-]{2,60}$/u)
  const accountNumber = field(body.accountNumber, /^\d{6,20}$/)
  const phone = field(body.phone, /^\+?\d[\d ]{6,18}$/)
  return accountName && provider && accountNumber && phone ? { accountName, provider, accountNumber, phone } : null
}

async function submitClaim(env: ReferralEnv, contest: Contest, userId: number, body: Record<string, unknown>, now: number, fetchImpl: typeof fetch): Promise<Result> {
  if (!env.claimKey) return fail(503, 'not-configured')
  const link = await readClaimLink(env, body.t, userId, fetchImpl)
  if (!link || link.contest !== contest.id) return fail(404, 'link-expired')
  const details = parseClaim(body)
  if (!details) return fail(400, 'bad-details')
  const sealed = encrypt(env.claimKey, JSON.stringify({ ...details, at: now }))
  // One-time: the link stops working once used.
  const done = await redis(env, [['SET', k.claimData(contest, userId), sealed], ['DEL', k.claimLink(body.t as string)]], fetchImpl)
  return done ? ok() : fail(502, 'store-unavailable')
}

// ---- HTTP ----

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>
  if (typeof req.body === 'string') return JSON.parse(req.body) as Record<string, unknown>
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 10_000) throw new Error('too large')
  }
  const parsed = raw ? (JSON.parse(raw) as unknown) : {}
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

/** The visitor's IP (Vercel sets x-forwarded-for); only ever hashed. */
export const clientIp = (req: IncomingMessage) =>
  String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || ''

const GET_ROUTES = new Set(['contest', 'leaderboard', 'me', 'claim', 'admin'])
const POST_ROUTES = new Set(['login', 'arrive', 'count', 'profile', 'claim', 'admin-confirm', 'admin-dq', 'admin-paid'])

export async function handleReferral(
  env: ReferralEnv,
  action: string,
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  const post = req.method === 'POST'
  if (!(post ? POST_ROUTES : GET_ROUTES).has(action)) return sendJson(res, GET_ROUTES.has(action) || POST_ROUTES.has(action) ? 405 : 404, { error: 'not-found' })
  if (!hasRedis(env) || !env.secret) return sendJson(res, 503, { error: 'not-configured' })
  let body: Record<string, unknown> = {}
  if (post) {
    try {
      body = await readBody(req)
    } catch {
      return sendJson(res, 400, { error: 'bad-request' })
    }
  }
  const authorization = req.headers?.authorization
  const reply = (r: Result) => sendJson(res, r.status, r.body)

  if (action.startsWith('admin')) {
    if (!env.adminPassword) return sendJson(res, 503, { error: 'not-configured' })
    if (!isAdmin({ ...env, adminPassword: env.adminPassword }, authorization)) return sendJson(res, 401, { error: 'unauthorized' })
    const contest = env.contest
    if (!contest) return sendJson(res, 404, { error: 'no-contest' })
    if (action === 'admin') return reply(await adminView(env, contest, now, fetchImpl))
    if (action === 'admin-confirm') return reply(await confirmPlace(env, contest, Number(body.place), now, fetchImpl))
    const id = Number(body.id)
    if (!Number.isSafeInteger(id) || id <= 0) return sendJson(res, 400, { error: 'bad-request' })
    return reply(action === 'admin-dq' ? await disqualify(env, contest, id, fetchImpl) : await markPaid(env, contest, id, fetchImpl))
  }

  const sessionUser = readSession(env.secret, bearer(authorization), now)
  switch (action) {
    case 'contest':
      return reply(await contestInfo(env, now, fetchImpl))
    case 'leaderboard':
      return reply(await leaderboard(env, sessionUser, fetchImpl))
    case 'login':
      return reply(await login(env, body, now, fetchImpl))
    case 'arrive':
      return reply(await arrive(env, body, now, fetchImpl))
    case 'count': {
      const device = typeof body.device === 'string' && DEVICE.test(body.device) ? body.device : ''
      if (!device) return sendJson(res, 400, { error: 'bad-request' })
      const agent = String(req.headers?.['user-agent'] ?? '')
      const code = typeof body.code === 'string' ? body.code.toUpperCase() : ''
      const at = Number(body.at)
      const arrival = CODE.test(code) && Number.isFinite(at) && at <= now && now - at < ARRIVAL_TTL_S * 1000 ? { code, at, newDevice: body.newDevice === true } : null
      const outcome = await countReferral(env, { device, sessionUser, ip: clientIp(req), agent, arrival }, now, fetchImpl)
      return reply(ok({ outcome }))
    }
  }
  if (sessionUser === null) return sendJson(res, 401, { error: 'signed-out' })
  if (action === 'me') return reply(await me(env, sessionUser, fetchImpl))
  if (action === 'profile') return reply(await profile(env, sessionUser, body, fetchImpl))
  // claim
  const contest = env.contest
  if (!contest) return sendJson(res, 404, { error: 'link-expired' })
  if (!post) {
    const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('t')
    const link = await readClaimLink(env, token, sessionUser, fetchImpl)
    return link ? reply(ok({ place: PLACES[link.place - 1], amount: link.amount })) : sendJson(res, 404, { error: 'link-expired' })
  }
  return reply(await submitClaim(env, contest, sessionUser, body, now, fetchImpl))
}
