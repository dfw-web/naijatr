/**
 * The referral program's rules, as plain functions (tested on their own in
 * rules.test.ts): who counts, Gmail normalization, the ad-free reward and the
 * weekly mystery prize. The handlers (handlers.ts) read and write Supabase
 * around them.
 */
import { createHash, randomInt } from 'node:crypto'

export const DAY_MS = 24 * 60 * 60 * 1000
/** An invite link is remembered this long; the new account must be made within it. */
export const REF_TTL_MS = 7 * DAY_MS
/** Lagos is UTC+1 all year. */
const LAGOS_OFFSET_MS = 60 * 60 * 1000

export interface ReferralConfig {
  /** Counted referrals per ad-free unlock (REFERRAL_GOAL, default 5). */
  goal: number
  /** Days of ad-free per unlock (AD_FREE_DAYS, default 14). Never shown in promotions. */
  adFreeDays: number
  /** Counted referrals per network (IP hash) per Lagos day; more are held for review (REFERRAL_IP_DAILY_LIMIT, default 3). */
  ipDailyLimit: number
  /** Permanently ad-free accounts (AD_FREE_EMAILS, comma-separated), normalized. */
  adFreeEmails: string[]
  /** Salt for IP hashes (REFERRAL_SALT; else derived from the service key). */
  salt: string
}

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function readReferralConfig(env: Record<string, string | undefined>): ReferralConfig {
  const salt = env.REFERRAL_SALT?.trim() || createHash('sha256').update(`referral-salt:${env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`).digest('hex')
  return {
    goal: positiveInt(env.REFERRAL_GOAL, 5),
    adFreeDays: positiveInt(env.AD_FREE_DAYS, 14),
    ipDailyLimit: positiveInt(env.REFERRAL_IP_DAILY_LIMIT, 3),
    adFreeEmails: (env.AD_FREE_EMAILS ?? '')
      .split(',')
      .map((email) => normalizeEmail(email))
      .filter(Boolean),
    salt,
  }
}

const GMAIL = new Set(['gmail.com', 'googlemail.com'])

/**
 * One inbox, one address: lower case, and for Gmail no dots and no +tag
 * ("A.Da+films@googlemail.com" → "ada@gmail.com"). Other providers: lower case only.
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return trimmed
  const domain = trimmed.slice(at + 1)
  if (!GMAIL.has(domain)) return trimmed
  const local = trimmed.slice(0, at).split('+')[0].replace(/\./g, '')
  return `${local}@gmail.com`
}

/** A short salted hash of an IP: enough to spot many referrals from one network, never the IP. */
export const hashIp = (salt: string, ip: string) => createHash('sha256').update(`ip:${salt}:${ip}`).digest('hex').slice(0, 16)

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** A new invite code: 6 letters and digits, no look-alikes (0/O, 1/I). */
export const newInviteCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
export const isInviteCode = (code: unknown): code is string => typeof code === 'string' && /^[A-Z0-9]{4,12}$/.test(code)

// ---- Ad-free ----

export interface AdFreeState {
  adFree: boolean
  /** When it ends (null: not ad-free, or permanently). */
  until: string | null
  permanent: boolean
}

export function adFreeState(email: string, adFreeUntil: string | null | undefined, config: ReferralConfig, now: number): AdFreeState {
  if (email && config.adFreeEmails.includes(normalizeEmail(email))) return { adFree: true, until: null, permanent: true }
  const until = adFreeUntil ? Date.parse(adFreeUntil) : NaN
  return Number.isFinite(until) && until > now
    ? { adFree: true, until: new Date(until).toISOString(), permanent: false }
    : { adFree: false, until: null, permanent: false }
}

/** Unlocks earned and not yet given: one per `goal` counted referrals. */
export const rewardsDue = (counted: number, granted: number, goal: number) => Math.max(0, Math.floor(counted / goal) - granted)

/** The new end of ad-free after `unlocks` more: added to what's left (stacking), or from now. */
export function extendAdFree(currentUntil: string | null | undefined, now: number, days: number, unlocks: number): string {
  const current = currentUntil ? Date.parse(currentUntil) : NaN
  const from = Number.isFinite(current) && current > now ? current : now
  return new Date(from + unlocks * days * DAY_MS).toISOString()
}

// ---- Who counts ----

export type ClaimRejection = 'self' | 'same-inbox' | 'duplicate-inbox' | 'not-new' | 'already' | 'unknown-code'

export interface ClaimInput {
  userId: string
  email: string
  /** When the account was created. */
  createdAt: number
  /** When the invite link was opened on this device (as the browser says; bounded by REF_TTL_MS). */
  openedAt: number | null
  referrer: { userId: string; emailNormalized: string | null } | null
  /** Another account already has this inbox (normalized). */
  inboxTaken: boolean
  /** This account already has a referral row. */
  alreadyReferred: boolean
  now: number
}

