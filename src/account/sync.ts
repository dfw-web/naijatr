import { useSyncExternalStore } from 'react'
import { SYNC_INTERVAL_MS, SYNC_RETRY_MS } from '../config/account'
import { readTaste, replaceTaste, subscribeTaste, type TasteProfile } from '../taste/profile'
import {
  readContinueWatching,
  replaceContinueWatching,
  subscribeContinueWatching,
  type ContinueEntry,
} from '../utils/continueWatching'
import { readWatchLater, replaceWatchLater, subscribeWatchLater, type WatchLaterEntry } from '../utils/watchLater'
import { readDramaHistory, replaceDramaHistory, subscribeDramaHistory, type DramaHistoryEntry } from '../dramas/history'
import {
  allPending,
  combineTaste,
  continueEntry,
  continueRow,
  dramaEntry,
  dramaRow,
  listEntry,
  listRow,
  mergeContinue,
  mergeDramas,
  mergeList,
  type ContinueRow,
  type DramaRow,
  type ListRow,
  type PendingMap,
} from './merge'
import { hasStoredSession } from './client'

/**
 * Account sync for Continue Watching, My List, the taste profile and "Your
 * short dramas" (src/dramas/history.ts), while
 * signed in. This device's stores (localStorage) stay the ones the app reads
 * and writes, instantly, exactly as when signed out; this keeps the account in
 * step behind them:
 *
 * - every local change is noted as pending (kept in localStorage, so it
 *   survives going offline or closing the tab) and sent within a second, or,
 *   while watching, at most every 15 seconds, and at once on pause, close or
 *   leaving the page (requestSyncNow);
 * - on start (sign-in, opening the site), and when the tab comes back after a
 *   while, the account's data is loaded and merged (src/account/merge.ts), so
 *   another phone shows the same episode, time and My List;
 * - the first sign-in on a device merges everything here into the account;
 * - failures keep everything local and try again a minute later or when the
 *   phone is back online.
 */

export interface RemoteData {
  continueRows: ContinueRow[]
  listRows: ListRow[]
  taste: TasteProfile | null
  /**
   * "Your short dramas"; null when the account can't give them (its table not
   * set up yet: supabase/migrations/005_drama_history.sql). They then stay on
   * this device and pending, and the rest syncs as usual.
   */
  dramaRows?: DramaRow[] | null
}

/** Where the account's data lives (Supabase: src/account/backend.ts; tests: in memory). */
export interface SyncBackend {
  pull(): Promise<RemoteData>
  upsertContinue(rows: ContinueRow[]): Promise<void>
  deleteContinue(ids: string[]): Promise<void>
  upsertList(rows: ListRow[]): Promise<void>
  deleteList(ids: string[]): Promise<void>
  saveTaste(profile: TasteProfile): Promise<void>
  upsertDramas(rows: DramaRow[]): Promise<void>
  deleteDramas(ids: string[]): Promise<void>
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error'

const PENDING_KEY = 'naijatr.sync.pending'
/** The account this device last synced with: another account signing in here starts with a merge. */
const USER_KEY = 'naijatr.sync.user'
/** Coming back to the tab after this long loads the account again (progress made on another phone). */
const REFRESH_AFTER_MS = 60_000
/** Changes are gathered for this long before they're sent. */
const DEBOUNCE_MS = 1000

interface Pending {
  cw: PendingMap
  list: PendingMap
  dramas: PendingMap
  /** "merge": this device's profile still has to be combined with the account's (first sign-in here). */
  taste: false | 'up' | 'merge'
}

const noPending = (): Pending => ({ cw: {}, list: {}, dramas: {}, taste: false })

function readPending(): Pending {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as Partial<Pending> | null
    return { ...noPending(), ...(parsed ?? {}) }
  } catch {
    return memoryPending ?? noPending()
  }
}

let memoryPending: Pending | null = null
function writePending(pending: Pending) {
  memoryPending = pending
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    // Kept for this visit.
  }
}

const readUser = () => {
  try {
    return localStorage.getItem(USER_KEY)
  } catch {
    return null
  }
}

interface Session {
  userId: string
  backend: SyncBackend
  /** The entries as last seen, to tell what changed. */
  seen: { cw: Map<string, string>; list: Map<string, string>; dramas: Map<string, string>; taste: string }
  /** The account gave its short dramas on the last load (their table exists): they're sent. */
  dramasReady: boolean
  /** Applying the account's data: not a local change. */
  applying: boolean
  pulled: boolean
  lastPullAt: number
  lastPushAt: number
  timer: number | undefined
  retry: number | undefined
  inFlight: Promise<void> | null
  /** The account being loaded: a second request joins it. */
  pulling: Promise<void> | null
  /** Changed while a push was on its way: still pending afterwards. */
  touched: { cw: Set<string>; list: Set<string>; dramas: Set<string>; taste: boolean }
  cleanup: (() => void)[]
}

