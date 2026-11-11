import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleReferral, readReferralEnv } from './handlers'
import { DAY_MS, normalizeEmail } from './rules'
import { fakeStore } from '../testing/referralStore'

import { NOW } from '../testing/referralStore'

const env = readReferralEnv({
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  ADMIN_PASSWORD: 'admin-pw',
  AD_FREE_EMAILS: 'aaabswag@gmail.com,brunoeneh234@gmail.com',
  AD_FREE_DAYS: '14',
  REFERRAL_SALT: 'salt',
})

async function call(
  fake: ReturnType<typeof fakeStore>,
  action: string,
  init: { method?: string; token?: string; body?: unknown; ip?: string; query?: string; env?: typeof env; fetchImpl?: typeof fetch } = {},
) {
  const req = Readable.from(init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))]) as unknown as IncomingMessage
  req.method = init.method ?? (init.body === undefined ? 'GET' : 'POST')
  req.url = `/api/referral/${action}${init.query ?? ''}`
  req.headers = {
    ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    'x-forwarded-for': init.ip ?? '1.2.3.4',
  }
  let status = 0
  let body = ''
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text: string) {
      status = this.statusCode
      body = text
    },
  } as unknown as ServerResponse
  await handleReferral(init.env ?? env, action, req, res, { store: fake.store, now: fake.clock.now, fetchImpl: init.fetchImpl })
  return { status, json: JSON.parse(body) as Record<string, unknown> }
}

let fake: ReturnType<typeof fakeStore>
beforeEach(() => {
  fake = fakeStore()
})

const codeOf = async (userId: string) => (await call(fake, 'status', { token: `token-${userId}` })).json.code as string

/** A friend opens the link, signs up, confirms and watches, from their own network. */
async function invite(code: string, n: number, opts: { ip?: string; confirmed?: boolean } = {}) {
  const id = fake.addUser(`friend-${n}`, `friend${n}@gmail.com`, fake.clock.now - 60_000, opts.confirmed ?? true)
  const ip = opts.ip ?? `10.0.0.${n}`
  await call(fake, 'claim', { token: `token-${id}`, body: { code, openedAt: fake.clock.now - 3_600_000 }, ip })
  return (await call(fake, 'watched', { token: `token-${id}`, body: {}, ip })).json.status
}

describe('/api/referral/status: the ad-free check', () => {
  it('without a session: only the goal, never ad-free', async () => {
    expect((await call(fake, 'status')).json).toEqual({ goal: 5, signedIn: false, adFree: false, premium: false, promo: null, trial: { start: '2026-11-17T22:59:59.000Z', live: false }, serverNow: NOW })
  })

  it('refuses a forged token', async () => {
    expect((await call(fake, 'ad-free', { token: 'token-nobody' })).status).toBe(401)
  })

  it('is ad-free for the allowlisted accounts (from the server env only)', async () => {
    fake.addUser('owner', 'aaabswag@gmail.com', NOW - 100 * DAY_MS)
    fake.addUser('bruno', 'Bruno.Eneh234@gmail.com', NOW - 100 * DAY_MS)
    fake.addUser('other', 'someone@gmail.com', NOW - 100 * DAY_MS)
    expect((await call(fake, 'ad-free', { token: 'token-owner' })).json).toMatchObject({ signedIn: true, adFree: true, permanent: true })
    expect((await call(fake, 'ad-free', { token: 'token-bruno' })).json).toMatchObject({ adFree: true, permanent: true })
    expect((await call(fake, 'ad-free', { token: 'token-other' })).json).toMatchObject({ adFree: false, permanent: false })
  })

  it('gives every user an invite code and link', async () => {
    fake.addUser('ada', 'ada@gmail.com')
    const { json } = await call(fake, 'status', { token: 'token-ada' })
    expect(json.code).toMatch(/^[A-Z2-9]{6}$/)
    expect(json.link).toBe(`https://www.naijatr.com/r/${json.code}`)
    expect(fake.profiles.get('ada')?.email_normalized).toBe('ada@gmail.com')
    // The same code next time.
    expect(await codeOf('ada')).toBe(json.code)
  })
})

