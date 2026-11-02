import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it } from 'vitest'
import { handleReferral, readReferralEnv } from './handlers'
import { DAY_MS, normalizeEmail } from './rules'
import type { AuthUser, Profile, Referral, ReferralStore, WeekDecision } from './store'

const NOW = Date.UTC(2026, 10, 4, 12)

/** Supabase, in memory. Tokens are "token-<userId>". */
function fakeStore() {
  const users = new Map<string, AuthUser>()
  const profiles = new Map<string, Profile>()
  const referrals: Referral[] = []
  const decisions: WeekDecision[] = []
  let nextId = 1
  const store: ReferralStore = {
    async userFromToken(token) {
      return users.get(token.replace(/^token-/, '')) ?? null
    },
    async emailOf(userId) {
      return users.get(userId)?.email ?? null
    },
    async getProfile(userId) {
      return profiles.get(userId) ?? null
    },
    async profileByCode(code) {
      return [...profiles.values()].find((p) => p.invite_code === code) ?? null
    },
    async saveProfile(userId, patch) {
      if (patch.invite_code && [...profiles.values()].some((p) => p.invite_code === patch.invite_code && p.user_id !== userId)) throw new Error('taken')
      const profile: Profile = { user_id: userId, invite_code: null, ad_free_until: null, rewards_granted: 0, email_normalized: null, last_ip_hash: null, ...profiles.get(userId), ...patch }
      profiles.set(userId, profile)
      return profile
    },
    async inboxTaken(email, except) {
      return [...profiles.values()].some((p) => p.email_normalized === email && p.user_id !== except)
    },
    async grantReward(userId, expected, granted, until) {
      const p = profiles.get(userId)
      if (!p || p.rewards_granted !== expected) return false
      profiles.set(userId, { ...p, rewards_granted: granted, ad_free_until: until })
      return true
    },
    async referralOf(id) {
      return referrals.find((r) => r.referred_user_id === id) ?? null
    },
    async insertReferral(row) {
      if (referrals.some((r) => r.referred_user_id === row.referred_user_id)) return null
      const referral: Referral = { id: nextId++, flags: [], created_at: new Date(clock.now).toISOString(), counted_at: null, ...row }
      referrals.push(referral)
      return referral
    },
    async updateReferral(id, from, patch) {
      const r = referrals.find((x) => x.id === id)
      if (!r || r.status !== from) return false
      Object.assign(r, patch)
      return true
    },
    async countedFromIp(ip, since) {
      return referrals.filter((r) => r.ip_hash === ip && r.status === 'counted' && r.counted_at! >= since).length
    },
    async referralsOf(id) {
      return referrals.filter((r) => r.referrer_id === id)
    },
    async countedBetween(from, to) {
      return referrals.filter((r) => r.status === 'counted' && r.counted_at! >= from && r.counted_at! < to)
    },
    async totals() {
      const n = (s: string) => referrals.filter((r) => r.status === s).length
      return { pending: n('pending'), counted: n('counted'), held: n('held'), rejected: n('rejected') }
    },
    async decisions(week) {
      return decisions.filter((d) => !week || d.week_start === week)
    },
    async setDecision(row) {
      if (row.decision === 'winner' && decisions.some((d) => d.week_start === row.week_start && d.decision === 'winner' && d.user_id !== row.user_id)) return false
      const i = decisions.findIndex((d) => d.week_start === row.week_start && d.user_id === row.user_id)
      if (i >= 0) decisions.splice(i, 1)
      decisions.push({ ...row, decided_at: new Date(clock.now).toISOString() })
      return true
    },
    async clearDecision(week, userId) {
      const i = decisions.findIndex((d) => d.week_start === week && d.user_id === userId)
      if (i >= 0) decisions.splice(i, 1)
    },
  }
  const clock = { now: NOW }
  const addUser = (id: string, email: string, createdAt = clock.now - 60_000, emailConfirmed = true) => {
    users.set(id, { id, email, createdAt, emailConfirmed })
    return id
  }
  return { store, users, profiles, referrals, decisions, clock, addUser }
}

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
  init: { method?: string; token?: string; body?: unknown; ip?: string; query?: string } = {},
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
  await handleReferral(env, action, req, res, { store: fake.store, now: fake.clock.now })
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
    expect((await call(fake, 'status')).json).toEqual({ goal: 5, signedIn: false, adFree: false })
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
