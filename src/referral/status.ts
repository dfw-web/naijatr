import { useSyncExternalStore } from 'react'
import { accessToken, hasStoredSession } from '../account/client'
import { clearRef, readRef } from './capture'

/**
 * The signed-in user's referral status from /api/referral/status: whether the
 * account is ad-free (checked on the server from their session), their invite
 * link and progress. Ads (src/ads) ask isAdFreeNow().
 *
 * The last answer is kept on this device so a signed-in, ad-free visitor sees
 * no ad while the page asks again; it's only used with a stored session, and
 * every visit checks with the server.
 */

export interface ReferralStatus {
  goal: number
  signedIn: boolean
  userId?: string
  adFree: boolean
  adFreeUntil?: string | null
  permanent?: boolean
  code?: string | null
  link?: string
  counted?: number
  pending?: number
  weekCount?: number
  rewards?: number
  /** The latest paid grant (/admin/ad-free). */
  lastGrant?: { id: number; at: string } | null
  /** Ad-free of their own (paid, referral, AD_FREE_EMAILS), which carries on after the promo. Missing: same as adFree. */
  ownAdFree?: boolean
  /** Ad-free only through the Free Ad-Free Week. */
  promoAdFree?: boolean
  /** The Free Ad-Free Week (server/promo.ts), for everyone; null when none is set. */
  promo?: PromoInfo | null
  /** The server's clock when it answered (ms): promo times are read on it, not on the device's. */
  serverNow?: number
  /**
   * 👑 Premium: ad-free of their own (paid, referral, AD_FREE_EMAILS) or the
   * welcome trial; never the promo alone. It ends with adFreeUntil.
   */
  premium?: boolean
  /** The account's welcome trial end (kept once it's over), or null if it never had one. */
  trialUntil?: string | null
  /** Premium only through the welcome trial. */
  trialOnly?: boolean
  /** The welcome trial, for everyone: when it starts (the Play popup waits for it); null when it's off. */
  trial?: TrialInfo | null
}

export interface TrialInfo {
  start: string
  live: boolean
}

export interface PromoInfo {
  start: string
  end: string
  state: 'upcoming' | 'active' | 'ended'
}

export const DEFAULT_GOAL = 5
const CACHE_KEY = 'naijatr.adFree'
const SEEN_REWARDS_KEY = 'naijatr.adFree.seen'
const SEEN_GRANT_KEY = 'naijatr.adFree.seenGrant'
const GOAL_KEY = 'naijatr.referral.goal'
/** Where the referral's play report stands for an account: "done" once there's nothing more to report. */
const REPORT_KEY = 'naijatr.ref.report'
/** This device's own id, for "one welcome trial per device" (only ever hashed on the server). */
const DEVICE_KEY = 'naijatr.device'
/** Set once an account on this device has had the welcome trial: no other account gets one here. */
export const TRIAL_DEVICE_KEY = 'naijatr.trial.device'
/** A cached "ad-free" older than this isn't trusted before the server answers. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** How long ads wait for the server's answer on a signed-in device. */
export const AD_FREE_WAIT_MS = 4000

interface Cached {
  userId: string
  adFree: boolean
  until: string | null
  permanent: boolean
  at: number
}

let status: ReferralStatus | null = null
/** The server's clock minus this device's, from the last answer. */
let clockOffset = 0
/** Now, on the server's clock (as of the last answer). */
export const serverTime = () => Date.now() + clockOffset
let unlockDue = false
let activationDue = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

const storage = {
  get<T>(key: string): T | null {
    try {
      return JSON.parse(window.localStorage.getItem(key) ?? 'null') as T | null
    } catch {
      return null
    }
  },
  set(key: string, value: unknown) {
    try {
      if (value === null) window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // This visit only.
    }
  },
}

const stillValid = (adFree: boolean, permanent: boolean | undefined, until: string | null | undefined, now: number) =>
  adFree && (permanent === true || (until != null && Date.parse(until) > now))

