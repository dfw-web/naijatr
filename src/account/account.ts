import { useSyncExternalStore } from 'react'
import { pageview } from '@vercel/analytics'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { accountsEnabled } from '../config/account'
import { readTaste } from '../taste/profile'
import { readContinueWatching } from '../utils/continueWatching'
import { readWatchLater } from '../utils/watchLater'
import { supabaseBackend } from './backend'
import { getClient, hasStoredSession, takeAuthRedirect } from './client'
import { forgetSyncedAccount, requestSyncNow, startSync, stopSync } from './sync'

/**
 * The optional account: signed out (everything stays on this device, as
 * always), or signed in with an email link (synced: src/account/sync.ts).
 * "disabled" while Supabase isn't configured: then nothing account-related
 * shows anywhere.
 */

export type AccountStatus = 'disabled' | 'signedOut' | 'checking' | 'signedIn'

export interface AccountUser {
  id: string
  email: string
}

interface AccountState {
  status: AccountStatus
  user: AccountUser | null
  /** An email link that didn't work (expired, already used). */
  linkError: string | null
}

let state: AccountState = { status: 'disabled', user: null, linkError: null }
let sheetOpen = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const set = (next: Partial<AccountState>) => {
  state = { ...state, ...next }
  emit()
}

/** Shows in Vercel Analytics as a page view, e.g. /go/account?event=signed-in. */
const track = (event: string) => pageview({ route: '/go/account', path: `/go/account?event=${event}` })

const asUser = (user: User): AccountUser => ({ id: user.id, email: user.email ?? '' })

let started = false

/**
 * Called once when the site opens. Loads the account library only if this
 * device has signed in before or is coming back from an email link.
 */
export function initAccount(): void {
  if (started) return
  started = true
  if (!accountsEnabled()) return set({ status: 'disabled' })
  const redirect = takeAuthRedirect()
  if (!redirect && !hasStoredSession()) return set({ status: 'signedOut' })
  set({ status: 'checking' })
  if (redirect?.error) {
    set({ linkError: redirect.error })
    sheetOpen = true
  }
  void getClient()
    .then(async (client) => {
      listen(client)
      if (redirect?.accessToken && redirect.refreshToken) {
        const { error } = await client.auth.setSession({ access_token: redirect.accessToken, refresh_token: redirect.refreshToken })
        if (error) {
          set({ linkError: 'That sign-in link didn’t work. Please ask for a new one.' })
          sheetOpen = true
        } else {
          track('signed-in')
        }
      }
      const { data } = await client.auth.getSession()
      if (data.session?.user) signedIn(client, data.session.user)
      else if (state.status !== 'signedIn') set({ status: 'signedOut' })
    })
    .catch(() => set({ status: 'signedOut' }))
}

let listening = false
function listen(client: SupabaseClient) {
  if (listening) return
  listening = true
  client.auth.onAuthStateChange((event, session) => {
    // Out of the callback: Supabase asks for no awaits inside it.
    window.setTimeout(() => {
      if (session?.user) signedIn(client, session.user)
      else if (event === 'SIGNED_OUT') signedOutHere()
    })
  })
}

function signedIn(client: SupabaseClient, user: User) {
  const next = asUser(user)
  if (state.status === 'signedIn' && state.user?.id === next.id) {
    if (state.user.email !== next.email) set({ user: next })
    return
  }
  sheetOpen = false
  set({ status: 'signedIn', user: next, linkError: null })
  void startSync(next.id, supabaseBackend(client, next.id))
  void saveTelegramLink(client, next.id)
}

function signedOutHere() {
  stopSync()
  set({ status: 'signedOut', user: null })
}

/** Sends the sign-in link. Comes back to the page it was asked from. */
export async function sendMagicLink(email: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const client = await getClient()
    listen(client)
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}`, shouldCreateUser: true },
    })
    if (error) {
      const tooMany = error.status === 429 || /rate|seconds/i.test(error.message)
      return { ok: false, message: tooMany ? 'Too many tries. Please wait a minute and try again.' : 'We couldn’t send the link. Check the email address and try again.' }
    }
    track('link-sent')
    return { ok: true }
  } catch {
    return { ok: false, message: 'No connection. Please try again.' }
  }
}

/** "Continue with Google" (behind GOOGLE_LOGIN_ENABLED). */
export async function signInWithGoogle(): Promise<void> {
  const client = await getClient()
  listen(client)
  await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}${window.location.pathname}` } })
}

export async function signOut(): Promise<void> {
  await requestSyncNow().catch(() => undefined)
  stopSync()
  try {
    const client = await getClient()
    await client.auth.signOut({ scope: 'local' })
  } catch {
    // Signed out here anyway.
  }
  set({ status: 'signedOut', user: null })
  track('signed-out')
}

