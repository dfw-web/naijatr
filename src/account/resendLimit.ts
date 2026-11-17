import { useEffect, useState, useSyncExternalStore } from 'react'
import { useCooldownSeconds } from './authRules'

/**
 * "Resend email" under every "Email sent" note: at most 3 resends an hour on
 * this device (the first email doesn't count), on top of the 60 seconds
 * between any two emails (account.ts). Kept in localStorage, so reloading the
 * page doesn't reset it; storage blocked: kept for this visit.
 */

export const RESEND_LIMIT = 3
export const RESEND_WINDOW_MS = 60 * 60_000
const KEY = 'naijatr.auth.resends'

let memory: number[] = []
const listeners = new Set<() => void>()

function read(now = Date.now()): number[] {
  let list = memory
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (Array.isArray(parsed)) list = parsed.filter((t): t is number => typeof t === 'number')
  } catch {
    // The copy kept for this visit.
  }
  return list.filter((time) => time > now - RESEND_WINDOW_MS && time <= now + 60_000)
}

/** A resend went out. */
export function recordResend(now = Date.now()): void {
  memory = [...read(now), now]
  try {
    localStorage.setItem(KEY, JSON.stringify(memory))
  } catch {
    // Kept for this visit.
  }
  listeners.forEach((listener) => listener())
}

/** Milliseconds until another resend is allowed by the hourly limit (0: now). */
export function resendLimitWait(now = Date.now()): number {
  const recent = read(now).sort((a, b) => a - b)
  if (recent.length < RESEND_LIMIT) return 0
  return Math.max(0, recent[recent.length - RESEND_LIMIT] + RESEND_WINDOW_MS - now)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * What a Resend button may do now: `seconds` of the 60-second wait left, and
 * `limitMinutes` until the hourly limit allows another (0: not limited).
 */
export function useResendWait(): { seconds: number; limitMinutes: number } {
  const seconds = useCooldownSeconds()
  // Re-renders on each resend (here or in another tab), and every 15 s while limited.
  useSyncExternalStore(subscribe, () => read().length, () => 0)
  const [, setTick] = useState(0)
  const limitMs = resendLimitWait()
  const limited = limitMs > 0
  useEffect(() => {
    if (!limited) return
    const timer = window.setInterval(() => setTick((n) => n + 1), 15_000)
    return () => window.clearInterval(timer)
  }, [limited])
  return { seconds, limitMinutes: limited ? Math.ceil(limitMs / 60_000) : 0 }
}

/** Test helper. */
export function resetResends(): void {
  memory = []
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing stored.
  }
}