let session: Session | null = null
let state: { status: SyncState; lastSyncedAt: number | null } = { status: 'idle', lastSyncedAt: null }
const listeners = new Set<() => void>()
const setState = (next: Partial<typeof state>) => {
  state = { ...state, ...next }
  listeners.forEach((listener) => listener())
}

const snapshot = <T extends { id: string }>(list: T[]) => new Map(list.map((entry) => [entry.id, JSON.stringify(entry)]))
const tasteHasData = (profile: TasteProfile) => Object.keys(profile.attrs).length > 0 || profile.titles.length > 0 || profile.asked

const lookNow = () => ({
  cw: snapshot(readContinueWatching()),
  list: snapshot(readWatchLater()),
  dramas: snapshot(readDramaHistory()),
  taste: JSON.stringify(readTaste()),
})

function look(s: Session) {
  s.seen = lookNow()
}

/** What changed in one store since it was last seen: changed or new → "up", gone → "del". */
function diff(before: Map<string, string>, after: Map<string, string>): PendingMap {
  const ops: PendingMap = {}
  for (const [id, json] of after) if (before.get(id) !== json) ops[id] = 'up'
  for (const id of before.keys()) if (!after.has(id)) ops[id] = 'del'
  return ops
}

function onLocalChange() {
  const s = session
  if (!s || s.applying) return
  const now = lookNow()
  const cw = diff(s.seen.cw, now.cw)
  const list = diff(s.seen.list, now.list)
  const dramas = diff(s.seen.dramas, now.dramas)
  const taste = now.taste !== s.seen.taste
  s.seen = now
  if (!Object.keys(cw).length && !Object.keys(list).length && !Object.keys(dramas).length && !taste) return
  const pending = readPending()
  Object.assign(pending.cw, cw)
  Object.assign(pending.list, list)
  Object.assign(pending.dramas, dramas)
  if (taste && pending.taste !== 'merge') pending.taste = 'up'
  writePending(pending)
  if (s.inFlight) {
    Object.keys(cw).forEach((id) => s.touched.cw.add(id))
    Object.keys(list).forEach((id) => s.touched.list.add(id))
    Object.keys(dramas).forEach((id) => s.touched.dramas.add(id))
    s.touched.taste ||= taste
  }
  schedulePush()
}

function schedulePush() {
  const s = session
  if (!s || s.timer !== undefined) return
  const wait = Math.max(DEBOUNCE_MS, s.lastPushAt + SYNC_INTERVAL_MS - Date.now())
  s.timer = window.setTimeout(() => {
    s.timer = undefined
    void push(s)
  }, wait)
}

