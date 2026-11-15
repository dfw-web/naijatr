import { adoptAccountSubtitleChoice } from '../subtitles/subtitles'
import { useSyncExternalStore } from 'react'
import { pageview } from '@vercel/analytics'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { accountsEnabled } from '../config/account'
import { readTaste } from '../taste/profile'
import { readContinueWatching } from '../utils/continueWatching'
import { readWatchLater } from '../utils/watchLater'
import { supabaseBackend } from './backend'
import { getClient, hasStoredSession, takeAuthRedirect } from './client'
import { referralSignedIn, referralSignedOut } from '../referral/status'
import { forgetSyncedAccount, requestSyncNow, startSync, stopSync } from './sync'
import { holdAdsThisTap } from '../ads/adManager'
import { noteAuthActivity } from '../ads/authQuiet'

/**
 * The optional account: signed out (everything stays on this device, as
 * always), or signed in (synced: src/account/sync.ts). Never needed to browse
 * or watch. "disabled" while Supabase isn't configured: then nothing
 * account-related shows anywhere.
 *
 * - Create account: an email link (signInWithOtp) to /auth/confirm, where the
 *   new user is signed in and may set a password (or skip it for now).
 * - Log in: email + password (signInWithPassword).
 * - Forgot password: a reset link (resetPasswordForEmail) to /auth/reset.
 * Whether a password is set lives in the user's metadata (password_set).
 */

export type AccountStatus = 'disabled' | 'signedOut' | 'checking' | 'signedIn'

export interface AccountUser {
  id: string
  email: string
  /** Has a password (else signed in by email link only, on this device). */
  passwordSet: boolean
}

interface AccountState {
  status: AccountStatus
  user: AccountUser | null
  /** An email link that didn't work (expired, already used). */
  linkError: string | null
  /** Signed in by a password-reset link: /auth/reset asks for the new password. */
  recovery: boolean
}

export type SheetTab = 'login' | 'create'

let state: AccountState = { status: 'disabled', user: null, linkError: null, recovery: false }
let sheet: SheetTab | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const set = (next: Partial<AccountState>) => {
  state = { ...state, ...next }
  emit()
}

/** Shows in Vercel Analytics as a page view, e.g. /go/account?event=signed-in. */
const track = (event: string) => pageview({ route: '/go/account', path: `/go/account?event=${event}` })

const asUser = (user: User): AccountUser => ({
  id: user.id,
  email: user.email ?? '',
  passwordSet: user.user_metadata?.password_set === true,
})

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
    sheet = 'login'
  }
  if (redirect?.type === 'recovery') set({ recovery: true })
  void getClient()
    .then(async (client) => {
      listen(client)
      if (redirect?.accessToken && redirect.refreshToken) {
        const { error } = await client.auth.setSession({ access_token: redirect.accessToken, refresh_token: redirect.refreshToken })
        if (error) {
          set({ linkError: 'That link didn’t work. Please ask for a new one.' })
          sheet = 'login'
        } else {
          track(redirect.type === 'recovery' ? 'reset-link' : 'confirmed')
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
      if (event === 'PASSWORD_RECOVERY') set({ recovery: true })
      if (session?.user) signedIn(client, session.user)
      else if (event === 'SIGNED_OUT') signedOutHere()
    })
  })
}

function signedIn(client: SupabaseClient, user: User) {
  const next = asUser(user)
  if (state.status === 'signedIn' && state.user?.id === next.id) {
    if (state.user.email !== next.email || state.user.passwordSet !== next.passwordSet) set({ user: next })
    return
  }
  sheet = null
  set({ status: 'signedIn', user: next, linkError: null })
  // The subtitle language chosen on another device (kept in the account's user metadata).
  adoptAccountSubtitleChoice(user.user_metadata?.subtitle_lang)
  void startSync(next.id, supabaseBackend(client, next.id))
  // Ad-free status, and the invite link this device came by.
  referralSignedIn()
}

function signedOutHere() {
  stopSync()
  referralSignedOut()
  set({ status: 'signedOut', user: null })
}

// ---- Email links: one at a time, then 60 seconds' wait (Supabase limits how many it sends). ----

export const EMAIL_COOLDOWN_MS = 60_000
let cooldownUntil = 0

/** Seconds until another email may be sent (0: now). */
export const emailCooldownLeft = (now = Date.now()) => Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

const startCooldown = () => {
  cooldownUntil = Date.now() + EMAIL_COOLDOWN_MS
  emit()
}

const authUrl = (page: 'confirm' | 'reset') => `${window.location.origin}/auth/${page}`

const isRateLimit = (error: { status?: number; code?: string; message: string }) =>
  error.status === 429 || error.code === 'over_email_send_rate_limit' || /rate limit|security purposes|seconds/i.test(error.message)

export type EmailResult = { ok: true } | { ok: false; message: string }

