import { normalizeEmail } from './rules.js'

/**
 * The referral program's data in Supabase (supabase/migrations/002_referrals.sql),
 * reached with the service role key over PostgREST and the Auth admin API.
 * Handlers only see the ReferralStore interface; tests use a fake one.
 */

export interface AuthUser {
  id: string
  email: string
  emailConfirmed: boolean
  createdAt: number
  /** When the email was confirmed (ms), if it has been. */
  emailConfirmedAt?: number | null
  /** How the account was made (user_metadata.signup_source), e.g. "play-popup". */
  signupSource?: string | null
}

export interface Profile {
  user_id: string
  invite_code: string | null
  ad_free_until: string | null
  rewards_granted: number
  email_normalized: string | null
  last_ip_hash: string | null
}

export type ReferralStatus = 'pending' | 'counted' | 'held' | 'rejected'

export interface Referral {
  id: number
  referrer_id: string
  referred_user_id: string
  status: ReferralStatus
  reason: string | null
  flags: string[]
  ip_hash: string | null
  created_at: string
  counted_at: string | null
}

export interface WeekDecision {
  week_start: string
  user_id: string
  decision: 'winner' | 'disqualified'
  referrals: number
  decided_at: string
}

export interface AdFreeGrant {
  id: number
  user_id: string | null
  email: string
  action: 'grant' | 'remove'
  plan: string | null
  days: number
  amount: number
  note: string | null
  ad_free_until: string | null
  created_at: string
}

export interface ReferralStore {
  /** The user an access token belongs to, checked by Supabase itself. */
  userFromToken(token: string): Promise<AuthUser | null>
  /** The sign-in email of a user (admin, emails). */
  emailOf(userId: string): Promise<string | null>
  getProfile(userId: string): Promise<Profile | null>
  profileByCode(code: string): Promise<Profile | null>
  /** Creates or updates the profile's own columns; returns it. */
  saveProfile(userId: string, patch: Partial<Omit<Profile, 'user_id'>>): Promise<Profile>
  /** Another profile (not `exceptUser`) has this normalized email. */
  inboxTaken(emailNormalized: string, exceptUser: string): Promise<boolean>
  /** Sets the reward, only if rewards_granted is still `expected` (no double unlock). */
  grantReward(userId: string, expected: number, granted: number, adFreeUntil: string): Promise<boolean>
  referralOf(referredUserId: string): Promise<Referral | null>
  insertReferral(row: Pick<Referral, 'referrer_id' | 'referred_user_id' | 'status' | 'reason' | 'ip_hash'>): Promise<Referral | null>
  /** Updates a referral, only while its status is `from`; true if it did. */
  updateReferral(id: number, from: ReferralStatus, patch: Partial<Pick<Referral, 'status' | 'flags' | 'counted_at' | 'ip_hash'>>): Promise<boolean>
  /** Referrals counted since `since` from this network. */
  countedFromIp(ipHash: string, since: string): Promise<number>
  /** A referrer's referrals, every status. */
  referralsOf(referrerId: string): Promise<Referral[]>
  /** Counted referrals in [from, to). */
  countedBetween(from: string, to: string): Promise<Referral[]>
  /** Totals by status. */
  totals(): Promise<Record<ReferralStatus, number>>
  decisions(weekStart?: string): Promise<WeekDecision[]>
  setDecision(row: Omit<WeekDecision, 'decided_at'>): Promise<boolean>
  clearDecision(weekStart: string, userId: string): Promise<void>
  // ---- Paid ad-free (/admin/ad-free) ----
  /** A user by sign-in email (case and Gmail dots/+tags don't matter). */
  findUserByEmail(email: string): Promise<{ id: string; email: string } | null>
  /** Accounts whose ad_free_until is still ahead, most recently changed first. */
  adFreeProfiles(now: string): Promise<(Pick<Profile, 'user_id' | 'ad_free_until' | 'rewards_granted'> & { updated_at: string })[]>
  /** Every login's email (at most 20 pages of 1000), for the Free Ad-Free Week email. */
  allEmails(): Promise<string[]>
  /** Sets the end of the account's ad-free time (null: none). */
  setAdFreeUntil(userId: string, until: string | null): Promise<void>
  insertGrant(row: Omit<AdFreeGrant, 'id' | 'created_at'>): Promise<AdFreeGrant>
  /** Grants and removals, newest first: one user's, or everyone's since `since`. */
  grants(filter: { userId?: string; since?: string; limit?: number }): Promise<AdFreeGrant[]>
}

