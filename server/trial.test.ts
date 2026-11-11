import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it } from 'vitest'
import { handleReferral, premiumState, readReferralEnv } from './referral/handlers'
import { normalizeEmail } from './referral/rules'
import type { TrialStore, WelcomeTrial } from './referral/store'
import { fakeStore } from './testing/referralStore'
import { checkTrial, readTrialConfig, trialInbox } from './trial'

const HOUR = 60 * 60 * 1000
const PROMO_START = '2026-11-11T00:00:00+01:00'
const PROMO_END = '2026-11-17T23:59:59+01:00'
const END = Date.parse(PROMO_END)
const DURING = Date.parse('2026-11-14T12:00:00+01:00')
/** Two hours after the trial starts. */
const AFTER = END + 2 * HOUR

const env = readReferralEnv({
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  ADMIN_PASSWORD: 'admin-pw',
  AD_FREE_EMAILS: 'owner@gmail.com',
  REFERRAL_SALT: 'salt',
  PROMO_START,
  PROMO_END,
  TRIAL_HOURS: '48',
  TRIAL_ENABLED: 'true',
})

/** Migration 004, in memory: profiles' trial columns, known_emails and welcome_trials. */
function fakeTrials(referral: ReturnType<typeof fakeStore>) {
  const profileTrial = new Map<string, { welcome_trial_until: string | null; signup_source: string | null }>()
  const known = new Map<string, string>()
  const trials = new Map<string, WelcomeTrial>()
  const store: TrialStore = {
    async trialOf(userId) {
      if (!referral.profiles.has(userId)) return null
      return profileTrial.get(userId) ?? { welcome_trial_until: null, signup_source: null }
    },
    async rememberInbox(inbox, userId) {
      if (!known.has(inbox)) known.set(inbox, userId)
      return known.get(inbox)!
    },
    async trialForInbox(inbox) {
      return trials.get(inbox) ?? null
    },
    async deviceHadTrial(device, except) {
      return [...trials.values()].some((t) => t.device_hash === device && t.email_normalized !== except)
    },
    async insertTrial(row) {
      if (trials.has(row.email_normalized)) return false
      trials.set(row.email_normalized, { ...row, created_at: new Date(referral.clock.now).toISOString() })
      return true
    },
    async setTrialUntil(userId, until) {
      profileTrial.set(userId, { signup_source: null, ...profileTrial.get(userId), welcome_trial_until: until })
    },
    async setSignupSource(userId, source) {
      profileTrial.set(userId, { welcome_trial_until: null, ...profileTrial.get(userId), signup_source: source })
    },
    async stats(now, dayStart) {
      const list = [...trials.values()]
      const premiumIds = [...referral.profiles.values()]
        .filter((p) => (p.ad_free_until && Date.parse(p.ad_free_until) > now) || Date.parse(profileTrial.get(p.user_id)?.welcome_trial_until ?? '') > now)
        .map((p) => p.user_id)
      return {
        startedToday: list.filter((t) => Date.parse(t.created_at) >= dayStart).length,
        active: list.filter((t) => Date.parse(t.until) > now).length,
        playSignups: [...profileTrial.values()].filter((p) => p.signup_source === 'play-popup').length,
        playSignupsToday: [...profileTrial.values()].filter((p) => p.signup_source === 'play-popup').length,
        premiumIds,
      }
    },
  }
  /** An account deleted: its login and profile go; known_emails and welcome_trials stay. */
  const deleteAccount = (userId: string) => {
    referral.users.delete(userId)
    referral.profiles.delete(userId)
    profileTrial.delete(userId)
  }
  return { store, known, trials, profileTrial, deleteAccount }
}

let referral: ReturnType<typeof fakeStore>
let trials: ReturnType<typeof fakeTrials>
beforeEach(() => {
  referral = fakeStore(AFTER)
  trials = fakeTrials(referral)
})

async function status(userId: string | undefined, now: number, headers: Record<string, string> = {}, useEnv = env) {
  referral.clock.now = now
  const req = Readable.from([]) as unknown as IncomingMessage
  req.method = 'GET'
  req.url = '/api/referral/status'
  req.headers = { ...(userId ? { authorization: `Bearer token-${userId}` } : {}), 'x-forwarded-for': '1.2.3.4', ...headers }
  let body = ''
  const res = { statusCode: 200, setHeader() {}, end(text: string) { body = text } } as unknown as ServerResponse
  await handleReferral(useEnv, 'status', req, res, { store: referral.store, trials: trials.store, now })
  return JSON.parse(body) as Record<string, unknown>
}

