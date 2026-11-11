import { useSyncExternalStore } from 'react'
import { accountStatusNow, useSignInSheet } from '../account/account'
import { holdAdsThisTap, isPlaybackOpen, lagosDay } from '../ads/adManager'
import { gateApplies, gateDone } from '../gate/gateStore'
import { serverTime, trialLiveNow } from '../referral/status'
import { isTvMode } from '../tv/tvMode'

/**
 * The Play popup for signed-out visitors, once the welcome trial is on (after
 * the Free Ad-Free Week): "😩 Tired of ads? Sign up free and get 👑 Premium
 * (ad-free) for 2 days!" before the player opens. Never forced: "Continue
 * with ads" (or ✕) plays as usual. At most once a day per device, never over
 * another popup (it waits for the Telegram gate's Play instead), and never
 * with an ad on the same tap.
 */

const SHOWN_KEY = 'naijatr.trialPrompt.day'
let shownThisVisit: string | null = null

interface Pending {
  action: () => void
}

let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Shown today (Lagos) on this device already. */
export function trialPromptShownToday(now = serverTime()): boolean {
  const today = lagosDay(now)
  if (shownThisVisit === today) return true
  try {
    return localStorage.getItem(SHOWN_KEY) === today
  } catch {
    return false
  }
}

function markShown(now = serverTime()) {
  shownThisVisit = lagosDay(now)
  try {
    localStorage.setItem(SHOWN_KEY, shownThisVisit)
  } catch {
    // This visit only.
  }
}

/** Another popup or sheet is up (or a player): the prompt doesn't add itself on top. */
const somethingOpen = () => isPlaybackOpen() || document.querySelector('[role="dialog"], [aria-modal="true"]') !== null

/** Whether this Play shows the popup. */
export function trialPromptDue(): boolean {
  if (accountStatusNow() !== 'signedOut' || isTvMode()) return false
  if (!trialLiveNow() || trialPromptShownToday()) return false
  // The Telegram gate asks first on this Play: one popup per Play.
  if (gateApplies() && !gateDone()) return false
  return !somethingOpen()
}

/** Runs `action` (the playback) now, or after the popup. Call it from the Play button's click. */
export function playAfterTrialPrompt(action: () => void): void {
  if (!trialPromptDue()) return action()
  // No ad on the tap that opens it.
  holdAdsThisTap()
  markShown()
  pending = { action }
  emit()
}

/** "Continue with ads" or ✕: close and play as usual (no ad on this tap either). */
export function continueWithAds(): void {
  const current = pending
  pending = null
  emit()
  holdAdsThisTap()
  current?.action()
}

/** "Sign up free": close; the sign-up sheet opens (the caller opens it). */
export function closeTrialPrompt(): void {
  pending = null
  emit()
  holdAdsThisTap()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useTrialPromptOpen = () => {
  const sheet = useSignInSheet()
  return useSyncExternalStore(subscribe, () => pending !== null, () => false) && sheet === null
}

/** Test helper. */
export function resetTrialPrompt() {
  pending = null
  shownThisVisit = null
  emit()
}
