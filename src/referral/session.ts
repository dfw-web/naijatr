import { useSyncExternalStore } from 'react'

/** The signed-in referral account (Telegram Login), kept on this device. */

const SESSION_KEY = 'naijatr.ref.session'

export interface ReferralUser {
  code: string
  nickname: string
  hidden: boolean
  link: string
}

export interface ReferralSession {
  token: string
  user: ReferralUser
}

const listeners = new Set<() => void>()
let cache: { raw: string | null; session: ReferralSession | null } = { raw: null, session: null }

export function readSession(): ReferralSession | null {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(SESSION_KEY)
  } catch {
    return cache.session
  }
  if (raw === cache.raw) return cache.session
  let session: ReferralSession | null = null
  try {
    const parsed = raw ? (JSON.parse(raw) as ReferralSession) : null
    if (parsed && typeof parsed.token === 'string' && parsed.user) session = parsed
  } catch {
    // Signed out.
  }
  cache = { raw, session }
  return session
}

export function saveSession(session: ReferralSession | null) {
  const raw = session ? JSON.stringify(session) : null
  try {
    if (raw) window.localStorage.setItem(SESSION_KEY, raw)
    else window.localStorage.removeItem(SESSION_KEY)
  } catch {
    // This visit only.
  }
  cache = { raw, session }
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useReferralSession = () => useSyncExternalStore(subscribe, readSession, () => null)