/** A new account, made and confirmed at `at`. */
function signUp(id: string, email: string, at: number) {
  referral.addUser(id, email, at)
  referral.users.get(id)!.emailConfirmedAt = at + 60_000
  return at + 60_000
}

describe('the welcome trial: config', () => {
  it('starts at PROMO_END, for 48 hours, on by default', () => {
    expect(readTrialConfig({ PROMO_END })).toEqual({ enabled: true, start: END, hours: 48 })
    expect(readTrialConfig({})).toMatchObject({ start: END, hours: 48 })
    expect(readTrialConfig({ PROMO_END, TRIAL_ENABLED: 'false' }).enabled).toBe(false)
    expect(readTrialConfig({ PROMO_END, TRIAL_START: '2026-12-01T00:00:00+01:00', TRIAL_HOURS: '24' })).toMatchObject({ start: Date.parse('2026-12-01T00:00:00+01:00'), hours: 24 })
  })

  it('normalizes Gmail: no dots, no +tag, googlemail is gmail; other providers lower case only', () => {
    expect(trialInbox('A.Da+films@GoogleMail.com')).toBe('ada@gmail.com')
    expect(trialInbox(' ada@gmail.com ')).toBe('ada@gmail.com')
    expect(trialInbox('a.d.a+1@gmail.com')).toBe('ada@gmail.com')
    expect(trialInbox('A.Da+x@yahoo.com')).toBe('a.da+x@yahoo.com')
    expect(trialInbox('x@gmail.com')).toBe(normalizeEmail('x@gmail.com'))
  })
})