/** Everything the account and this device hold, as a JSON file ("Download my data"). */
export async function downloadMyData(): Promise<void> {
  const client = await getClient()
  const { data: profile } = await client.from('profiles').select('telegram_id,telegram_username,telegram_name,referral_code,created_at').maybeSingle()
  const data = {
    exportedAt: new Date().toISOString(),
    account: { email: state.user?.email ?? null, id: state.user?.id ?? null },
    profile: profile ?? null,
    continueWatching: readContinueWatching(),
    myList: readWatchLater(),
    tasteProfile: readTaste(),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = 'naijatr-my-data.json'
  link.click()
  URL.revokeObjectURL(link.href)
}

/**
 * Deletes the account: its synced rows, its Telegram link and the login itself
 * (through /api/account/delete, which needs SUPABASE_SERVICE_ROLE_KEY on the
 * server). Without that key the rows are still deleted and the login stays,
 * with nothing in it; `loginDeleted` says which. This device keeps its own data.
 */
export async function deleteAccount(): Promise<{ loginDeleted: boolean }> {
  const client = await getClient()
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token
  const userId = state.user?.id
  if (!token || !userId) throw new Error('signed out')
  stopSync()
  let loginDeleted = false
  try {
    const response = await fetch('/api/account/delete', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    loginDeleted = response.ok
  } catch {
    // Rows below.
  }
  if (!loginDeleted) {
    for (const table of ['continue_watching', 'my_list', 'taste_profile', 'profiles']) {
      const { error } = await client.from(table).delete().eq('user_id', userId)
      if (error) throw error
    }
  }
  forgetSyncedAccount()
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined)
  set({ status: 'signedOut', user: null })
  track('deleted')
  return { loginDeleted }
}

// ---- Telegram: the referral/contest login, linked to the account. ----

const TELEGRAM_KEY = 'naijatr.telegram.link'

export interface TelegramLink {
  id: number | null
  username: string | null
  name: string | null
  code: string | null
}

export function readTelegramLink(): TelegramLink | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(TELEGRAM_KEY) ?? 'null') as TelegramLink | null
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * The Telegram login (contest and referrals) succeeded: remember who it was
 * on this device and, when signed in, on the account's profile.
 */
export function rememberTelegram(auth: unknown, code: string | null): void {
  const user = (auth ?? {}) as { id?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown }
  const link: TelegramLink = {
    id: typeof user.id === 'number' ? user.id : Number(user.id) || null,
    username: typeof user.username === 'string' ? user.username : null,
    name: [user.first_name, user.last_name].filter((part) => typeof part === 'string' && part).join(' ') || null,
    code,
  }
  try {
    localStorage.setItem(TELEGRAM_KEY, JSON.stringify(link))
  } catch {
    // Linked on the account only, if signed in.
  }
  emit()
  if (state.status === 'signedIn' && state.user) {
    const userId = state.user.id
    void getClient().then((client) => saveTelegramLink(client, userId))
  }
}

async function saveTelegramLink(client: SupabaseClient, userId: string) {
  const link = readTelegramLink()
  if (!link) return
  await client
    .from('profiles')
    .upsert(
      {
        user_id: userId,
        telegram_id: link.id,
        telegram_username: link.username,
        telegram_name: link.name,
        referral_code: link.code,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .then(
      () => undefined,
      () => undefined,
    )
}

// ---- The sign-in sheet. ----

export function openSignIn(): void {
  sheetOpen = true
  track('sheet')
  emit()
}

export function closeSignIn(): void {
  sheetOpen = false
  if (state.linkError) state = { ...state, linkError: null }
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useAccount = () => useSyncExternalStore(subscribe, () => state, () => state)
export const useSignInOpen = () => useSyncExternalStore(subscribe, () => sheetOpen, () => false)
export const useTelegramLink = () => useSyncExternalStore(subscribe, readTelegramLinkCached, () => null)

let telegramCache: { raw: string | null; link: TelegramLink | null } = { raw: null, link: null }
function readTelegramLinkCached(): TelegramLink | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(TELEGRAM_KEY)
  } catch {
    return null
  }
  if (raw !== telegramCache.raw) telegramCache = { raw, link: readTelegramLink() }
  return telegramCache.link
}

/** Test helpers. */
export function setAccountForTests(next: Partial<AccountState>) {
  set(next)
}
export function resetAccount() {
  started = false
  listening = false
  sheetOpen = false
  state = { status: 'disabled', user: null, linkError: null }
  emit()
}