/** Allowed to attach a friend's code? Only a new account, for a new inbox, that isn't the friend's own. */
export function checkClaim(input: ClaimInput): { ok: true } | { ok: false; reason: ClaimRejection; record: boolean } {
  if (input.alreadyReferred) return { ok: false, reason: 'already', record: false }
  if (!input.referrer) return { ok: false, reason: 'unknown-code', record: false }
  // New: made within the link's 7 days, and not before the link was opened (10 minutes' slack for clocks).
  const opened = input.openedAt !== null && Number.isFinite(input.openedAt) ? Math.max(input.openedAt, input.now - REF_TTL_MS) : input.now - REF_TTL_MS
  if (input.createdAt < opened - 10 * 60_000 || input.createdAt < input.now - REF_TTL_MS) return { ok: false, reason: 'not-new', record: false }
  // Recorded (for the admin) from here on: the account can't be referred again.
  if (input.referrer.userId === input.userId) return { ok: false, reason: 'self', record: true }
  const inbox = normalizeEmail(input.email)
  if (input.referrer.emailNormalized && input.referrer.emailNormalized === inbox) return { ok: false, reason: 'same-inbox', record: true }
  if (input.inboxTaken) return { ok: false, reason: 'duplicate-inbox', record: true }
  return { ok: true }
}

export interface CountInput {
  /** The referral's status now. */
  status: string
  emailConfirmed: boolean
  /** Referrals already counted today (Lagos) from this network. */
  countedFromIpToday: number
  /** The network is the referrer's own (their last IP hash). */
  referrerSameIp: boolean
  /** Other referrals of this referrer from the same network. */
  siblingsSameIp: number
  /** Referrals this referrer got in the last hour. */
  claimsLastHour: number
  ipDailyLimit: number
}

/**
 * The invited account watched something: counted now, held for review (over
 * the network's daily limit), or nothing to do. Flags are for the admin.
 */
export function checkCount(input: CountInput): { result: 'counted' | 'held' | 'skip'; flags: string[] } {
  if (input.status !== 'pending' || !input.emailConfirmed) return { result: 'skip', flags: [] }
  const flags: string[] = []
  if (input.referrerSameIp) flags.push('referrer-network')
  if (input.siblingsSameIp >= 2) flags.push('shared-network')
  if (input.claimsLastHour >= 5) flags.push('burst')
  if (input.countedFromIpToday >= input.ipDailyLimit) return { result: 'held', flags: [...flags, 'ip-limit'] }
  return { result: 'counted', flags }
}

// ---- Weeks (Monday 00:00 → Sunday 23:59, Lagos) ----

export interface Week {
  /** "2026-11-02": the Monday, Lagos date. */
  key: string
  start: number
  end: number
}

export function lagosWeek(now: number): Week {
  const local = new Date(now + LAGOS_OFFSET_MS)
  const sinceMonday = (local.getUTCDay() + 6) % 7
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - sinceMonday)
  const start = mondayLocal - LAGOS_OFFSET_MS
  return { key: new Date(mondayLocal).toISOString().slice(0, 10), start, end: start + 7 * DAY_MS }
}

/** The week starting on Monday `key` ("YYYY-MM-DD"), or null for anything else. */
export function weekOf(key: string): Week | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const mondayLocal = Date.parse(`${key}T00:00:00Z`)
  if (!Number.isFinite(mondayLocal) || new Date(mondayLocal).getUTCDay() !== 1) return null
  const start = mondayLocal - LAGOS_OFFSET_MS
  return { key, start, end: start + 7 * DAY_MS }
}

/** The start of today in Lagos, as a UTC time. */
export function lagosDayStart(now: number): number {
  const local = new Date(now + LAGOS_OFFSET_MS)
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - LAGOS_OFFSET_MS
}

export interface Ranked {
  userId: string
  count: number
  /** When they reached that count (their last counted referral this week): earlier wins a tie. */
  reachedAt: number
}

/** Counted referrals in a week, most first; a tie goes to whoever got there first. */
export function rankWeek(rows: { referrer_id: string; counted_at: string | null }[], week: Week): Ranked[] {
  const byUser = new Map<string, Ranked>()
  for (const row of rows) {
    const at = row.counted_at ? Date.parse(row.counted_at) : NaN
    if (!(at >= week.start && at < week.end)) continue
    const entry = byUser.get(row.referrer_id) ?? { userId: row.referrer_id, count: 0, reachedAt: 0 }
    entry.count += 1
    entry.reachedAt = Math.max(entry.reachedAt, at)
    byUser.set(row.referrer_id, entry)
  }
  return [...byUser.values()].sort((a, b) => b.count - a.count || a.reachedAt - b.reachedAt)
}

/** The week's winner: the top of the ranking, leaving out the disqualified. */
export const weeklyWinner = (ranking: Ranked[], disqualified: Set<string>) => ranking.find((r) => !disqualified.has(r.userId)) ?? null
