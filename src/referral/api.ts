import { useEffect, useState } from 'react'
import { sessionId } from '../live/heartbeat'
import { readRef, saveRef } from './capture'
import { readSession, saveSession, type ReferralUser } from './session'

/** The browser side of /api/referral/* (server/referral/handlers.ts). */

export type ContestPhase = 'off' | 'upcoming' | 'live' | 'ended'

export interface ContestInfo {
  phase: ContestPhase
  start: number | null
  end: number | null
  prizes: number[] | null
  winners: string[] | null
}

const OFF: ContestInfo = { phase: 'off', start: null, end: null, prizes: null, winners: null }

const authHeaders = (): Record<string, string> => {
  const session = readSession()
  return session ? { Authorization: `Bearer ${session.token}` } : {}
}

async function call<T>(action: string, init: { body?: unknown; query?: string } = {}): Promise<{ status: number; data: T | null }> {
  try {
    const response = await fetch(`/api/referral/${action}${init.query ?? ''}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: { ...authHeaders(), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    })
    // Signed out on the server (expired): forget it here too.
    if (response.status === 401 && readSession() && action !== 'login') saveSession(null)
    return { status: response.status, data: response.ok ? ((await response.json()) as T) : null }
  } catch {
    return { status: 0, data: null }
  }
}

let contestPromise: Promise<ContestInfo> | null = null

/** The contest, once per page load. */
export function loadContest(): Promise<ContestInfo> {
  contestPromise ??= call<ContestInfo>('contest').then(({ data }) => data ?? OFF)
  return contestPromise
}

export function useContest(): ContestInfo | null {
  const [contest, setContest] = useState<ContestInfo | null>(null)
  useEffect(() => {
    let live = true
    void loadContest().then((c) => {
      if (live) setContest(c)
    })
    return () => {
      live = false
    }
  }, [])
  return contest
}

export async function login(auth: unknown): Promise<boolean> {
  const { data } = await call<{ token: string; user: ReferralUser }>('login', { body: { auth, device: sessionId() } })
  if (data) saveSession(data)
  return Boolean(data)
}

export interface Me {
  user: ReferralUser
  total: number
  points: number
  rank: number | null
}

export const fetchMe = () => call<Me>('me').then(({ data }) => data)

export async function updateProfile(change: { nickname?: string; hidden?: boolean }) {
  const { status, data } = await call<{ user: ReferralUser }>('profile', { body: change })
  const session = readSession()
  if (data && session) saveSession({ ...session, user: data.user })
  return status
}

export interface Leaderboard {
  top: { rank: number; points: number; name: string; me: boolean }[]
  me: { rank: number | null; points: number } | null
}

export const fetchLeaderboard = () => call<Leaderboard>('leaderboard').then(({ data }) => data)

export const fetchClaim = (token: string) => call<{ place: string; amount: number }>('claim', { query: `?t=${encodeURIComponent(token)}` })

export const sendClaim = (body: Record<string, string>) => call<{ ok: true }>('claim', { body })

/**
 * Something started playing: if this device came by an invite link, report
 * it once so the friend gets their point. Called for every Play (gateStore).
 */
export function reportReferralPlay() {
  const ref = readRef()
  if (!ref || ref.reported || !ref.newDevice) return
  saveRef({ ...ref, reported: true })
  void call<{ outcome: string }>('count', { body: { device: sessionId() } }).then(({ status }) => {
    // Network trouble: try again on the next play.
    if (status === 0 || status >= 500) saveRef({ ...ref, reported: false })
  })
}

/** Naira, e.g. ₦30,000. */
export const naira = (amount: number) => `₦${amount.toLocaleString('en-NG')}`
/** Short, e.g. ₦30k. */
export const nairaShort = (amount: number) => (amount % 1000 === 0 ? `₦${amount / 1000}k` : naira(amount))

/** "Sunday 11:59 PM", Lagos time. */
export const endLabel = (end: number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Lagos', weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(end))
    .replace(',', '')

/** "1d 04h 12m 30s" until `end`, ticking every second. */
export function formatCountdown(left: number) {
  const s = Math.floor(Math.max(0, left) / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = Math.floor(s / 86400)
  return `${d ? `${d}d ` : ''}${pad(Math.floor((s % 86400) / 3600))}h ${pad(Math.floor((s % 3600) / 60))}m ${pad(s % 60)}s`
}

export function useCountdown(end: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!end) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [end])
  return end ? formatCountdown(end - now) : ''
}
