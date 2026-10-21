import { pageview } from '@vercel/analytics'
import { useSyncExternalStore } from 'react'
import { isDevHost } from '../ads/directLink'
import { TELEGRAM_GATE_ENABLED } from '../config/telegramGate'
import { isTvMode } from '../tv/tvMode'
import { reportReferralPlay } from '../referral/api'

/**
 * The Telegram gate: the first Play (or match Watch) on a phone or tablet asks
 * the visitor to join the official channel. Tapping Join opens Telegram and
 * starts the video; nothing is checked, and the gate never shows again on
 * that device (localStorage plus a 1-year cookie). TVs get a QR code instead.
 */

const DONE_KEY = 'naijatr.gate.joined'
const COOKIE = 'naijatr_gate_joined'
/** Set by the earlier, verified gate: those visitors already joined. */
const OLD_TOKEN_KEY = 'naijatr.gate.token'
const TV_PASS_KEY = 'naijatr.gate.tv'
const YEAR_S = 365 * 24 * 60 * 60

interface Pending {
  action: () => void
  tv: boolean
}

let pending: Pending | null = null
/** Storage blocked: don't ask again this visit. */
let doneThisVisit = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Laptops and desktops (no touch, or a Windows/macOS/Linux browser) skip the gate. iPads say "Macintosh" but have touch. */
export function isPhoneOrTablet(
  userAgent = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints || 0,
): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|KFAPWI/i.test(userAgent)) return true
  if (/Macintosh/.test(userAgent)) return touchPoints > 1
  if (/Windows|X11|Linux|CrOS/.test(userAgent)) return false
  return touchPoints > 0
}

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string): void {
  try {
    window.localStorage.setItem(key, '1')
  } catch {
    doneThisVisit = true
  }
}

/** Whether this device has been through the gate (joined, or Continue on a TV). */
export function gateDone(): boolean {
  if (doneThisVisit) return true
  if (isTvMode()) return stored(TV_PASS_KEY) === '1'
  return stored(DONE_KEY) === '1' || Boolean(stored(OLD_TOKEN_KEY)) || document.cookie.includes(`${COOKIE}=1`)
}

/** Shows in Vercel Analytics as a page view of `path` (/go/gate-shown, /go/gate-joined). */
export function trackGatePage(path: string): void {
  pageview({ route: path, path })
}

/** Whether this visit could see the gate at all (switched on, a real visit, a phone, tablet or TV). */
export function gateApplies(): boolean {
  if (!TELEGRAM_GATE_ENABLED || isDevHost()) return false
  return isTvMode() || isPhoneOrTablet()
}

/**
 * Runs `action` (the playback) now, or after the gate on a first Play. Call it
 * from the Play/Watch button's click.
 */
export function playAfterGate(action: () => void): void {
  // Every Play (movie, episode or match) passes here: an invited device's first one counts for the friend.
  reportReferralPlay()
  if (!gateApplies() || gateDone()) return action()
  pending = { action, tv: isTvMode() }
  emit()
  trackGatePage('/go/gate-shown')
}

/** Join tapped (or Continue on a TV): remember it, close the gate and play. */
export function passGate(): void {
  if (isTvMode()) {
    store(TV_PASS_KEY)
  } else {
    store(DONE_KEY)
    document.cookie = `${COOKIE}=1; Path=/; Max-Age=${YEAR_S}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
    trackGatePage('/go/gate-joined')
  }
  const current = pending
  pending = null
  emit()
  current?.action()
}

/** Not now: close without playing. */
export function cancelGate(): void {
  pending = null
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const usePendingGate = () => useSyncExternalStore(subscribe, () => pending)

/** Test helper. */
export function resetGate(): void {
  pending = null
  doneThisVisit = false
  emit()
}