function failed(s: Session) {
  setState({ status: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error' })
  window.clearTimeout(s.retry)
  s.retry = window.setTimeout(() => void (s.pulled ? push(s) : pull(s)), SYNC_RETRY_MS)
}

/** Sends what's pending. One at a time; a change made meanwhile goes in the next one. */
async function push(s: Session): Promise<void> {
  if (session !== s) return
  if (s.inFlight) {
    await s.inFlight
    if (session === s && hasPending()) return push(s)
    return
  }
  if (!s.pulled) return pull(s)
  const pending = readPending()
  if (!hasPending(pending, s.dramasReady)) return
  s.touched = { cw: new Set(), list: new Set(), dramas: new Set(), taste: false }
  const cw = readContinueWatching()
  const saved = readWatchLater()
  // Short dramas wait while the account has no table for them.
  const dramas = s.dramasReady ? readDramaHistory() : []
  const dramaOps: PendingMap = s.dramasReady ? pending.dramas : {}
  const rows = <T extends { id: string }, R>(map: PendingMap, list: T[], toRow: (userId: string, entry: T) => R) =>
    Object.entries(map).flatMap(([id, op]) => {
      const entry = op === 'up' ? list.find((e) => e.id === id) : undefined
      return entry ? [toRow(s.userId, entry)] : []
    })
  const gone = (map: PendingMap, list: { id: string }[]) =>
    Object.entries(map)
      .filter(([id, op]) => op === 'del' || !list.some((e) => e.id === id))
      .map(([id]) => id)
  s.lastPushAt = Date.now()
  setState({ status: 'syncing' })
  const work = (async () => {
    const cwRows = rows(pending.cw, cw, continueRow)
    const listRows = rows(pending.list, saved, listRow)
    const cwGone = gone(pending.cw, cw)
    const listGone = gone(pending.list, saved)
    const dramaRows = rows(dramaOps, dramas, dramaRow)
    const dramasGone = gone(dramaOps, dramas)
    if (cwRows.length) await s.backend.upsertContinue(cwRows)
    if (cwGone.length) await s.backend.deleteContinue(cwGone)
    if (listRows.length) await s.backend.upsertList(listRows)
    if (listGone.length) await s.backend.deleteList(listGone)
    if (pending.taste) await s.backend.saveTaste(readTaste())
    if (dramaRows.length) await s.backend.upsertDramas(dramaRows)
    if (dramasGone.length) await s.backend.deleteDramas(dramasGone)
  })()
  s.inFlight = work.then(
    () => undefined,
    () => undefined,
  )
  try {
    await work
    // Sent: no longer pending, unless it changed again meanwhile.
    const now = readPending()
    for (const id of Object.keys(pending.cw)) if (!s.touched.cw.has(id) && now.cw[id] === pending.cw[id]) delete now.cw[id]
    for (const id of Object.keys(pending.list)) if (!s.touched.list.has(id) && now.list[id] === pending.list[id]) delete now.list[id]
    for (const id of Object.keys(dramaOps)) if (!s.touched.dramas.has(id) && now.dramas[id] === dramaOps[id]) delete now.dramas[id]
    if (pending.taste && !s.touched.taste) now.taste = false
    writePending(now)
    setState({ status: 'idle', lastSyncedAt: Date.now() })
  } catch {
    failed(s)
  } finally {
    s.inFlight = null
  }
  if (session === s && hasPending() && s.timer === undefined && s.retry === undefined) schedulePush()
}

/** Something to send (short dramas only while the account takes them). */
const hasPending = (pending = readPending(), dramas = session?.dramasReady ?? true) =>
  Object.keys(pending.cw).length > 0 ||
  Object.keys(pending.list).length > 0 ||
  pending.taste !== false ||
  (dramas && Object.keys(pending.dramas).length > 0)

/** Loads the account, merges this device's pending changes in, and sends them. */
function pull(s: Session): Promise<void> {
  s.pulling ??= load(s).finally(() => {
    s.pulling = null
    settled()
  })
  return s.pulling
}

// Waiting for the account's data before a movie starts (syncSettled).
const waiters = new Set<() => void>()
const settled = () => {
  const now = [...waiters]
  waiters.clear()
  now.forEach((resolve) => resolve())
}

/** True while the account's data is being loaded (or the signed-in account is still starting). */
export const syncLoading = () => (session ? session.pulling !== null : hasStoredSession())

/** How long a Play waits for the account's data at most. */
export const SYNC_WAIT_MS = 4000

/**
 * Resolves once the account's Continue watching is here: at once when signed
 * out or already loaded, else when the load running now (or the first one,
 * while the account is still starting) ends, at most `waitMs`. A Play waits
 * for it, so it resumes at the time saved on the account (watched on another
 * phone), not at an older one here that would then overwrite it.
 */
export function syncSettled(waitMs = SYNC_WAIT_MS): Promise<void> {
  if (!syncLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer)
      waiters.delete(done)
      resolve()
    }
    const timer = window.setTimeout(done, waitMs)
    waiters.add(done)
  })
}