export interface SupabaseEnv {
  url: string
  serviceKey: string
}

const PROFILE_COLUMNS = 'user_id,invite_code,ad_free_until,rewards_granted,email_normalized,last_ip_hash'
const GRANT_COLUMNS = 'id,user_id,email,action,plan,days,amount,note,ad_free_until,created_at'
const REFERRAL_COLUMNS = 'id,referrer_id,referred_user_id,status,reason,flags,ip_hash,created_at,counted_at'

export function supabaseStore(env: SupabaseEnv, fetchImpl: typeof fetch = fetch): ReferralStore {
  const headers = (extra: Record<string, string> = {}) => ({
    apikey: env.serviceKey,
    Authorization: `Bearer ${env.serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  })
  const rest = async <T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> => {
    const response = await fetchImpl(`${env.url}/rest/v1/${path}`, {
      ...init,
      headers: headers(init.prefer ? { Prefer: init.prefer } : {}),
    })
    if (!response.ok) throw new Error(`supabase ${response.status}: ${await response.text().catch(() => '')}`)
    const text = await response.text()
    return (text ? JSON.parse(text) : null) as T
  }
  const count = async (path: string): Promise<number> => {
    const response = await fetchImpl(`${env.url}/rest/v1/${path}`, { method: 'HEAD', headers: headers({ Prefer: 'count=exact' }) })
    if (!response.ok) throw new Error(`supabase ${response.status}`)
    return Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1] ?? 0)
  }
  const q = encodeURIComponent

  return {
    async userFromToken(token) {
      const response = await fetchImpl(`${env.url}/auth/v1/user`, { headers: { apikey: env.serviceKey, Authorization: `Bearer ${token}` } })
      if (!response.ok) return null
      const body = (await response.json().catch(() => null)) as {
        id?: unknown
        email?: unknown
        email_confirmed_at?: unknown
        created_at?: unknown
        user_metadata?: { signup_source?: unknown } | null
      } | null
      if (typeof body?.id !== 'string') return null
      const confirmedAt = typeof body.email_confirmed_at === 'string' && body.email_confirmed_at !== '' ? Date.parse(body.email_confirmed_at) : NaN
      const source = body.user_metadata?.signup_source
      return {
        id: body.id,
        email: typeof body.email === 'string' ? body.email : '',
        emailConfirmed: typeof body.email_confirmed_at === 'string' && body.email_confirmed_at !== '',
        createdAt: typeof body.created_at === 'string' ? Date.parse(body.created_at) : Date.now(),
        emailConfirmedAt: Number.isFinite(confirmedAt) ? confirmedAt : null,
        signupSource: typeof source === 'string' ? source.slice(0, 40) : null,
      }
    },
    async emailOf(userId) {
      const response = await fetchImpl(`${env.url}/auth/v1/admin/users/${q(userId)}`, { headers: headers() })
      if (!response.ok) return null
      const body = (await response.json().catch(() => null)) as { email?: unknown } | null
      return typeof body?.email === 'string' ? body.email : null
    },
    async getProfile(userId) {
      const rows = await rest<Profile[]>(`profiles?select=${PROFILE_COLUMNS}&user_id=eq.${q(userId)}`)
      return rows[0] ?? null
    },
    async profileByCode(code) {
      const rows = await rest<Profile[]>(`profiles?select=${PROFILE_COLUMNS}&invite_code=eq.${q(code)}`)
      return rows[0] ?? null
    },
    async saveProfile(userId, patch) {
      const rows = await rest<Profile[]>(`profiles?on_conflict=user_id&select=${PROFILE_COLUMNS}`, {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: JSON.stringify({ user_id: userId, ...patch, updated_at: new Date().toISOString() }),
      })
      return rows[0]
    },
    async inboxTaken(emailNormalized, exceptUser) {
      return (await count(`profiles?email_normalized=eq.${q(emailNormalized)}&user_id=neq.${q(exceptUser)}`)) > 0
    },
    async grantReward(userId, expected, granted, adFreeUntil) {
      const rows = await rest<Profile[]>(`profiles?user_id=eq.${q(userId)}&rewards_granted=eq.${expected}&select=user_id`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify({ rewards_granted: granted, ad_free_until: adFreeUntil, updated_at: new Date().toISOString() }),
      })
      return rows.length > 0
    },
    async referralOf(referredUserId) {
      const rows = await rest<Referral[]>(`referrals?select=${REFERRAL_COLUMNS}&referred_user_id=eq.${q(referredUserId)}`)
      return rows[0] ?? null
    },
    async insertReferral(row) {
      try {
        const rows = await rest<Referral[]>(`referrals?select=${REFERRAL_COLUMNS}`, { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) })
        return rows[0] ?? null
      } catch {
        // Already referred (unique referred_user_id), from a second tab.
        return null
      }
    },
    async updateReferral(id, from, patch) {
      const rows = await rest<Referral[]>(`referrals?id=eq.${id}&status=eq.${from}&select=id`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify(patch),
      })
      return rows.length > 0
    },
    countedFromIp(ipHash, since) {
      return count(`referrals?ip_hash=eq.${q(ipHash)}&status=eq.counted&counted_at=gte.${q(since)}`)
    },
    referralsOf(referrerId) {
      return rest<Referral[]>(`referrals?select=${REFERRAL_COLUMNS}&referrer_id=eq.${q(referrerId)}&order=created_at.desc&limit=1000`)
    },
    countedBetween(from, to) {
      return rest<Referral[]>(
        `referrals?select=${REFERRAL_COLUMNS}&status=eq.counted&counted_at=gte.${q(from)}&counted_at=lt.${q(to)}&order=counted_at.asc&limit=10000`,
      )
    },
    async totals() {
      const statuses = ['pending', 'counted', 'held', 'rejected'] as const
      const counts = await Promise.all(statuses.map((status) => count(`referrals?status=eq.${status}`)))
      return Object.fromEntries(statuses.map((status, i) => [status, counts[i]])) as Record<ReferralStatus, number>
    },
    decisions(weekStart) {
      return rest<WeekDecision[]>(
        `referral_weeks?select=week_start,user_id,decision,referrals,decided_at${weekStart ? `&week_start=eq.${q(weekStart)}` : ''}&order=week_start.desc&limit=200`,
      )
    },
    async setDecision(row) {
      try {
        await rest(`referral_weeks?on_conflict=week_start,user_id`, {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: JSON.stringify({ ...row, decided_at: new Date().toISOString() }),
        })
        return true
      } catch {
        // A second winner for the week (one_winner index).
        return false
      }
    },
    async clearDecision(weekStart, userId) {
      await rest(`referral_weeks?week_start=eq.${q(weekStart)}&user_id=eq.${q(userId)}`, { method: 'DELETE' })
    },
    async findUserByEmail(email) {
      const wanted = normalizeEmail(email)
      // Anyone who has signed in since the referral program started has a profile with their inbox.
      const rows = await rest<{ user_id: string }[]>(`profiles?select=user_id&email_normalized=eq.${q(wanted)}&limit=1`)
      if (rows[0]) {
        const found = await this.emailOf(rows[0].user_id)
        if (found) return { id: rows[0].user_id, email: found }
      }
      // Else every login, 1000 at a time (at most 20 pages).
      for (let page = 1; page <= 20; page++) {
        const response = await fetchImpl(`${env.url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: headers() })
        if (!response.ok) throw new Error(`supabase ${response.status}`)
        const body = (await response.json().catch(() => null)) as { users?: { id: string; email?: string }[] } | null
        const users = body?.users ?? []
        const match = users.find((user) => user.email && normalizeEmail(user.email) === wanted)
        if (match) return { id: match.id, email: match.email! }
        if (users.length < 1000) break
      }
      return null
    },
    async allEmails() {
      const emails: string[] = []
      for (let page = 1; page <= 20; page++) {
        const response = await fetchImpl(`${env.url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: headers() })
        if (!response.ok) throw new Error(`supabase ${response.status}`)
        const body = (await response.json().catch(() => null)) as { users?: { email?: string }[] } | null
        const users = body?.users ?? []
        for (const user of users) if (user.email) emails.push(user.email)
        if (users.length < 1000) break
      }
      return emails
    },
    adFreeProfiles(now) {
      return rest(`profiles?select=user_id,ad_free_until,rewards_granted,updated_at&ad_free_until=gt.${q(now)}&order=updated_at.desc&limit=500`)
    },
    async setAdFreeUntil(userId, until) {
      await rest(`profiles?on_conflict=user_id`, {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify({ user_id: userId, ad_free_until: until, updated_at: new Date().toISOString() }),
      })
    },
    async insertGrant(row) {
      const rows = await rest<AdFreeGrant[]>(`ad_free_grants?select=${GRANT_COLUMNS}`, { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) })
      return rows[0]
    },
    grants({ userId, since, limit = 1000 }) {
      const where = `${userId ? `&user_id=eq.${q(userId)}` : ''}${since ? `&created_at=gte.${q(since)}` : ''}`
      return rest<AdFreeGrant[]>(`ad_free_grants?select=${GRANT_COLUMNS}${where}&order=created_at.desc&limit=${limit}`)
    },
  }
}

// ---- The 48-hour Premium welcome trial (supabase/migrations/004_welcome_trial.sql) ----

export interface WelcomeTrial {
  email_normalized: string
  user_id: string | null
  device_hash: string | null
  source: string | null
  started_at: string
  until: string
  created_at: string
}

export interface TrialStats {
  /** Trials started since midnight (Lagos). */
  startedToday: number
  /** Trials running now. */
  active: number
  /** Accounts made from the Play popup's "Sign up free": all, and today's. */
  playSignups: number
  playSignupsToday: number
  /** Accounts Premium now through ad_free_until or the trial (not the promo, not AD_FREE_EMAILS). */
  premiumIds: string[]
}

/**
 * Its own interface: everything here needs migration 004. Until it's run,
 * every call fails and the handlers carry on without a trial.
 */
export interface TrialStore {
  /** The account's trial end and how it signed up (profiles). */
  trialOf(userId: string): Promise<{ welcome_trial_until: string | null; signup_source: string | null } | null>
  /** Notes the inbox's first account (kept after a deletion); returns that first account's id. */
  rememberInbox(emailNormalized: string, userId: string): Promise<string | null>
  trialForInbox(emailNormalized: string): Promise<WelcomeTrial | null>
  /** Another inbox's trial on this device. */
  deviceHadTrial(deviceHash: string, exceptInbox: string): Promise<boolean>
  /** Records the inbox's trial; false if it already has one. */
  insertTrial(row: Omit<WelcomeTrial, 'created_at'>): Promise<boolean>
  setTrialUntil(userId: string, until: string): Promise<void>
  setSignupSource(userId: string, source: string): Promise<void>
  stats(now: number, dayStart: number): Promise<TrialStats>
}

export function supabaseTrialStore(env: SupabaseEnv, fetchImpl: typeof fetch = fetch): TrialStore {
  const headers = (extra: Record<string, string> = {}) => ({
    apikey: env.serviceKey,
    Authorization: `Bearer ${env.serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  })
  const rest = async <T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> => {
    const response = await fetchImpl(`${env.url}/rest/v1/${path}`, { ...init, headers: headers(init.prefer ? { Prefer: init.prefer } : {}) })
    if (!response.ok) throw Object.assign(new Error(`supabase ${response.status}`), { status: response.status })
    const text = await response.text()
    return (text ? JSON.parse(text) : null) as T
  }
  const count = async (path: string): Promise<number> => {
    const response = await fetchImpl(`${env.url}/rest/v1/${path}`, { method: 'HEAD', headers: headers({ Prefer: 'count=exact' }) })
    if (!response.ok) throw new Error(`supabase ${response.status}`)
    return Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1] ?? 0)
  }
  const q = encodeURIComponent
  const TRIAL_COLUMNS = 'email_normalized,user_id,device_hash,source,started_at,until,created_at'
  const patchProfile = (userId: string, patch: Record<string, unknown>) =>
    rest(`profiles?on_conflict=user_id`, {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({ user_id: userId, ...patch, updated_at: new Date().toISOString() }),
    })

  return {
    async trialOf(userId) {
      const rows = await rest<{ welcome_trial_until: string | null; signup_source: string | null }[]>(
        `profiles?select=welcome_trial_until,signup_source&user_id=eq.${q(userId)}`,
      )
      return rows[0] ?? null
    },
    async rememberInbox(emailNormalized, userId) {
      await rest(`known_emails?on_conflict=email_normalized`, {
        method: 'POST',
        prefer: 'resolution=ignore-duplicates,return=minimal',
        body: JSON.stringify({ email_normalized: emailNormalized, first_user_id: userId }),
      })
      const rows = await rest<{ first_user_id: string | null }[]>(`known_emails?select=first_user_id&email_normalized=eq.${q(emailNormalized)}`)
      return rows[0]?.first_user_id ?? null
    },
    async trialForInbox(emailNormalized) {
      const rows = await rest<WelcomeTrial[]>(`welcome_trials?select=${TRIAL_COLUMNS}&email_normalized=eq.${q(emailNormalized)}`)
      return rows[0] ?? null
    },
    async deviceHadTrial(deviceHash, exceptInbox) {
      return (await count(`welcome_trials?device_hash=eq.${q(deviceHash)}&email_normalized=neq.${q(exceptInbox)}`)) > 0
    },
    async insertTrial(row) {
      try {
        await rest(`welcome_trials`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(row) })
        return true
      } catch (error) {
        // 409: the inbox already has one (from a second tab, at the same moment).
        if ((error as { status?: number }).status === 409) return false
        throw error
      }
    },
    async setTrialUntil(userId, until) {
      await patchProfile(userId, { welcome_trial_until: until })
    },
    async setSignupSource(userId, source) {
      await patchProfile(userId, { signup_source: source })
    },
    async stats(now, dayStart) {
      const nowIso = q(new Date(now).toISOString())
      const day = q(new Date(dayStart).toISOString())
      const [startedToday, active, playSignups, playSignupsToday, premium] = await Promise.all([
        count(`welcome_trials?created_at=gte.${day}`),
        count(`welcome_trials?until=gt.${nowIso}`),
        count(`profiles?signup_source=eq.play-popup`),
        count(`profiles?signup_source=eq.play-popup&created_at=gte.${day}`),
        rest<{ user_id: string }[]>(`profiles?select=user_id&or=(ad_free_until.gt.${nowIso},welcome_trial_until.gt.${nowIso})&limit=10000`),
      ])
      return { startedToday, active, playSignups, playSignupsToday, premiumIds: premium.map((row) => row.user_id) }
    },
  }
}
