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
}

export interface SupabaseEnv {
  url: string
  serviceKey: string
}

const PROFILE_COLUMNS = 'user_id,invite_code,ad_free_until,rewards_granted,email_normalized,last_ip_hash'
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
      const body = (await response.json().catch(() => null)) as { id?: unknown; email?: unknown; email_confirmed_at?: unknown; created_at?: unknown } | null
      if (typeof body?.id !== 'string') return null
      return {
        id: body.id,
        email: typeof body.email === 'string' ? body.email : '',
        emailConfirmed: typeof body.email_confirmed_at === 'string' && body.email_confirmed_at !== '',
        createdAt: typeof body.created_at === 'string' ? Date.parse(body.created_at) : Date.now(),
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
  }
}