async function load(s: Session): Promise<void> {
  if (session !== s) return
  if (s.inFlight) await s.inFlight
  setState({ status: 'syncing' })
  let remote: RemoteData
  try {
    remote = await s.backend.pull()
  } catch {
    failed(s)
    return
  }
  if (session !== s) return
  window.clearTimeout(s.retry)
  s.retry = undefined
  s.lastPullAt = Date.now()
  // Pending as of now (it may have changed while loading).
  onLocalChange()
  const pending = readPending()
  const cw = mergeContinue(
    readContinueWatching(),
    remote.continueRows.map(continueEntry).filter((e): e is ContinueEntry => e !== null),
    pending.cw,
  )
  const list = mergeList(
    readWatchLater(),
    remote.listRows.map(listEntry).filter((e): e is WatchLaterEntry => e !== null),
    pending.list,
  )
  s.dramasReady = Array.isArray(remote.dramaRows)
  const dramas = s.dramasReady
    ? mergeDramas(
        readDramaHistory(),
        (remote.dramaRows ?? []).map(dramaEntry).filter((e): e is DramaHistoryEntry => e !== null),
        pending.dramas,
      )
    : null
  const local = readTaste()
  const taste =
    pending.taste === 'merge'
      ? remote.taste
        ? combineTaste(local, remote.taste)
        : local
      : pending.taste === 'up'
        ? local
        : (remote.taste ?? local)
  s.applying = true
  try {
    replaceContinueWatching(cw.list)
    replaceWatchLater(list.list)
    if (dramas) replaceDramaHistory(dramas.list)
    if (JSON.stringify(taste) !== JSON.stringify(local)) replaceTaste(taste)
  } finally {
    s.applying = false
  }
  look(s)
  // What the account still needs: the merge's winners and removals.
  writePending({
    cw: { ...allPending(cw.upload), ...Object.fromEntries(cw.remove.map((id) => [id, 'del' as const])) },
    list: { ...allPending(list.upload), ...Object.fromEntries(list.remove.map((id) => [id, 'del' as const])) },
    dramas: dramas
      ? { ...allPending(dramas.upload), ...Object.fromEntries(dramas.remove.map((id) => [id, 'del' as const])) }
      : pending.dramas,
    taste: pending.taste ? 'up' : false,
  })
  s.pulled = true
  if (hasPending()) await push(s)
  else setState({ status: 'idle', lastSyncedAt: Date.now() })
}

/**
 * Starts syncing for `userId` (signed in). Resolves once the account's data
 * has been loaded and merged, or the first try has failed (it retries).
 */
export async function startSync(userId: string, backend: SyncBackend): Promise<void> {
  stopSync()
  const firstHere = readUser() !== userId
  if (firstHere) {
    const profile = readTaste()
    writePending({
      cw: allPending(readContinueWatching()),
      list: allPending(readWatchLater()),
      dramas: allPending(readDramaHistory()),
      taste: tasteHasData(profile) ? 'merge' : false,
    })
    try {
      localStorage.setItem(USER_KEY, userId)
    } catch {
      // Merged again next time: harmless.
    }
  }
  const s: Session = {
    userId,
    backend,
    seen: { cw: new Map(), list: new Map(), dramas: new Map(), taste: '' },
    dramasReady: false,
    applying: false,
    pulled: false,
    lastPullAt: 0,
    lastPushAt: 0,
    timer: undefined,
    retry: undefined,
    inFlight: null,
    pulling: null,
    touched: { cw: new Set(), list: new Set(), dramas: new Set(), taste: false },
    cleanup: [],
  }
  look(s)
  session = s
  s.cleanup.push(subscribeContinueWatching(onLocalChange), subscribeWatchLater(onLocalChange), subscribeTaste(onLocalChange), subscribeDramaHistory(onLocalChange))
  const onHidden = () => {
    if (document.visibilityState === 'hidden') return requestSyncNow()
    // Back to the tab: what was watched on another phone meanwhile.
    if (Date.now() - s.lastPullAt > REFRESH_AFTER_MS) void pull(s)
  }
  const onPageHide = () => requestSyncNow()
  const onOnline = () => void (s.pulled ? push(s) : pull(s))
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('online', onOnline)
  s.cleanup.push(() => {
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('online', onOnline)
  })
  await pull(s)
}

/** Stops syncing (signing out). This device keeps its data, as when signed out. */
export function stopSync(): void {
  const s = session
  if (!s) return
  session = null
  window.clearTimeout(s.timer)
  window.clearTimeout(s.retry)
  s.cleanup.forEach((fn) => fn())
  setState({ status: 'idle' })
  settled()
}

/** Sends pending changes now (player paused or closed, page hidden). Nothing while signed out. */
export function requestSyncNow(): Promise<void> {
  const s = session
  if (!s) return Promise.resolve()
  window.clearTimeout(s.timer)
  s.timer = undefined
  return push(s)
}

/** Loads the account again now (e.g. the Account page's "Sync now"). */
export function refreshSync(): Promise<void> {
  return session ? pull(session) : Promise.resolve()
}

/** Forgets which account this device synced with (deleting the account). */
export function forgetSyncedAccount(): void {
  writePending(noPending())
  try {
    localStorage.removeItem(USER_KEY)
  } catch {
    // Nothing stored.
  }
}

export const useSyncState = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => state,
    () => state,
  )

/** Test helper. */
export function resetSync(): void {
  stopSync()
  memoryPending = null
  state = { status: 'idle', lastSyncedAt: null }
}
