import { useEffect } from 'react'

/**
 * "Auth in progress": no ad of any kind (direct link, Multitag pop-under,
 * vignette, ad break) while someone signs up, logs in, resets or sets a
 * password, or logs out, and for AUTH_QUIET_MS after, so the tap that closes
 * the sign-in sheet (or the one right after) never opens an ad either.
 *
 * - The sign-in sheet registers itself while open (useAuthInProgress).
 * - Every auth button carries data-no-ad: a tap on it opens no ad, never
 *   reaches the page-wide ad listeners, and starts the quiet time.
 * - The pages the account emails open (/auth/confirm, /auth/reset) and the
 *   invite pages (/invite/*) never show ads at all (see directLink.ts).
 *
 * Read by adManager.ts (every direct-link trigger and the quiet zones),
 * directLink.ts (openAd) and monetag.ts (the Multitag waits to load).
 */

export const AUTH_QUIET_MS = 10_000
/** Marks an auth button (Sign in, Log in, Create account, Log out, Sign up free…). */
export const NO_AD_ATTR = 'data-no-ad'
/** The sign-in sheet, password forms, account pages: taps inside never reach page-wide ad listeners. */
export const QUIET_ADS_ATTR = 'data-quiet-ads'
const NO_AD_SELECTOR = `[${NO_AD_ATTR}], [${QUIET_ADS_ATTR}]`

/** The clock the quiet time reads; tests move it forward. */
export const authClock = { now: () => Date.now() }

let openCount = 0
let quietUntil = 0

/** Starts (or extends) the quiet time: no ads for AUTH_QUIET_MS from now. */
export function noteAuthActivity(): void {
  quietUntil = Math.max(quietUntil, authClock.now() + AUTH_QUIET_MS)
}

/** True while auth UI is open, or within AUTH_QUIET_MS of the last auth tap or its closing. */
export function isAuthInProgress(now = authClock.now()): boolean {
  return openCount > 0 || now < quietUntil
}

/** Milliseconds until the quiet time ends (0: ads may run; Infinity while auth UI is open). */
export function authQuietLeft(now = authClock.now()): number {
  if (openCount > 0) return Infinity
  return Math.max(0, quietUntil - now)
}

/** True when the tap landed on an auth button or inside an auth form or sheet. */
export function isNoAdTap(event: Event | undefined | null): boolean {
  const target = event?.target as Element | null | undefined
  return Boolean(target && typeof target.closest === 'function' && target.closest(NO_AD_SELECTOR))
}

/** Registers auth UI (the sign-in sheet) while `open`: auth is in progress, then AUTH_QUIET_MS more after it closes. */
export function useAuthInProgress(open = true): void {
  useEffect(() => {
    if (!open) return
    openCount += 1
    noteAuthActivity()
    return () => {
      openCount -= 1
      noteAuthActivity()
    }
  }, [open])
}

/** Test helper. */
export function resetAuthQuiet(): void {
  openCount = 0
  quietUntil = 0
}