/** The promo is on at `now` (server time), by the times the server sent. */
export function promoOn(promo: PromoInfo | null | undefined = status?.promo, now = serverTime()): boolean {
  if (!promo) return false
  const start = Date.parse(promo.start)
  const end = Date.parse(promo.end)
  return now >= start && now <= end
}

/** The promo as it stands now (server time): upcoming, active, ended, or null without one. */
export function promoStateNow(now = serverTime()): PromoInfo['state'] | null {
  const promo = status?.promo
  if (!promo) return null
  if (now < Date.parse(promo.start)) return 'upcoming'
  return now <= Date.parse(promo.end) ? 'active' : 'ended'
}

/**
 * Ad-free from this answer at `now`: their own time (until it ends), or the
 * promo while it's on. Own time is told apart from the promo's (ownAdFree), so
 * the moment the promo ends a promo-only account is back to ads and Server 1.
 */
function answerAdFree(s: ReferralStatus, now: number): boolean {
  if (!s.signedIn) return false
  const own = s.ownAdFree ?? s.adFree
  if (own && stillValid(true, s.permanent, s.adFreeUntil, now)) return true
  return promoOn(s.promo, now + clockOffset)
}

/**
 * 👑 Premium now, by the server's answer only (never the cached copy): own
 * ad-free or the welcome trial, until it ends; and every signed-in account
 * while the Free Ad-Free Week is on (it goes the moment the promo ends).
 */
export function isPremiumNow(now = Date.now()): boolean {
  const s = status
  if (!s?.signedIn) return false
  if (s.premium === true && s.ownAdFree !== false && stillValid(true, s.permanent, s.adFreeUntil, now)) return true
  return promoOn(s.promo, now + clockOffset)
}

/** The welcome trial runs now (server time): the Play popup may show. */
export function trialLiveNow(now = serverTime()): boolean {
  const trial = status?.trial
  return Boolean(trial && now > Date.parse(trial.start))
}

/** True when the signed-in account is ad-free: no Multitag, no direct-link ad, no ad break. */
export function isAdFreeNow(now = Date.now()): boolean {
  if (status) return answerAdFree(status, now)
  if (!hasStoredSession()) return false
  const cached = storage.get<Cached>(CACHE_KEY)
  return Boolean(cached && now - cached.at < CACHE_MAX_AGE_MS && stillValid(cached.adFree, cached.permanent, cached.until, now))
}

/**
 * Ad-free by the server's answer alone (never the cached copy): which movie
 * server the account gets (src/utils/playerServer.ts). False until it answers.
 */
export function isServerAdFree(now = Date.now()): boolean {
  return status !== null && answerAdFree(status, now)
}

// Ad-free that runs out, and the promo's start and end: everything re-reads
// the status the moment it does (an open player moves server), and the server
// is asked again about the promo.
let expiryTimer: number | undefined
const MAX_TIMER_MS = 2 ** 31 - 1
function scheduleExpiry() {
  window.clearTimeout(expiryTimer)
  if (!status) return
  const now = Date.now()
  const moments: { at: number; ask: boolean }[] = []
  if (status.signedIn && (status.ownAdFree ?? status.adFree) && !status.permanent && status.adFreeUntil) {
    moments.push({ at: Date.parse(status.adFreeUntil), ask: false })
  }
  if (status.promo) {
    // Promo times are on the server's clock: on this device's, they're offset.
    moments.push({ at: Date.parse(status.promo.start) - clockOffset, ask: true })
    moments.push({ at: Date.parse(status.promo.end) - clockOffset, ask: true })
  }
  // The welcome trial's start: the Play popup can show from then on.
  if (status.trial) moments.push({ at: Date.parse(status.trial.start) - clockOffset, ask: false })
  const next = moments.filter((m) => m.at - now > -1000).sort((a, b) => a.at - b.at)[0]
  if (!next) return
  expiryTimer = window.setTimeout(() => {
    emit()
    if (next.ask) void refreshReferralStatus()
    scheduleExpiry()
  }, Math.min(Math.max(0, next.at - now) + 1000, MAX_TIMER_MS))
}