/**
 * Create account (also "Resend confirmation", and finishing setup for an
 * account without a password): a link to /auth/confirm, where they're signed
 * in and can set a password.
 */
export async function sendConfirmLink(email: string): Promise<EmailResult> {
  const sent = await sendLink(email, true)
  return sent.ok ? { ok: true } : sent
}

/** The email link itself, with the 60-second wait. `existing`: Supabase said the address already has an account. */
async function sendLink(email: string, createUser: boolean): Promise<{ ok: true; existing: boolean } | { ok: false; message: string }> {
  if (emailCooldownLeft() > 0) return { ok: false, message: `Please wait ${emailCooldownLeft()} seconds before asking again.` }
  try {
    const client = await getClient()
    listen(client)
    const source = createUser ? signupSource() : null
    const { data, error } = await client.auth.signInWithOtp({
      email: email.trim(),
      // How a new account came (the Play popup), kept on the login for /admin/live. Ignored for existing accounts.
      options: { emailRedirectTo: authUrl('confirm'), shouldCreateUser: createUser, ...(source ? { data: { signup_source: source } } : {}) },
    })
    if (error) {
      if (isRateLimit(error)) {
        startCooldown()
        return { ok: false, message: 'Too many emails. Please wait a minute and try again.' }
      }
      return { ok: false, message: 'We couldn’t send the email. Check the address and try again.' }
    }
    startCooldown()
    const existing = isAlreadyRegistered((data as { user?: User | null } | null)?.user)
    track(existing ? 'signup-exists' : 'confirm-sent')
    return { ok: true, existing }
  } catch {
    return { ok: false, message: 'No connection. Please try again.' }
  }
}

/**
 * Supabase's answer for an address that already has an account, when email
 * confirmation is on: no error, a "user" with no identities and nothing sent.
 */
export const isAlreadyRegistered = (user: Pick<User, 'identities'> | null | undefined): boolean =>
  Boolean(user && Array.isArray(user.identities) && user.identities.length === 0)

export type EmailCheck = { status: 'new' | 'unknown' } | { status: 'confirmed' | 'unconfirmed'; email: string }

/**
 * Asks the server whether this inbox already has a login (Gmail dots and
 * +tags ignored: /api/account/email-status). "unknown" when the server can't
 * say (not configured, offline): sign-up then carries on as before.
 */
export async function checkEmail(email: string): Promise<EmailCheck> {
  try {
    const response = await fetch('/api/account/email-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() }),
    })
    if (!response.ok) return { status: 'unknown' }
    const body = (await response.json().catch(() => null)) as { status?: unknown; email?: unknown } | null
    if ((body?.status === 'confirmed' || body?.status === 'unconfirmed') && typeof body.email === 'string') {
      return { status: body.status, email: body.email }
    }
    return body?.status === 'new' ? { status: 'new' } : { status: 'unknown' }
  } catch {
    return { status: 'unknown' }
  }
}

export type CreateResult =
  | { ok: true }
  /** Already has an account: log in with `email` (the account's own address). */
  | { ok: false; reason: 'exists'; email: string }
  /** Registered, never confirmed: "Resend email" sends to `email`. */
  | { ok: false; reason: 'unconfirmed'; email: string }
  | { ok: false; reason: 'error'; message: string }

/**
 * "Create free account": checks the address first, and sends nothing (and
 * creates nothing) for one that already has an account. Only a new address
 * gets the link to /auth/confirm.
 */
export async function createAccount(email: string): Promise<CreateResult> {
  const check = await checkEmail(email)
  if (check.status === 'confirmed') {
    track('signup-exists')
    return { ok: false, reason: 'exists', email: check.email }
  }
  if (check.status === 'unconfirmed') {
    track('signup-unconfirmed')
    return { ok: false, reason: 'unconfirmed', email: check.email }
  }
  const sent = await sendLink(email, true)
  if (sent.ok && sent.existing) return { ok: false, reason: 'exists', email: email.trim() }
  return sent.ok ? { ok: true } : { ok: false, reason: 'error', message: sent.message }
}

/**
 * "Resend email" for an account that never confirmed its address: the link
 * goes to that account only (never creates one). 60 seconds between sends.
 */
export async function resendConfirmation(email: string): Promise<EmailResult> {
  const sent = await sendLink(email, false)
  return sent.ok ? { ok: true } : sent
}

export type LogInResult = { ok: true } | { ok: false; reason: 'wrong' | 'unconfirmed' | 'rate' | 'offline' | 'other' }

/** Log in with email and password. */
export async function logIn(email: string, password: string): Promise<LogInResult> {
  try {
    const client = await getClient()
    listen(client)
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password })
    if (error) {
      if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) return { ok: false, reason: 'unconfirmed' }
      if (error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message)) return { ok: false, reason: 'wrong' }
      if (isRateLimit(error)) return { ok: false, reason: 'rate' }
      return { ok: false, reason: 'other' }
    }
    if (data.user) signedIn(client, data.user)
    track('logged-in')
    return { ok: true }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