describe('the welcome trial: who gets it', () => {
  it('does nothing before PROMO_END, even for an account made then', async () => {
    signUp('early', 'early@gmail.com', DURING)
    const before = await status('early', END - 1000)
    expect(before).toMatchObject({ premium: false, trialUntil: null, trialOnly: false, trial: { live: false } })
    // And an account made during the week doesn't get it later either.
    expect(await status('early', AFTER)).toMatchObject({ premium: false, trialUntil: null })
    expect(trials.trials.size).toBe(0)
  })

  it('gives a new inbox 48 hours from its email confirmation: ad-free, Premium, ad_free_until untouched', async () => {
    const confirmed = signUp('new', 'new.person@gmail.com', END + HOUR)
    const answer = await status('new', AFTER, { 'x-device-id': 'device-1' })
    const until = new Date(confirmed + 48 * HOUR).toISOString()
    expect(answer).toMatchObject({ signedIn: true, adFree: true, ownAdFree: true, promoAdFree: false, premium: true, trialOnly: true, trialUntil: until, adFreeUntil: until, trial: { live: true } })
    expect(referral.profiles.get('new')?.ad_free_until).toBeNull()
    expect(trials.trials.get('newperson@gmail.com')).toMatchObject({ user_id: 'new', until })
    // Asked again: the same end, not a new one.
    expect(await status('new', AFTER + 5 * HOUR)).toMatchObject({ trialUntil: until, premium: true })
  })

  it('needs a confirmed email first', async () => {
    referral.addUser('unconfirmed', 'u@gmail.com', END + HOUR, false)
    expect(await status('unconfirmed', AFTER)).toMatchObject({ premium: false, trialUntil: null })
    referral.users.get('unconfirmed')!.emailConfirmed = true
    referral.users.get('unconfirmed')!.emailConfirmedAt = AFTER
    expect(await status('unconfirmed', AFTER + 1000)).toMatchObject({ premium: true, trialUntil: new Date(AFTER + 48 * HOUR).toISOString() })
  })

  it('gives existing accounts nothing', async () => {
    referral.addUser('old', 'old@gmail.com', END - 30 * 24 * HOUR)
    referral.users.get('old')!.emailConfirmedAt = END - 30 * 24 * HOUR
    expect(await status('old', AFTER)).toMatchObject({ premium: false, adFree: false, trialUntil: null })
  })

  it('gives a deleted inbox signing up again nothing, nor a Gmail dot or +tag of it', async () => {
    // Had an account before the trial (known_emails has it), deleted it, and comes back.
    trials.known.set('ada@gmail.com', 'first-account')
    signUp('again', 'ada@gmail.com', END + HOUR)
    expect(await status('again', AFTER)).toMatchObject({ premium: false, trialUntil: null })
    signUp('dotted', 'a.d.a+new@gmail.com', END + HOUR)
    expect(await status('dotted', AFTER)).toMatchObject({ premium: false, trialUntil: null })
  })

  it('one trial per inbox ever: deleted after the trial and signed up again, nothing', async () => {
    signUp('first', 'chi@gmail.com', END + HOUR)
    expect(await status('first', AFTER)).toMatchObject({ premium: true })
    trials.deleteAccount('first')
    signUp('second', 'c.h.i+2@gmail.com', AFTER + HOUR)
    expect(await status('second', AFTER + 2 * HOUR)).toMatchObject({ premium: false, trialUntil: null })
  })

  it('one trial per device: another new inbox on the same device gets nothing', async () => {
    signUp('a', 'a@yahoo.com', END + HOUR)
    signUp('b', 'b@yahoo.com', END + HOUR)
    signUp('c', 'c@yahoo.com', END + HOUR)
    expect(await status('a', AFTER, { 'x-device-id': 'phone-1' })).toMatchObject({ premium: true })
    expect(await status('b', AFTER, { 'x-device-id': 'phone-1' })).toMatchObject({ premium: false, trialUntil: null })
    // The device's own flag (kept by the browser) counts too.
    expect(await status('c', AFTER, { 'x-device-id': 'phone-2', 'x-trial-device': 'used' })).toMatchObject({ premium: false, trialUntil: null })
  })

  it('TRIAL_ENABLED=false: nobody gets it', async () => {
    signUp('n', 'n@gmail.com', END + HOUR)
    const off = readReferralEnv({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 's', PROMO_START, PROMO_END, TRIAL_ENABLED: 'false' })
    expect(await status('n', AFTER, {}, off)).toMatchObject({ premium: false, trialUntil: null, trial: null })
  })

  it('without migration 004 (every call fails), the status still answers, with no trial', async () => {
    signUp('m', 'm@gmail.com', END + HOUR)
    const broken = Object.fromEntries(Object.keys(trials.store).map((k) => [k, async () => Promise.reject(new Error('42703'))])) as unknown as TrialStore
    referral.clock.now = AFTER
    const req = Readable.from([]) as unknown as IncomingMessage
    req.method = 'GET'
    req.url = '/api/referral/status'
    req.headers = { authorization: 'Bearer token-m' }
    let code = 0
    let body = ''
    const res = { statusCode: 200, setHeader() {}, end(text: string) { code = this.statusCode; body = text } } as unknown as ServerResponse
    await handleReferral(env, 'status', req, res, { store: referral.store, trials: broken, now: AFTER })
    expect(code).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ signedIn: true, premium: false, trialUntil: null })
  })
})

describe('the welcome trial: when it ends', () => {
  it('ends exactly 48 hours after confirmation: ads, Server 1 and no crown again', async () => {
    const confirmed = signUp('t', 't@gmail.com', END + HOUR)
    await status('t', AFTER)
    const end = confirmed + 48 * HOUR
    expect(await status('t', end - 1000)).toMatchObject({ adFree: true, premium: true })
    const after = await status('t', end + 1)
    expect(after).toMatchObject({ adFree: false, ownAdFree: false, premium: false, trialOnly: false, trialUntil: new Date(end).toISOString() })
  })

  it('paid, referral and AD_FREE_EMAILS accounts are not affected', async () => {
    const confirmed = signUp('paid', 'paid@gmail.com', END + HOUR)
    const paidUntil = new Date(AFTER + 30 * 24 * HOUR).toISOString()
    await referral.store.saveProfile('paid', { ad_free_until: paidUntil })
    // Paid and new: Premium until the later end, not "trial only".
    expect(await status('paid', AFTER)).toMatchObject({ premium: true, trialOnly: false, adFreeUntil: paidUntil })
    expect(await status('paid', confirmed + 49 * HOUR)).toMatchObject({ premium: true, adFree: true, adFreeUntil: paidUntil })
    referral.addUser('owner', 'owner@gmail.com', END - 100 * 24 * HOUR)
    expect(await status('owner', AFTER + 100 * HOUR)).toMatchObject({ premium: true, permanent: true })
  })
})

