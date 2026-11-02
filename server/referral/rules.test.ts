import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  adFreeState,
  checkClaim,
  checkCount,
  extendAdFree,
  lagosWeek,
  normalizeEmail,
  rankWeek,
  readReferralConfig,
  rewardsDue,
  weekOf,
  weeklyWinner,
  type ClaimInput,
  type CountInput,
} from './rules'

const NOW = Date.UTC(2026, 10, 4, 12) // Wednesday 4 Nov 2026, 13:00 Lagos
const config = readReferralConfig({ AD_FREE_EMAILS: ' Owner@Gmail.com, friend@example.com ', REFERRAL_SALT: 'salt' })

describe('Gmail normalization', () => {
  it('treats dots, +tags, case and googlemail.com as the same Gmail inbox', () => {
    for (const email of ['ada.obi@gmail.com', 'AdaObi+films@gmail.com', 'a.d.a.o.b.i+x+y@GoogleMail.com', '  adaobi@gmail.com ']) {
      expect(normalizeEmail(email)).toBe('adaobi@gmail.com')
    }
  })
  it('only lowercases other providers (dots and + can be different inboxes there)', () => {
    expect(normalizeEmail('Ada.Obi+x@Yahoo.com')).toBe('ada.obi+x@yahoo.com')
  })
})

describe('config', () => {
  it('defaults to 5 referrals and 14 days, and reads the env', () => {
    expect(readReferralConfig({})).toMatchObject({ goal: 5, adFreeDays: 14, ipDailyLimit: 3, adFreeEmails: [] })
    expect(readReferralConfig({ REFERRAL_GOAL: '3', AD_FREE_DAYS: '30', REFERRAL_IP_DAILY_LIMIT: '10' })).toMatchObject({ goal: 3, adFreeDays: 30, ipDailyLimit: 10 })
    expect(readReferralConfig({ REFERRAL_GOAL: 'x', AD_FREE_DAYS: '-1' })).toMatchObject({ goal: 5, adFreeDays: 14 })
  })
})

describe('ad-free state', () => {
  it('is permanent for allowlisted emails, normalized', () => {
    expect(adFreeState('o.w.n.e.r+tv@gmail.com', null, config, NOW)).toEqual({ adFree: true, until: null, permanent: true })
    expect(adFreeState('FRIEND@example.com', null, config, NOW).permanent).toBe(true)
  })
  it('follows ad_free_until, and ends when it passes', () => {
    const until = new Date(NOW + DAY_MS).toISOString()
    expect(adFreeState('someone@x.com', until, config, NOW)).toEqual({ adFree: true, until, permanent: false })
    expect(adFreeState('someone@x.com', until, config, NOW + 2 * DAY_MS).adFree).toBe(false)
    expect(adFreeState('someone@x.com', null, config, NOW).adFree).toBe(false)
  })
})

describe('the reward', () => {
  it('unlocks once per 5 counted referrals', () => {
    expect(rewardsDue(4, 0, 5)).toBe(0)
    expect(rewardsDue(5, 0, 5)).toBe(1)
    expect(rewardsDue(9, 1, 5)).toBe(0)
    expect(rewardsDue(10, 1, 5)).toBe(1)
    expect(rewardsDue(10, 0, 5)).toBe(2)
  })
  it('starts from now when not ad-free (or expired), and stacks on time left', () => {
    expect(extendAdFree(null, NOW, 14, 1)).toBe(new Date(NOW + 14 * DAY_MS).toISOString())
    expect(extendAdFree(new Date(NOW - DAY_MS).toISOString(), NOW, 14, 1)).toBe(new Date(NOW + 14 * DAY_MS).toISOString())
    const left = new Date(NOW + 3 * DAY_MS).toISOString()
    expect(extendAdFree(left, NOW, 14, 1)).toBe(new Date(NOW + 17 * DAY_MS).toISOString())
    expect(extendAdFree(left, NOW, 14, 2)).toBe(new Date(NOW + 31 * DAY_MS).toISOString())
  })
})

