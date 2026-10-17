import { pageview } from '@vercel/analytics'
import { useSyncExternalStore } from 'react'
import { isDevHost } from '../ads/directLink'
import { GATE_RECHECK_DAYS, TELEGRAM_GATE_ENABLED } from '../config/telegramGate'
import { isTvMode } from '../tv/tvMode'

/**
 * The Telegram gate: the first Play (or match Watch) on a phone or tablet asks
 * the visitor to join the official channel and verify it with Telegram. The
 * server's signed token is kept in localStorage and a 1-year cookie, so it's
 * once per device; membership is re-checked silently every 30 days.
 *
 * It never locks anyone out: if Telegram or our API fails, playback goes ahead
 * and the check is tried again on a later visit.
 */

const TOKEN_KEY = 'naijatr.gate.token'
const COOKIE = 'naijatr_gate'
const TV_PASS_KEY = 'naijatr.gate.tv'
const YEAR_S = 365 * 24 * 60 * 60

export type GateStatus = 'joined' | 'not-joined' | 'invalid' | 'unavailable'

interface Pending {
  action: () => void
  tv: boolean
  /** Shown straight away: the result of a login Telegram sent back to the page (see resumeTelegramRedirect). */
  status?: GateStatus
}

let pending: Pending | null = null
/** Telegram couldn't be reached: watch freely until the next visit. */
let passThisVisit = false
let recheckedThisVisit = false
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

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readCookie(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

export function readGateToken(): string | null {
  try {
    return storage()?.getItem(TOKEN_KEY) || readCookie()
  } catch {
    return readCookie()
  }
}

export function saveGateToken(token: string): void {
  try {
    storage()?.setItem(TOKEN_KEY, token)
  } catch {
    // The cookie below still keeps it.
  }
  // The server sets this cookie too (which Safari keeps longer); this covers the dev server and old browsers.
  document.cookie = `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${YEAR_S}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
}

export function clearGateToken(): void {
  try {
    storage()?.removeItem(TOKEN_KEY)
  } catch {
    // Nothing stored.
  }
  document.cookie = `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

/** When membership was last confirmed (ms), read from the token's payload; null if it isn't one of ours. */
export function tokenConfirmedAt(token: string): number | null {
  try {
    const payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')
    const { iat } = JSON.parse(atob(payload)) as { iat?: unknown }
    return typeof iat === 'number' ? iat * 1000 : null
  } catch {
    return null
  }
}

/** Shows in Vercel Analytics as a page view of `path` (/go/gate-shown, /go/gate-verified). */
export function trackGatePage(path: string): void {
  pageview({ route: path, path })
}

export async function postGate(action: 'verify' | 'recheck', body: unknown): Promise<{ status: GateStatus; token?: string }> {
  const response = await fetch(`/api/telegram/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
  const result = (await response.json().catch(() => ({}))) as { status?: GateStatus; token?: string }
  return result.status ? { status: result.status, token: result.token } : { status: 'unavailable' }
}

/** Every 30 days, in the background: still in the channel? If not, the gate shows on the next Play. */
function recheckIfDue(token: string): void {
  const confirmedAt = tokenConfirmedAt(token)
  if (confirmedAt === null) return clearGateToken()
  if (recheckedThisVisit || Date.now() - confirmedAt < GATE_RECHECK_DAYS * 24 * 60 * 60 * 1000) return
  recheckedThisVisit = true
  postGate('recheck', { token })
    .then(({ status, token: fresh }) => {
      if (status === 'joined' && fresh) saveGateToken(fresh)
      else if (status === 'not-joined' || status === 'invalid') clearGateToken()
      // "unavailable": keep the token and try again next visit.
    })
    .catch(() => {})
}

/** Whether this visit could see the gate at all (switched on, a real visit, a phone, tablet or TV). */
export function gateApplies(): boolean {
  if (!TELEGRAM_GATE_ENABLED || isDevHost()) return false
  return isTvMode() || isPhoneOrTablet()
}

function tvPassed(): boolean {
  try {
    return storage()?.getItem(TV_PASS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Runs `action` (the playback) now, or after the gate on a first Play. Call it
 * from the Play/Watch button's click.
 */
export function playAfterGate(action: () => void): void {
  if (!gateApplies()) return action()
  if (isTvMode()) {
    if (tvPassed()) return action()
  } else {
    const token = readGateToken()
    if (token) {
      recheckIfDue(token)
      return action()
    }
    if (passThisVisit) return action()
  }
  pending = { action, tv: isTvMode() }
  emit()
  trackGatePage('/go/gate-shown')
}

/** Verified (or Telegram is down, or the TV's Continue): close the gate and play. */
export function passGate(how: 'verified' | 'unavailable' | 'tv', token?: string): void {
  if (how === 'verified' && token) {
    saveGateToken(token)
    trackGatePage('/go/gate-verified')
  }
  if (how === 'unavailable') passThisVisit = true
  if (how === 'tv') {
    try {
      storage()?.setItem(TV_PASS_KEY, '1')
    } catch {
      passThisVisit = true
    }
  }
  const current = pending
  pending = null
  emit()
  current?.action()
}

/** Telegram's login data, as the Login Widget hands it over. */
export type TelegramAuthData = Record<string, string | number>

/** Sends a Telegram login to the server; the gate closes on success. Returns what to tell the visitor. */
export async function verifyLogin(data: TelegramAuthData): Promise<GateStatus> {
  let result: { status: GateStatus; token?: string }
  try {
    result = await postGate('verify', data)
  } catch {
    result = { status: 'unavailable' }
  }
  if (result.status === 'joined' && result.token) passGate('verified', result.token)
  else if (result.status === 'unavailable' || result.status === 'joined') passGate('unavailable')
  return result.status
}

const AUTH_RESULT = /[#?&]tgAuthResult=([A-Za-z0-9\-_=]*)$/

/**
 * Some in-app browsers can't open Telegram's login popup, so Telegram opens
 * it in the same tab and comes back with #tgAuthResult=… on the address.
 * Finish the check here; the visitor then presses Play again.
 */
export function resumeTelegramRedirect(): void {
  const match = window.location.hash.match(AUTH_RESULT)
  if (!match) return
  const hash = window.location.hash.replace(AUTH_RESULT, '')
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`)
  let data: TelegramAuthData
  try {
    const raw = match[1].replace(/-/g, '+').replace(/_/g, '/')
    data = JSON.parse(atob(raw + '='.repeat((4 - (raw.length % 4)) % 4))) as TelegramAuthData
  } catch {
    return
  }
  if (!data || typeof data !== 'object') return
  void verifyLogin(data).then((status) => {
    if (status !== 'not-joined' && status !== 'invalid') return
    pending = { action: () => {}, tv: false, status }
    emit()
  })
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
  passThisVisit = false
  recheckedThisVisit = false
  emit()
}
