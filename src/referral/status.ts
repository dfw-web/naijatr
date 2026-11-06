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
}

export const DEFAULT_GOAL = 5
const CACHE_KEY = 'naijatr.adFree'
const SEEN_REWARDS_KEY = 'naijatr.adFree.seen'
const SEEN_GRANT_KEY = 'naijatr.adFree.seenGrant'
const GOAL_KEY = 'naijatr.referral.goal'
/** Where the referral's play report stands for an account: "done" once there's nothing more to report. */
const REPORT_KEY = 'naijatr.ref.report'
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

/** True when the signed-in account is ad-free: no Multitag, no direct-link ad, no ad break. */
export function isAdFreeNow(now = Date.now()): boolean {
  if (status) return status.signedIn && stillValid(status.adFree, status.permanent, status.adFreeUntil, now)
  if (!hasStoredSession()) return false
  const cached = storage.get<Cached>(CACHE_KEY)
  return Boolean(cached && now - cached.at < CACHE_MAX_AGE_MS && stillValid(cached.adFree, cached.permanent, cached.until, now))
}

/**
 * Ad-free by the server's answer alone (never the cached copy): which movie
 * server the account gets (src/utils/playerServer.ts). False until it answers.
 */
export function isServerAdFree(now = Date.now()): boolean {
  return status !== null && status.signedIn && stillValid(status.adFree, status.permanent, status.adFreeUntil, now)
}

// Ad-free that runs out: everything re-reads the status the moment it does.
let expiryTimer: number | undefined
const MAX_TIMER_MS = 2 ** 31 - 1
function scheduleExpiry() {
  window.clearTimeout(expiryTimer)
  if (!status?.adFree || status.permanent || !status.adFreeUntil) return
  const left = Date.parse(status.adFreeUntil) - Date.now()
  if (!(left > 0)) return
  expiryTimer = window.setTimeout(() => {
    emit()
    scheduleExpiry()
  }, Math.min(left + 1000, MAX_TIMER_MS))
}

function apply(next: ReferralStatus) {
  status = next
  if (next.signedIn && next.userId) {
    storage.set(CACHE_KEY, { userId: next.userId, adFree: next.adFree, until: next.adFreeUntil ?? null, permanent: next.permanent === true, at: Date.now() } satisfies Cached)
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

let loading: Promise<ReferralStatus | null> | null = null

/** Asks the server again (signed in: the full status; signed out: just the goal). */
export function refreshReferralStatus(): Promise<ReferralStatus | null> {
  loading ??= (async () => {
    try {
      const token = await accessToken()
      const response = await fetch('/api/referral/status', { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' })
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
  emit()
}

export function dismissUnlock() {
  unlockDue = false
  emit()
}

export function dismissActivation() {
  activationDue = false
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useReferralStatus = () => useSyncExternalStore(subscribe, () => status, () => null)
/** Ad-free right now (re-read whenever the status changes). */
export const useAdFree = () => useSyncExternalStore(subscribe, () => isAdFreeNow(), () => false)
/** Ad-free by the server's answer (re-read whenever it changes, or runs out). */
export const useServerAdFree = () => useSyncExternalStore(subscribe, () => isServerAdFree(), () => false)
export const useUnlockDue = () => useSyncExternalStore(subscribe, () => unlockDue, () => false)
export const useActivationDue = () => useSyncExternalStore(subscribe, () => activationDue, () => false)

/** Test helper. */
export function resetReferralStatus(next: ReferralStatus | null = null) {
  status = next
  scheduleExpiry()
  unlockDue = false
  activationDue = false
  loading = null
  claiming = null
  reportedThisVisit = false
  emit()
}