/**
 * Forgot password: a reset link to /auth/reset. Says the same whether or not
 * the email has an account (only a lost connection is reported).
 */
export async function sendPasswordReset(email: string): Promise<EmailResult> {
  if (emailCooldownLeft() > 0) return { ok: false, message: `Please wait ${emailCooldownLeft()} seconds before asking again.` }
  try {
    const client = await getClient()
    listen(client)
    await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: authUrl('reset') })
    startCooldown()
    track('reset-sent')
    return { ok: true }
  } catch {
    return { ok: false, message: 'No connection. Please try again.' }
  }
}

/** Sets (or changes) the signed-in user's password, and notes that one is set. */
export async function setPassword(password: string): Promise<EmailResult> {
  try {
    const client = await getClient()
    const { data, error } = await client.auth.updateUser({ password, data: { password_set: true } })
    if (error) {
      if (error.code === 'same_password') return { ok: false, message: 'That’s already your password. Choose a new one.' }
      if (error.code === 'weak_password') return { ok: false, message: 'That password is too weak. Try a longer one, with numbers or symbols.' }
      if (error.code === 'reauthentication_needed') return { ok: false, message: 'For your security, please log in again, then change your password.' }
      return { ok: false, message: 'We couldn’t save your password. Please try again.' }
    }
    if (data.user) set({ user: asUser(data.user), recovery: false })
    track('password-set')
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
  // No ad on the Log out tap, nor for 10 seconds after.
  holdAdsThisTap()
  noteAuthActivity()
  await requestSyncNow().catch(() => undefined)
  stopSync()
  try {
    const client = await getClient()
    await client.auth.signOut({ scope: 'local' })
  } catch {
    // Signed out here anyway.
  }
  referralSignedOut()
  set({ status: 'signedOut', user: null, recovery: false })
  track('signed-out')
}

/** Everything the account and this device hold, as a JSON file ("Download my data"). */
export async function downloadMyData(): Promise<void> {
  const client = await getClient()
  const { data: profile } = await client.from('profiles').select('invite_code,ad_free_until,created_at').maybeSingle()
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
 * Deletes the account: its synced rows, its referrals and the login itself
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
  referralSignedOut()
  set({ status: 'signedOut', user: null })
  track('deleted')
  return { loginDeleted }
}

// ---- The sign-in sheet. ----

const SOURCE_KEY = 'naijatr.signupSource'
/** "Sign up free" from a popup counts for it this long. */
const SOURCE_FOR_MS = 24 * 60 * 60 * 1000

/** Where the sheet was opened from, if a popup's "Sign up free" opened it lately. */
export function signupSource(now = Date.now()): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCE_KEY) ?? 'null') as { source?: unknown; at?: unknown } | null
    return typeof saved?.source === 'string' && typeof saved.at === 'number' && now - saved.at < SOURCE_FOR_MS ? saved.source : null
  } catch {
    return null
  }
}

/** Opens the sheet on "Create account" for a popup's "Sign up free", noting where it came from. */
export function openSignUpFrom(source: 'play-popup'): void {
  try {
    localStorage.setItem(SOURCE_KEY, JSON.stringify({ source, at: Date.now() }))
  } catch {
    // Not counted.
  }
  openSignIn('create')
}

/** Opens the sheet on "Create account", or "Log in" for someone who's had an account on this device. */
export function openSignIn(tab?: SheetTab): void {
  let known = false
  try {
    known = localStorage.getItem('naijatr.sync.user') !== null
  } catch {
    // New here, as far as we know.
  }
  sheet = tab ?? (known ? 'login' : 'create')
  // No ad on the tap that opens it, nor while it's open and 10 seconds after (src/ads/authQuiet.ts).
  holdAdsThisTap()
  noteAuthActivity()
  track('sheet')
  emit()
}

export function closeSignIn(): void {
  // The tap that closes it opens no ad either.
  holdAdsThisTap()
  noteAuthActivity()
  sheet = null
  if (state.linkError) state = { ...state, linkError: null }
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The account's status now (outside React). */
export const accountStatusNow = () => state.status
export const useAccount = () => useSyncExternalStore(subscribe, () => state, () => state)
/** The sheet's tab, or null while it's closed. */
export const useSignInSheet = () => useSyncExternalStore(subscribe, () => sheet, () => null)
/** When another email may be sent (the component ticks its own countdown). */
export const useEmailCooldownUntil = () => useSyncExternalStore(subscribe, () => cooldownUntil, () => 0)
/** Test helpers. */
export function setAccountForTests(next: Partial<AccountState>) {
  set(next)
}
export function resetAccount() {
  started = false
  listening = false
  sheet = null
  cooldownUntil = 0
  state = { status: 'disabled', user: null, linkError: null, recovery: false }
  emit()
}