describe('the Free Ad-Free Week', () => {
  const promoEnv = { ...env, promo: { start: Date.parse('2026-11-11T00:00:00+01:00'), end: Date.parse('2026-11-17T23:59:59+01:00') } }
  const BEFORE = Date.parse('2026-11-10T23:59:59+01:00')
  const DURING = Date.parse('2026-11-11T00:00:00+01:00')
  const AFTER = Date.parse('2026-11-18T00:00:00+01:00')
  const END = '2026-11-17T22:59:59.000Z'
  const status = async (token: string | undefined, now: number) => {
    fake.clock.now = now
    return (await call(fake, 'status', { token, env: promoEnv })).json
  }

  it('makes every signed-in account ad-free during the week only, on the server clock', async () => {
    fake.addUser('ada', 'ada@gmail.com', NOW - 100 * DAY_MS)
    expect(await status('token-ada', BEFORE)).toMatchObject({ adFree: false, promoAdFree: false, ownAdFree: false, promo: { state: 'upcoming' } })
    expect(await status('token-ada', DURING)).toMatchObject({
      adFree: true,
      adFreeUntil: END,
      permanent: false,
      promoAdFree: true,
      ownAdFree: false,
      promo: { state: 'active', end: END },
      serverNow: DURING,
    })
    expect(await status('token-ada', AFTER)).toMatchObject({ adFree: false, adFreeUntil: null, promoAdFree: false, promo: { state: 'ended' } })
    // A rule, not a grant: nothing is written to their ad-free time.
    expect(fake.profiles.get('ada')?.ad_free_until).toBeNull()
    expect(fake.grants).toHaveLength(0)
  })

  it('includes accounts made during the week', async () => {
    fake.addUser('new', 'new@gmail.com', DURING + 60_000)
    expect(await status('token-new', DURING + 120_000)).toMatchObject({ adFree: true, promoAdFree: true })
  })

  it('leaves paid, referral and allowlisted ad-free as it is, before, during and after', async () => {
    fake.addUser('paid', 'paid@gmail.com', NOW - 100 * DAY_MS)
    fake.addUser('owner', 'aaabswag@gmail.com', NOW - 100 * DAY_MS)
    fake.addUser('ref', 'ref@gmail.com', NOW - 100 * DAY_MS)
    // Paid until after the week; a referral reward that ends in the middle of it.
    const paidUntil = '2026-12-01T10:00:00.000Z'
    const rewardUntil = '2026-11-13T10:00:00.000Z'
    await fake.store.saveProfile('paid', { ad_free_until: paidUntil })
    await fake.store.saveProfile('ref', { ad_free_until: rewardUntil })
    for (const now of [BEFORE, DURING, AFTER]) {
      expect(await status('token-paid', now)).toMatchObject({ adFree: true, adFreeUntil: paidUntil, ownAdFree: true, promoAdFree: false })
      expect(await status('token-owner', now)).toMatchObject({ adFree: true, permanent: true, ownAdFree: true, promoAdFree: false })
    }
    expect(await status('token-ref', DURING)).toMatchObject({ adFree: true, adFreeUntil: rewardUntil, ownAdFree: true })
    // Their reward over, the week carries them to its end; then ads.
    expect(await status('token-ref', Date.parse('2026-11-15T10:00:00Z'))).toMatchObject({ adFree: true, adFreeUntil: END, ownAdFree: false, promoAdFree: true })
    expect(await status('token-ref', AFTER)).toMatchObject({ adFree: false })
    expect(fake.profiles.get('paid')?.ad_free_until).toBe(paidUntil)
    expect(fake.profiles.get('ref')?.ad_free_until).toBe(rewardUntil)
  })

  it('tells signed-out visitors about the week, but they keep ads', async () => {
    expect(await status(undefined, DURING)).toEqual({
      goal: 5,
      signedIn: false,
      adFree: false,
      premium: false,
      promo: { start: '2026-11-10T23:00:00.000Z', end: END, state: 'active' },
      trial: { start: END, live: false },
      serverNow: DURING,
    })
  })

  it('is off without PROMO_START / PROMO_END', async () => {
    fake.addUser('ada', 'ada@gmail.com', NOW - 100 * DAY_MS)
    fake.clock.now = DURING
    expect((await call(fake, 'status', { token: 'token-ada' })).json).toMatchObject({ adFree: false, promo: null })
  })
})