describe('Premium (the crown)', () => {
  it('is own ad-free or the trial, never the promo week alone', async () => {
    referral.addUser('normal', 'normal@gmail.com', DURING - 100 * HOUR)
    referral.addUser('paid', 'p@gmail.com', DURING - 100 * HOUR)
    await referral.store.saveProfile('paid', { ad_free_until: new Date(DURING + 100 * HOUR).toISOString() })
    expect(await status('normal', DURING)).toMatchObject({ adFree: true, promoAdFree: true, premium: false })
    expect(await status('paid', DURING)).toMatchObject({ adFree: true, premium: true })
    expect(await status('normal', AFTER)).toMatchObject({ adFree: false, premium: false })
    expect(await status(undefined, AFTER)).toMatchObject({ signedIn: false, premium: false, trial: { live: true } })
  })

  it('premiumState: the later of the two ends', () => {
    const now = 1000
    expect(premiumState({ adFree: false, until: null, permanent: false }, null, now)).toMatchObject({ premium: false })
    expect(premiumState({ adFree: false, until: null, permanent: false }, new Date(5000).toISOString(), now)).toMatchObject({ premium: true, trialOnly: true, until: new Date(5000).toISOString() })
    expect(premiumState({ adFree: true, until: new Date(9000).toISOString(), permanent: false }, new Date(5000).toISOString(), now)).toMatchObject({ premium: true, trialOnly: false, until: new Date(9000).toISOString() })
    expect(premiumState({ adFree: false, until: null, permanent: false }, new Date(500).toISOString(), now)).toMatchObject({ premium: false })
  })

  it('checkTrial says why not', () => {
    const config = readTrialConfig({ PROMO_END })
    const base = { config, now: AFTER, userId: 'u', email: 'u@gmail.com', createdAt: END + 1, emailConfirmedAt: END + 2, inboxFirstUser: null, inboxTaken: false, inboxTrialUser: null, deviceUsed: false }
    expect(checkTrial(base)).toEqual({ ok: true, until: new Date(END + 2 + 48 * HOUR).toISOString() })
    expect(checkTrial({ ...base, now: END })).toEqual({ ok: false, reason: 'not-started' })
    expect(checkTrial({ ...base, createdAt: END - 1 })).toEqual({ ok: false, reason: 'old-account' })
    expect(checkTrial({ ...base, inboxFirstUser: 'other' })).toEqual({ ok: false, reason: 'known-inbox' })
    expect(checkTrial({ ...base, inboxTaken: true })).toEqual({ ok: false, reason: 'known-inbox' })
    expect(checkTrial({ ...base, inboxTrialUser: 'other' })).toEqual({ ok: false, reason: 'inbox-had-trial' })
    expect(checkTrial({ ...base, deviceUsed: true })).toEqual({ ok: false, reason: 'device-had-trial' })
    expect(checkTrial({ ...base, emailConfirmedAt: null })).toEqual({ ok: false, reason: 'unconfirmed' })
  })
})

describe('/admin/live: Premium and the trial', () => {
  it('counts trials today, active trials, Play popup sign-ups and every Premium account', async () => {
    signUp('t1', 't1@gmail.com', END + HOUR)
    referral.users.get('t1')!.signupSource = 'play-popup'
    signUp('t2', 't2@gmail.com', END + HOUR)
    referral.addUser('paid', 'paid@gmail.com', DURING)
    await referral.store.saveProfile('paid', { ad_free_until: new Date(AFTER + 100 * HOUR).toISOString() })
    referral.addUser('owner', 'owner@gmail.com', DURING)
    await status('t1', AFTER)
    await status('t2', AFTER, { 'x-device-id': 'd2' })
    const req = Readable.from([]) as unknown as IncomingMessage
    req.method = 'GET'
    req.url = '/api/referral/admin-premium'
    req.headers = { authorization: 'Bearer admin-pw' }
    let body = ''
    const res = { statusCode: 200, setHeader() {}, end(text: string) { body = text } } as unknown as ServerResponse
    await handleReferral(env, 'admin-premium', req, res, { store: referral.store, trials: trials.store, now: AFTER })
    expect(JSON.parse(body)).toMatchObject({ trialsToday: 2, activeTrials: 2, playSignups: 1, premiumUsers: 4, trial: { live: true, hours: 48 } })
  })
})