describe('who counts', () => {
  const claim = (over: Partial<ClaimInput> = {}): ClaimInput => ({
    userId: 'new',
    email: 'newbie@gmail.com',
    createdAt: NOW - 60_000,
    openedAt: NOW - 3_600_000,
    referrer: { userId: 'ref', emailNormalized: 'referrer@gmail.com' },
    inboxTaken: false,
    alreadyReferred: false,
    now: NOW,
    ...over,
  })

  it('accepts a new account made after opening the link', () => {
    expect(checkClaim(claim())).toEqual({ ok: true })
  })
  it('refuses self-referrals, including the same Gmail inbox written differently', () => {
    expect(checkClaim(claim({ userId: 'ref' }))).toMatchObject({ ok: false, reason: 'self' })
    expect(checkClaim(claim({ email: 'Re.Ferrer+2@gmail.com' }))).toMatchObject({ ok: false, reason: 'same-inbox' })
  })
  it('refuses a second account for an inbox that already has one', () => {
    expect(checkClaim(claim({ inboxTaken: true }))).toMatchObject({ ok: false, reason: 'duplicate-inbox' })
  })
  it('refuses accounts that existed before the link, or over 7 days old', () => {
    expect(checkClaim(claim({ createdAt: NOW - 2 * 3_600_000 }))).toMatchObject({ ok: false, reason: 'not-new' })
    expect(checkClaim(claim({ createdAt: NOW - 8 * DAY_MS, openedAt: null }))).toMatchObject({ ok: false, reason: 'not-new' })
    // A link opened "8 days ago" is still bounded by the 7 days.
    expect(checkClaim(claim({ createdAt: NOW - 7.5 * DAY_MS, openedAt: NOW - 8 * DAY_MS }))).toMatchObject({ ok: false, reason: 'not-new' })
  })
  it('counts each new account once, for a real code', () => {
    expect(checkClaim(claim({ alreadyReferred: true }))).toMatchObject({ ok: false, reason: 'already' })
    expect(checkClaim(claim({ referrer: null }))).toMatchObject({ ok: false, reason: 'unknown-code' })
  })

  const count = (over: Partial<CountInput> = {}): CountInput => ({
    status: 'pending',
    emailConfirmed: true,
    countedFromIpToday: 0,
    referrerSameIp: false,
    siblingsSameIp: 0,
    claimsLastHour: 0,
    ipDailyLimit: 3,
    ...over,
  })
  it('counts on watching, once the email is confirmed', () => {
    expect(checkCount(count())).toEqual({ result: 'counted', flags: [] })
    expect(checkCount(count({ emailConfirmed: false })).result).toBe('skip')
    expect(checkCount(count({ status: 'counted' })).result).toBe('skip')
    expect(checkCount(count({ status: 'rejected' })).result).toBe('skip')
  })
  it('holds referrals over the per-network daily limit, and flags patterns', () => {
    expect(checkCount(count({ countedFromIpToday: 2 })).result).toBe('counted')
    expect(checkCount(count({ countedFromIpToday: 3 }))).toEqual({ result: 'held', flags: ['ip-limit'] })
    expect(checkCount(count({ referrerSameIp: true, siblingsSameIp: 2, claimsLastHour: 5 }))).toEqual({
      result: 'counted',
      flags: ['referrer-network', 'shared-network', 'burst'],
    })
  })
})

describe('weekly mystery prize', () => {
  it('runs Monday 00:00 to Sunday 23:59, Lagos time', () => {
    const week = lagosWeek(NOW)
    expect(week.key).toBe('2026-11-02')
    expect(new Date(week.start).toISOString()).toBe('2026-11-01T23:00:00.000Z') // Monday 00:00 Lagos
    expect(new Date(week.end).toISOString()).toBe('2026-11-08T23:00:00.000Z')
    // Sunday 23:30 Lagos is still this week; Monday 00:30 Lagos is the next.
    expect(lagosWeek(Date.UTC(2026, 10, 8, 22, 30)).key).toBe('2026-11-02')
    expect(lagosWeek(Date.UTC(2026, 10, 8, 23, 30)).key).toBe('2026-11-09')
    expect(weekOf('2026-11-02')).toEqual(week)
    expect(weekOf('2026-11-03')).toBeNull()
  })

  it('ranks by counted referrals that week; a tie goes to who got there first', () => {
    const week = lagosWeek(NOW)
    const at = (hours: number) => new Date(week.start + hours * 3_600_000).toISOString()
    const rows = [
      { referrer_id: 'b', counted_at: at(1) },
      { referrer_id: 'a', counted_at: at(2) },
      { referrer_id: 'b', counted_at: at(5) },
      { referrer_id: 'a', counted_at: at(4) },
      { referrer_id: 'c', counted_at: at(3) },
      // Last week: not counted.
      { referrer_id: 'c', counted_at: new Date(week.start - 1000).toISOString() },
      { referrer_id: 'c', counted_at: null },
    ]
    const ranking = rankWeek(rows, week)
    expect(ranking.map((r) => [r.userId, r.count])).toEqual([
      ['a', 2],
      ['b', 2],
      ['c', 1],
    ])
    expect(weeklyWinner(ranking, new Set())?.userId).toBe('a')
    expect(weeklyWinner(ranking, new Set(['a']))?.userId).toBe('b')
    expect(weeklyWinner([], new Set())).toBeNull()
  })
})
