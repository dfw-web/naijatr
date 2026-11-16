import { useSyncExternalStore } from 'react'
import { accountStatusNow } from '../account/account'
import { isNoAdScriptPath } from '../account/pages'
import { holdAds, releaseAds } from '../ads/adGate'
import { holdAdsThisTap, isPlaybackOpen, overlaysOpen } from '../ads/adManager'
import { isDevHost } from '../ads/directLink'
import { loadPromo, promoOn, serverStatusKnown, serverTime, type PromoInfo, type ReferralStatus } from '../referral/status'

/**
 * The welcome popup for signed-out visitors (WelcomePopup.tsx): on every
 * fresh page load or reload, about 1.5 s in, never for signed-in accounts,
 * never on /login, /signup, /auth/*, /account, /admin/*, /privacy or
 * /invite/rules. Once per page load: a client-side navigation never brings it
 * back (an ad script may be on the page by then).
 *
 * Zero ads around it: for a signed-out visitor, no ad of any kind (no
 * Multitag, no direct-link ad, no TV ad slot) is added to the page from the
 * moment it loads until the popup has closed and 3 more seconds have passed
 * (src/ads/adGate.ts). "Sign up free" and "Log in" are auth buttons
 * (src/ads/authGuard.ts): full page loads to /signup or /login, which never
 * load an ad script.
 */

export const WELCOME_TIMING = {
  /** After the page loads, so the site shows first. */
  delayMs: 1500,
  /** After it closes, before any ad may load. */
  adsAfterMs: 3000,
  /** Waiting for the account and the promo's times, checked this often, at most this long. */
  pollMs: 250,
  maxWaitMs: 6000,
}

/** The Free Ad-Free Week's end, if the server can't be reached for its times (matches PROMO_END). */
export const FALLBACK_PROMO: PromoInfo = { start: '2026-11-11T00:00:00+01:00', end: '2026-11-17T23:59:59+01:00', state: 'active' }

/** /admin/live counts these (/api/live/ad). */
export type WelcomeEvent = 'welcome-shown' | 'welcome-signup' | 'welcome-login' | 'welcome-close'

const EXCLUDED = /^\/(login|signup|privacy|invite\/rules|auth(\/.*)?|admin(\/.*)?)\/?$/

/** Pages the popup may show on. */
export const welcomePathAllowed = (pathname = window.location.pathname): boolean => !EXCLUDED.test(pathname) && !isNoAdScriptPath(pathname)

type Phase = 'idle' | 'pending' | 'open' | 'closed' | 'skipped'
let phase: Phase = 'idle'
let timer: number | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Counts it on /admin/live. Never from a developer's machine. */
export function reportWelcome(event: WelcomeEvent): void {
  if (isDevHost()) return
  try {
    navigator.sendBeacon?.('/api/live/ad', new Blob([JSON.stringify({ event })], { type: 'application/json' }))
  } catch {
    // Not counted.
  }
}

/** Not shown on this page load: ads may load (after `delayMs`). */
function skip(delayMs: number) {
  phase = 'skipped'
  releaseAds(delayMs)
  emit()
}

/**
 * Call once when the page loads (main.tsx), after initAccount and before any
 * root renders: from then on ads wait for the popup.
 */
export function startWelcomePopup(): void {
  if (phase !== 'idle') return
  const account = accountStatusNow()
  if (!welcomePathAllowed() || account === 'disabled' || account === 'signedIn') return skip(0)
  phase = 'pending'
  holdAds()
  // The promo's times (and the server's clock), for the wording.
  loadPromo()
  const started = Date.now()
  const decide = () => {
    if (phase !== 'pending') return
    const status = accountStatusNow()
    if (status === 'signedIn' || status === 'disabled') return skip(0)
    const waitedTooLong = Date.now() - started > WELCOME_TIMING.maxWaitMs
    // A device that's signed in before: still checking its session. Never shown to a signed-in account.
    if (status === 'checking') {
      if (waitedTooLong) return skip(0)
      timer = window.setTimeout(decide, WELCOME_TIMING.pollMs)
      return
    }
    if (!serverStatusKnown() && !waitedTooLong) {
      timer = window.setTimeout(decide, WELCOME_TIMING.pollMs)
      return
    }
    // A player or another popup (the Play popup, the Telegram gate) got there first: not both.
    if (isPlaybackOpen() || overlaysOpen() > 0) return skip(WELCOME_TIMING.adsAfterMs)
    phase = 'open'
    emit()
    reportWelcome('welcome-shown')
  }
  timer = window.setTimeout(decide, WELCOME_TIMING.delayMs)
}

/** ✕, "Not now", a tap outside, Esc or Back: closed, and ads may load 3 seconds later. */
export function closeWelcomePopup(counted = true): void {
  if (phase !== 'open') return
  holdAdsThisTap()
  phase = 'closed'
  emit()
  if (counted) reportWelcome('welcome-close')
  releaseAds(WELCOME_TIMING.adsAfterMs)
}

/** Shown on this page load (open or closed since): the Play popup stays away. */
export const welcomePopupShown = () => phase === 'open' || phase === 'closed'

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useWelcomePopupOpen = () => useSyncExternalStore(subscribe, () => phase === 'open', () => false)

/** Which wording: the Free Ad-Free Week's (until PROMO_END), and whether the welcome trial is on. */
export function welcomeWording(status: ReferralStatus | null, now = serverTime()): { promo: boolean; trial: boolean } {
  const promo = status?.promo === undefined ? FALLBACK_PROMO : status.promo
  // The server sends trial: null when TRIAL_ENABLED=false.
  return { promo: promoOn(promo, now), trial: status?.trial !== null }
}

/** Test helper. */
export function resetWelcomePopup(): void {
  window.clearTimeout(timer)
  phase = 'idle'
  emit()
}
