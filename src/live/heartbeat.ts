import { useEffect, useSyncExternalStore } from 'react'

/**
 * Live viewer counter, browser side (server: server/live/handlers.ts).
 *
 * Once a minute, while the tab is visible, sends POST /api/live/heartbeat with
 * an anonymous random id and whether this tab is watching something (a film,
 * an episode or a match) or browsing. A hidden tab sends nothing, so it drops
 * out of the count after two minutes; coming back sends one straight away.
 * Starting or leaving a player sends one at once, so the count follows along.
 *
 * Nothing here is personal: the id is random, kept in localStorage so one
 * browser counts once, and it's never linked to anything else.
 */

export const HEARTBEAT_MS = 60_000
/** Changes (play, stop, another match page) are sent after this pause, so quick switches send one heartbeat. */
const CHANGE_DELAY_MS = 1500
const SID_KEY = 'naijatr.live.sid'
const ENDPOINT = '/api/live/heartbeat'

/** What a tab is watching, e.g. "movie:550", "tv:1399", "match:123". */
export type LiveItem = `${'movie' | 'tv' | 'match'}:${number}`

let started = false
let timer: number | undefined
let changeTimer: number | undefined
let lastSent = 0
let nextToken = 0
/** Players that are open (the latest one wins). */
const watching = new Map<number, LiveItem>()
/** Pages that ask how many are watching (a football match page). */
const about = new Map<number, LiveItem>()

/** "X watching now" for the match page open in this tab. */
let matchWatchers: { item: LiveItem; count: number } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

const latest = (map: Map<number, LiveItem>) => [...map.values()].at(-1) ?? null

function sessionId(): string {
  try {
    const saved = window.localStorage.getItem(SID_KEY)
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved
  } catch {
    // Storage blocked: a new id for this page load.
  }
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  try {
    window.localStorage.setItem(SID_KEY, id)
  } catch {
    // Not remembered; it still works for this page load.
  }
  return id
}

let sid: string | null = null

async function send() {
  if (!started || document.visibilityState === 'hidden') return
  lastSent = Date.now()
  const item = latest(watching)
  const page = latest(about)
  const body = item ? { sid: (sid ??= sessionId()), state: 'watch', item } : { sid: (sid ??= sessionId()), state: 'browse', item: page }
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    })
    if (!response.ok) return
    const answer = (await response.json()) as { watching?: unknown }
    const subject = item?.startsWith('match:') ? item : page
    if (subject && typeof answer.watching === 'number') {
      matchWatchers = { item: subject, count: answer.watching }
      emit()
    }
  } catch {
    // Offline or blocked: the next heartbeat tries again.
  }
}

function sendSoon() {
  if (!started) return
  window.clearTimeout(changeTimer)
  changeTimer = window.setTimeout(() => void send(), CHANGE_DELAY_MS)
}

const onVisibility = () => {
  if (document.visibilityState === 'visible' && Date.now() - lastSent >= HEARTBEAT_MS) void send()
}

/** Starts the heartbeat for this page load (main.tsx). Not on localhost, where there's no store. */
export function startLiveHeartbeat(): void {
  if (started) return
  started = true
  void send()
  timer = window.setInterval(() => {
    if (document.visibilityState !== 'hidden') void send()
  }, HEARTBEAT_MS)
  document.addEventListener('visibilitychange', onVisibility)
}

/** While `item` is set, this tab counts as watching it. */
export function useLiveWatching(item: LiveItem | null): void {
  useEffect(() => {
    if (!item) return
    const token = nextToken++
    watching.set(token, item)
    sendSoon()
    return () => {
      watching.delete(token)
      sendSoon()
    }
  }, [item])
}

/** How many are watching this match right now (null until known), and counts this page as viewing it. */
export function useMatchWatchers(item: LiveItem | null): number | null {
  useEffect(() => {
    if (!item) return
    const token = nextToken++
    about.set(token, item)
    sendSoon()
    return () => {
      about.delete(token)
    }
  }, [item])
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => matchWatchers,
  )
  return current && current.item === item ? current.count : null
}

/** Test helper. */
export function resetLiveHeartbeat(): void {
  started = false
  window.clearInterval(timer)
  window.clearTimeout(changeTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  watching.clear()
  about.clear()
  matchWatchers = null
  lastSent = 0
  sid = null
}