describe('the Free Ad-Free Week email (/admin/live)', () => {
  const mailEnv = {
    ...env,
    resendKey: 're_test',
    resendFrom: 'NAIJA TR <hello@naijatr.com>',
    promo: { start: Date.parse('2026-11-11T00:00:00+01:00'), end: Date.parse('2026-11-17T23:59:59+01:00') },
  }
  const resend = () => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch & ReturnType<typeof vi.fn>
  beforeEach(() => {
    fake.clock.now = Date.parse('2026-11-10T22:15:00+01:00')
    fake.addUser('owner', 'aaabswag@gmail.com')
    fake.addUser('ada', 'ada@gmail.com')
    // The same inbox as ada's: one email.
    fake.addUser('ada2', 'A.da+films@gmail.com')
    fake.addUser('ben', 'ben@yahoo.com')
  })

  it('is admin-only', async () => {
    expect((await call(fake, 'admin-promo-email', { env: mailEnv })).status).toBe(401)
    expect((await call(fake, 'admin-promo-email', { env: mailEnv, token: 'wrong' })).status).toBe(401)
  })

  it('shows the email and how many accounts get it, one per inbox, without sending', async () => {
    const fetchImpl = resend()
    const { status, json } = await call(fake, 'admin-promo-email', { env: mailEnv, token: 'admin-pw', fetchImpl })
    expect(status).toBe(200)
    expect(json.recipients).toBe(3)
    expect(json.subject).toBe('🎉 FREE AD-FREE WEEK on NAIJA TR!')
    expect(json.text).toContain('from Wednesday, 11 Nov at 12:00 AM until Tuesday, 17 Nov at 11:59 PM (Lagos time), you can watch with NO ADS.')
    expect(json.text).toContain('sign in at www.naijatr.com with this email')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends only with the confirmed number, one email to each person', async () => {
    const fetchImpl = resend()
    expect((await call(fake, 'admin-promo-email', { env: mailEnv, token: 'admin-pw', body: { confirm: 2 }, fetchImpl })).json).toEqual({
      error: 'count-changed',
      recipients: 3,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    const { status, json } = await call(fake, 'admin-promo-email', { env: mailEnv, token: 'admin-pw', body: { confirm: 3 }, fetchImpl })
    expect(status).toBe(200)
    expect(json).toEqual({ recipients: 3, sent: 3, errors: [] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails/batch')
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(`promo-week-${mailEnv.promo.start}-0`)
    const emails = JSON.parse(init.body as string) as { to: string[]; from: string }[]
    expect(emails.map((e) => e.to)).toEqual([['aaabswag@gmail.com'], ['ada@gmail.com'], ['ben@yahoo.com']])
    expect(emails.every((e) => e.from === mailEnv.resendFrom)).toBe(true)
  })

  it('sends in batches of 100', async () => {
    for (let n = 0; n < 150; n++) fake.addUser(`u${n}`, `user${n}@example.com`)
    const fetchImpl = resend()
    expect((await call(fake, 'admin-promo-email', { env: mailEnv, token: 'admin-pw', body: { confirm: 153 }, fetchImpl })).json).toMatchObject({ sent: 153 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('says "from now" once the week is on, and nothing to send after it', async () => {
    fake.clock.now = Date.parse('2026-11-12T10:00:00Z')
    expect((await call(fake, 'admin-promo-email', { env: mailEnv, token: 'admin-pw' })).json.text).toContain('from now until Tuesday, 17 Nov at 11:59 PM')
    fake.clock.now = Date.parse('2026-11-18T00:00:00+01:00')
    expect((await call(fake, 'admin-promo-email', { env: mailEnv, token: 'admin-pw' })).status).toBe(409)
  })
})

describe('counting and the ad-free unlock', () => {
  it('counts after sign-up, confirmation and a watch; unlocks ad-free at 5 and stacks at 10', async () => {
    fake.addUser('ada', 'ada@gmail.com', NOW - 30 * DAY_MS)
    const code = await codeOf('ada')
    for (let n = 1; n <= 4; n++) expect(await invite(code, n)).toBe('counted')
    let status = (await call(fake, 'status', { token: 'token-ada' })).json
    expect(status).toMatchObject({ counted: 4, adFree: false, rewards: 0, weekCount: 4 })

    expect(await invite(code, 5)).toBe('counted')
    status = (await call(fake, 'status', { token: 'token-ada' })).json
    expect(status).toMatchObject({ counted: 5, adFree: true, permanent: false, rewards: 1 })
    expect(status.adFreeUntil).toBe(new Date(NOW + 14 * DAY_MS).toISOString())

    // Three days later, five more: added to what's left.
    fake.clock.now = NOW + 3 * DAY_MS
    for (let n = 6; n <= 10; n++) await invite(code, n)
    status = (await call(fake, 'status', { token: 'token-ada' })).json
    expect(status).toMatchObject({ counted: 10, rewards: 2 })
    expect(status.adFreeUntil).toBe(new Date(NOW + 28 * DAY_MS).toISOString())

    // And it ends.
    fake.clock.now = NOW + 29 * DAY_MS
    expect((await call(fake, 'ad-free', { token: 'token-ada' })).json.adFree).toBe(false)
  })

  it('waits for the email to be confirmed, then counts on the next watch', async () => {
    fake.addUser('ada', 'ada@gmail.com', NOW - DAY_MS)
    const code = await codeOf('ada')
    expect(await invite(code, 1, { confirmed: false })).toBe('pending')
    fake.users.get('friend-1')!.emailConfirmed = true
    expect((await call(fake, 'watched', { token: 'token-friend-1', body: {} })).json.status).toBe('counted')
    // Each new account counts once.
    expect((await call(fake, 'watched', { token: 'token-friend-1', body: {} })).json.status).toBe('counted')
    expect(fake.referrals.filter((r) => r.status === 'counted')).toHaveLength(1)
  })

  it('refuses self-referrals, the same inbox, a second account for an inbox, and old accounts', async () => {
    fake.addUser('ada', 'ada.obi@gmail.com', NOW - DAY_MS)
    const code = await codeOf('ada')
    // Ada's own second account for the same Gmail inbox.
    fake.addUser('ada2', 'adaobi+2@gmail.com')
    expect((await call(fake, 'claim', { token: 'token-ada2', body: { code } })).json).toMatchObject({ reason: 'same-inbox' })
    // Ada's own code, signed in as Ada (her account isn't new for her own link either).
    fake.users.get('ada')!.createdAt = NOW - 60_000
    fake.referrals.length = 0
    expect((await call(fake, 'claim', { token: 'token-ada', body: { code } })).json).toMatchObject({ reason: 'self' })
    // An inbox that already has an account here.
    fake.addUser('chi', 'chi@gmail.com', NOW - 60_000)
    await codeOf('chi')
    fake.addUser('chi2', 'c.h.i@gmail.com')
    expect((await call(fake, 'claim', { token: 'token-chi2', body: { code } })).json).toMatchObject({ reason: 'duplicate-inbox' })
    // An account made long before the link.
    fake.addUser('old', 'old@gmail.com', NOW - 30 * DAY_MS)
    expect((await call(fake, 'claim', { token: 'token-old', body: { code } })).json).toMatchObject({ reason: 'not-new' })
    expect(fake.referrals.every((r) => r.status === 'rejected')).toBe(true)
    expect(normalizeEmail('c.h.i@gmail.com')).toBe('chi@gmail.com')
  })

  it('holds referrals over the daily limit for one network, flagged for review', async () => {
    fake.addUser('ada', 'ada@gmail.com', NOW - DAY_MS)
    const code = await codeOf('ada')
    const results = []
    for (let n = 1; n <= 5; n++) results.push(await invite(code, n, { ip: '9.9.9.9' }))
    expect(results).toEqual(['counted', 'counted', 'counted', 'held', 'held'])
    expect(fake.referrals.find((r) => r.status === 'held')?.flags).toContain('ip-limit')
    expect(fake.referrals.every((r) => r.ip_hash && !r.ip_hash.includes('9.9.9.9'))).toBe(true)
    // No unlock from held referrals.
    expect((await call(fake, 'status', { token: 'token-ada' })).json).toMatchObject({ counted: 3, pending: 2, adFree: false })
  })
})

describe('/admin/referrals', () => {
  it('needs the admin password', async () => {
    expect((await call(fake, 'admin')).status).toBe(401)
    expect((await call(fake, 'admin', { token: 'wrong' })).status).toBe(401)
  })

  it('shows the week’s top 10 with emails and flags, and confirms one winner', async () => {
    fake.addUser('ada', 'ada@gmail.com', NOW - DAY_MS)
    fake.addUser('bola', 'bola@gmail.com', NOW - DAY_MS)
    const ada = await codeOf('ada')
    const bola = await codeOf('bola')
    await invite(ada, 1)
    fake.clock.now += 60_000
    // Three of Bola's friends on one network: flagged.
    for (const n of [2, 3, 4]) await invite(bola, n, { ip: '10.0.0.2' })
    fake.clock.now += 60_000
    await invite(ada, 5)
    const { json } = await call(fake, 'admin', { token: 'admin-pw' })
    const top = json.top as { email: string; count: number; flags: string[] }[]
    expect(top.map((r) => [r.email, r.count])).toEqual([
      ['bola@gmail.com', 3],
      ['ada@gmail.com', 2],
    ])
    expect(top[0].flags).toContain('shared-network')
    expect(top[1].flags).toEqual([])
    expect(json.suggested).toBe('bola')
    expect(json.totals).toMatchObject({ counted: 5 })

    const week = (json.week as { key: string }).key
    expect((await call(fake, 'decide', { token: 'admin-pw', body: { week, userId: 'bola', decision: 'disqualified' } })).status).toBe(200)
    expect((await call(fake, 'admin', { token: 'admin-pw' })).json.suggested).toBe('ada')
    expect((await call(fake, 'decide', { token: 'admin-pw', body: { week, userId: 'ada', decision: 'winner' } })).status).toBe(200)
    expect((await call(fake, 'decide', { token: 'admin-pw', body: { week, userId: 'bola', decision: 'winner' } })).status).toBe(409)
    const after = (await call(fake, 'admin', { token: 'admin-pw' })).json
    expect(after.winners).toEqual([expect.objectContaining({ week, email: 'ada@gmail.com', referrals: 2 })])
  })
})

describe('Give ad-free (/admin/live)', () => {
  const admin = { token: 'admin-pw' }
  const give = (body: Record<string, unknown>) => call(fake, 'admin-grant', { ...admin, body })

  it('is admin-only', async () => {
    fake.addUser('ada', 'ada@gmail.com')
    for (const token of [undefined, 'wrong', 'token-ada']) {
      expect((await call(fake, 'admin-grant', { token, body: { email: 'ada@gmail.com', days: 30 } })).status).toBe(401)
      expect((await call(fake, 'admin-remove', { token, body: { email: 'ada@gmail.com' } })).status).toBe(401)
      expect((await call(fake, 'admin-ad-free', { token })).status).toBe(401)
    }
    expect(fake.grants).toHaveLength(0)
    expect(fake.profiles.get('ada')?.ad_free_until ?? null).toBeNull()
  })

  it('gives ad-free by email (any case, Gmail dots and +tags), stacking on time left', async () => {
    fake.addUser('ada', 'ada.obi@gmail.com', NOW - 30 * DAY_MS)
    let res = await give({ email: 'AdaObi+tv@GMAIL.com', days: 30, plan: '1 Month', amount: 2000, note: 'paid via PalmPay' })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ email: 'ada.obi@gmail.com', adFree: true, adFreeUntil: new Date(NOW + 30 * DAY_MS).toISOString() })
    // Ten days later, 3 months more: added to the 20 days left.
    fake.clock.now = NOW + 10 * DAY_MS
    res = await give({ email: 'ada.obi@gmail.com', days: 90, plan: '3 Months', amount: 5000 })
    expect(res.json.adFreeUntil).toBe(new Date(NOW + 120 * DAY_MS).toISOString())
    // The account sees it (and the grant, for the "active until" message).
    const status = (await call(fake, 'status', { token: 'token-ada' })).json
    expect(status).toMatchObject({ adFree: true, adFreeUntil: new Date(NOW + 120 * DAY_MS).toISOString(), lastGrant: { id: fake.grants[0].id } })
    expect(fake.grants.map((g) => [g.action, g.days, g.amount, g.email, g.user_id])).toEqual([
      ['grant', 90, 5000, 'ada.obi@gmail.com', 'ada'],
      ['grant', 30, 2000, 'ada.obi@gmail.com', 'ada'],
    ])
    expect(fake.grants[1].note).toBe('paid via PalmPay')
  })

  it('stacks on referral ad-free too, and starts from now once it has ended', async () => {
    fake.addUser('ada', 'ada@gmail.com')
    await codeOf('ada')
    fake.profiles.get('ada')!.ad_free_until = new Date(NOW + 5 * DAY_MS).toISOString()
    expect((await give({ email: 'ada@gmail.com', days: 30 })).json.adFreeUntil).toBe(new Date(NOW + 35 * DAY_MS).toISOString())
    fake.clock.now = NOW + 100 * DAY_MS
    expect((await give({ email: 'ada@gmail.com', days: 30 })).json.adFreeUntil).toBe(new Date(NOW + 130 * DAY_MS).toISOString())
  })

  it('says when no account has that email, and checks the days and amount', async () => {
    expect((await give({ email: 'nobody@gmail.com', days: 30 })).status).toBe(404)
    fake.addUser('ada', 'ada@gmail.com')
    for (const days of [0, -5, 1.5, 'x', 99999]) expect((await give({ email: 'ada@gmail.com', days })).status).toBe(400)
    expect((await give({ email: 'ada@gmail.com', days: 30, amount: -1 })).status).toBe(400)
    expect(fake.grants).toHaveLength(0)
  })

  it('removes ad-free (ads come back), logging a refund', async () => {
    fake.addUser('ada', 'ada@gmail.com')
    await give({ email: 'ada@gmail.com', days: 30, amount: 2000 })
    const res = await call(fake, 'admin-remove', { ...admin, body: { email: 'ada@gmail.com', amount: 2000, note: 'refund' } })
    expect(res.json).toMatchObject({ adFree: false, adFreeUntil: null })
    expect((await call(fake, 'ad-free', { token: 'token-ada' })).json.adFree).toBe(false)
    expect(fake.grants[0]).toMatchObject({ action: 'remove', days: 0, amount: -2000, note: 'refund' })
  })

  it('lists everyone ad-free now with their source and last note, and the totals', async () => {
    fake.addUser('owner', 'aaabswag@gmail.com')
    fake.addUser('paid', 'paid@gmail.com')
    fake.addUser('ref', 'ref@gmail.com')
    fake.addUser('gone', 'gone@gmail.com')
    await codeOf('ref')
    fake.profiles.get('ref')!.ad_free_until = new Date(NOW + 9 * DAY_MS).toISOString()
    fake.profiles.get('ref')!.rewards_granted = 1
    await give({ email: 'gone@gmail.com', days: 30, amount: 2000 })
    await call(fake, 'admin-remove', { ...admin, body: { email: 'gone@gmail.com' } })
    fake.clock.now += 60_000
    await give({ email: 'paid@gmail.com', days: 90, amount: 5000, note: 'paid via PalmPay' })

    const { json } = await call(fake, 'admin-ad-free', admin)
    const users = json.users as { email: string; sources: string[]; note: string | null; adFreeUntil: string | null }[]
    expect(users.map((u) => [u.email, u.sources, u.note])).toEqual([
      ['paid@gmail.com', ['paid'], 'paid via PalmPay'],
      ['ref@gmail.com', ['referral'], null],
      ['aaabswag@gmail.com', ['allowlist'], null],
    ])
    expect(users.find((u) => u.email === 'aaabswag@gmail.com')?.adFreeUntil).toBeNull()
    // Gone's ₦2,000 still counts (no refund entered); two paid users this month.
    expect(json).toMatchObject({ paidUsersThisMonth: 2, week: 7000, month: 7000 })
    expect((json.log as unknown[]).length).toBe(3)
  })
})

describe('the "ad-free is active" email', () => {
  const mailEnv = { ...env, resendKey: 're_test', resendFrom: 'NAIJA TR <hello@naijatr.com>' }
  const resend = (status = 200, body: unknown = { id: 'm1' }) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('goes to the person when ad-free is given, with the end date and the renew link', async () => {
    fake.addUser('ada', 'ada.obi@gmail.com')
    const fetchImpl = resend()
    const res = await call(fake, 'admin-grant', { token: 'admin-pw', env: mailEnv, fetchImpl, body: { email: 'adaobi@gmail.com', days: 30 } })
    expect(res.json.mail).toEqual({ sent: true })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test')
    const mail = JSON.parse(init.body as string) as { from: string; to: string[]; subject: string; text: string }
    expect(mail).toMatchObject({ from: 'NAIJA TR <hello@naijatr.com>', to: ['ada.obi@gmail.com'], subject: '🎉 Your NAIJA TR ad-free is active' })
    expect(mail.text).toContain('active on your account until 4 December 2026')
    expect(mail.text).toContain('https://t.me/Dfw_Brun0')
  })

  it('says why when it can’t be sent, and the grant still stands', async () => {
    fake.addUser('ada', 'ada@gmail.com')
    const res = await call(fake, 'admin-grant', {
      token: 'admin-pw',
      env: mailEnv,
      fetchImpl: resend(403, { message: 'The naijatr.com domain is not verified.' }),
      body: { email: 'ada@gmail.com', days: 30 },
    })
    expect(res.json).toMatchObject({ adFree: true, mail: { sent: false, error: 'The naijatr.com domain is not verified.' } })
    // Not set up at all.
    expect((await call(fake, 'admin-grant', { token: 'admin-pw', body: { email: 'ada@gmail.com', days: 1 } })).json.mail).toMatchObject({ sent: false })
    // Removing sends nothing.
    const fetchImpl = resend()
    expect((await call(fake, 'admin-remove', { token: 'admin-pw', env: mailEnv, fetchImpl, body: { email: 'ada@gmail.com' } })).json.mail).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('"Email them" sends it again to someone ad-free now (admin only)', async () => {
    fake.addUser('ada', 'ada@gmail.com')
    fake.addUser('bola', 'bola@gmail.com')
    await call(fake, 'admin-grant', { token: 'admin-pw', body: { email: 'ada@gmail.com', days: 30 } })
    const fetchImpl = resend()
    expect((await call(fake, 'admin-email', { token: 'admin-pw', env: mailEnv, fetchImpl, body: { userId: 'ada' } })).json).toEqual({ email: 'ada@gmail.com', mail: { sent: true } })
    expect((await call(fake, 'admin-email', { token: 'admin-pw', env: mailEnv, fetchImpl, body: { userId: 'bola' } })).status).toBe(409)
    expect((await call(fake, 'admin-email', { token: 'wrong', env: mailEnv, fetchImpl, body: { userId: 'ada' } })).status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