function apply(next: ReferralStatus) {
  status = next
  if (typeof next.serverNow === 'number' && Number.isFinite(next.serverNow)) clockOffset = next.serverNow - Date.now()
  if (next.signedIn && next.userId) {
    storage.set(CACHE_KEY, { userId: next.userId, adFree: next.adFree, until: next.adFreeUntil ?? null, permanent: next.permanent === true, at: Date.now() } satisfies Cached)
    // This device has had a welcome trial: no other account gets one here.
    if (next.trialUntil) storage.set(TRIAL_DEVICE_KEY, 'used')
    // "You've unlocked NAIJA TR ad-free!": once per unlock, per device.
    const seen = storage.get<Record<string, number>>(SEEN_REWARDS_KEY) ?? {}
    const rewards = next.rewards ?? 0
    if (rewards > (seen[next.userId] ?? 0)) {
      if (next.adFree) unlockDue = true
      storage.set(SEEN_REWARDS_KEY, { ...seen, [next.userId]: rewards })
    }
    // "🎉 NAIJA TR ad-free is active until…": once per paid grant, per device.
    const grant = next.lastGrant?.id ?? 0
    const seenGrants = storage.get<Record<string, number>>(SEEN_GRANT_KEY) ?? {}
    if (grant > (seenGrants[next.userId] ?? 0)) {
      if (next.adFree && !next.permanent) activationDue = true
      storage.set(SEEN_GRANT_KEY, { ...seenGrants, [next.userId]: grant })
    }
  }
  if (next.goal > 0) storage.set(GOAL_KEY, next.goal)
  scheduleExpiry()
  emit()
}

/** How often a signed-in, visible tab asks again (ad-free given or ended meanwhile). */
export const STATUS_REFRESH_MS = 5 * 60 * 1000
let watching = false

/**
 * Keeps a signed-in device's status fresh: when the tab comes back into view
 * and every 5 minutes while it's visible. Started once from the app's roots.
 */
export function watchReferralStatus(): void {
  if (watching || typeof document === 'undefined') return
  watching = true
  const refreshIfSignedIn = () => {
    if (document.visibilityState === 'visible' && hasStoredSession()) void refreshReferralStatus()
  }
  document.addEventListener('visibilitychange', refreshIfSignedIn)
  window.setInterval(refreshIfSignedIn, STATUS_REFRESH_MS)
}

/** This device's random id (made once). */
function deviceId(): string {
  const known = storage.get<string>(DEVICE_KEY)
  if (typeof known === 'string' && /^[\w-]{8,64}$/.test(known)) return known
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  storage.set(DEVICE_KEY, id)
  return id
}

let loading: Promise<ReferralStatus | null> | null = null

/** Asks the server again (signed in: the full status; signed out: just the goal). */
export function refreshReferralStatus(): Promise<ReferralStatus | null> {
  loading ??= (async () => {
    try {
      const token = await accessToken()
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}`, 'X-Device-Id': deviceId() } : {}
      if (token && storage.get<string>(TRIAL_DEVICE_KEY) === 'used') headers['X-Trial-Device'] = 'used'
      const response = await fetch('/api/referral/status', { headers, cache: 'no-store' })
      if (!response.ok) return status
      const body = (await response.json()) as ReferralStatus
      if (token || !status?.signedIn) apply(body)
      return status
    } catch {
      return status
    } finally {
      loading = null
    }
  })()
  return loading
}

/** True once the server has answered this visit (signed in or not): isServerAdFree can be trusted. */
export const serverStatusKnown = () => status !== null

/** Resolves once ads may start: at once for signed-out devices, else when the server has said (at most 4 seconds). */
export function adFreeReady(waitMs = AD_FREE_WAIT_MS): Promise<void> {
  if (!hasStoredSession() || status) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, waitMs)
    void refreshReferralStatus().then(() => {
      window.clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * A signed-out visitor: the promo's times (and the server's clock) once, for
 * the promo popup and banner; timers then follow its start and end.
 */
export function loadPromo(): void {
  if (status || hasStoredSession()) return
  void refreshReferralStatus()
}

/** The number of friends that unlock ad-free (the server's REFERRAL_GOAL). */
export const goalNow = () => status?.goal ?? storage.get<number>(GOAL_KEY) ?? DEFAULT_GOAL

// ---- The invited side: attach the link's code to the new account, then count it on a play. ----

async function post(action: 'claim' | 'watched', body: unknown): Promise<{ status?: string } | null> {
  const token = await accessToken()
  if (!token) return null
  try {
    const response = await fetch(`/api/referral/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    })
    return response.ok ? ((await response.json()) as { status?: string }) : null
  } catch {
    return null
  }
}

