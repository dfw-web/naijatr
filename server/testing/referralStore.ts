import { normalizeEmail } from '../referral/rules.js'
import type { AdFreeGrant, AuthUser, Profile, Referral, ReferralStore, WeekDecision } from '../referral/store.js'

export const NOW = Date.UTC(2026, 10, 4, 12)

/** Supabase, in memory. Tokens are "token-<userId>". */
export function fakeStore(now = NOW) {
  const users = new Map<string, AuthUser>()
  const profiles = new Map<string, Profile>()
  const referrals: Referral[] = []
  const decisions: WeekDecision[] = []
  const grants: AdFreeGrant[] = []
  const updatedAt = new Map<string, string>()
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
    async findUserByEmail(email) {
      const user = [...users.values()].find((u) => normalizeEmail(u.email) === normalizeEmail(email))
      return user ? { id: user.id, email: user.email } : null
    },
    async allEmails() {
      return [...users.values()].map((u) => u.email)
    },
    async adFreeProfiles(now) {
      return [...profiles.values()]
        .filter((p) => p.ad_free_until && p.ad_free_until > now)
        .map((p) => ({ user_id: p.user_id, ad_free_until: p.ad_free_until, rewards_granted: p.rewards_granted, updated_at: updatedAt.get(p.user_id) ?? '' }))
    },
    async setAdFreeUntil(userId, until) {
      await store.saveProfile(userId, { ad_free_until: until })
      updatedAt.set(userId, new Date(clock.now).toISOString())
    },
    async insertGrant(row) {
      const grant: AdFreeGrant = { id: nextId++, created_at: new Date(clock.now).toISOString(), ...row }
      grants.unshift(grant)
      return grant
    },
    async grants({ userId, since, limit = 1000 }) {
      return grants.filter((g) => (!userId || g.user_id === userId) && (!since || g.created_at >= since)).slice(0, limit)
    },
  }
  const clock = { now }
  const addUser = (id: string, email: string, createdAt = clock.now - 60_000, emailConfirmed = true) => {
    users.set(id, { id, email, createdAt, emailConfirmed })
    return id
  }
  return { store, users, profiles, referrals, decisions, grants, clock, addUser }
}