let claiming: Promise<void> | null = null

/** Signed in with an invite link's code on this device: tells the server (once; it decides whether it counts). */
export function claimReferral(): Promise<void> {
  const ref = readRef()
  if (!ref) return Promise.resolve()
  claiming ??= post('claim', { code: ref.code, openedAt: ref.at })
    .then((answer) => {
      if (!answer) return
      clearRef()
      if (answer.status === 'pending') storage.set(REPORT_KEY, null)
    })
    .finally(() => {
      claiming = null
    })
  return claiming
}

let reportedThisVisit = false

/**
 * A movie, an episode or a match started. A signed-in account that came by a
 * friend's link counts for that friend now (the server checks everything).
 * Asked at most once per visit, and never again once the server says it's settled.
 */
export async function reportReferralPlay(): Promise<void> {
  if (!hasStoredSession() || reportedThisVisit) return
  await claimReferral()
  if (storage.get<string>(REPORT_KEY) === 'done') return
  reportedThisVisit = true
  const answer = await post('watched', {})
  if (answer?.status && answer.status !== 'pending') storage.set(REPORT_KEY, 'done')
}

// ---- The account's sign-in and sign-out (src/account/account.ts). ----

export function referralSignedIn() {
  watchReferralStatus()
  void claimReferral().then(() => refreshReferralStatus())
}

export function referralSignedOut() {
  status = null
  unlockDue = false
  activationDue = false
  reportedThisVisit = false
  storage.set(CACHE_KEY, null)
  storage.set(REPORT_KEY, null)
  scheduleExpiry()
  emit()
  // Signed out now: the promo's times again, for its popup and banner.
  void refreshReferralStatus()
}

export function dismissUnlock() {
  unlockDue = false
  emit()
}

export function dismissActivation() {
  activationDue = false
  emit()
}

/** Calls `listener` whenever the status changes; returns the unsubscribe. */
export const subscribeReferralStatus = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useReferralStatus = () => useSyncExternalStore(subscribeReferralStatus, () => status, () => null)
/** Ad-free right now (re-read whenever the status changes). */
export const useAdFree = () => useSyncExternalStore(subscribeReferralStatus, () => isAdFreeNow(), () => false)
/** Ad-free by the server's answer (re-read whenever it changes, or runs out). */
/** 👑 Premium now (re-read whenever the status changes, and when it runs out). */
export const usePremium = () => useSyncExternalStore(subscribeReferralStatus, () => isPremiumNow(), () => false)
/** The welcome trial runs now (re-read at its start). */
export const useTrialLive = () => useSyncExternalStore(subscribeReferralStatus, () => trialLiveNow(), () => false)
export const useServerAdFree = () => useSyncExternalStore(subscribeReferralStatus, () => isServerAdFree(), () => false)
/** The promo now (re-read when the status changes, and at its start and end). */
export const usePromoState = () => useSyncExternalStore(subscribeReferralStatus, () => promoStateNow(), () => null)
export const usePromo = () => useSyncExternalStore(subscribeReferralStatus, () => status?.promo ?? null, () => null)
export const useUnlockDue = () => useSyncExternalStore(subscribeReferralStatus, () => unlockDue, () => false)
export const useActivationDue = () => useSyncExternalStore(subscribeReferralStatus, () => activationDue, () => false)

/** Test helper. */
export function resetReferralStatus(next: ReferralStatus | null = null) {
  status = next
  clockOffset = typeof next?.serverNow === 'number' ? next.serverNow - Date.now() : 0
  scheduleExpiry()
  unlockDue = false
  activationDue = false
  loading = null
  claiming = null
  reportedThisVisit = false
  emit()
}
