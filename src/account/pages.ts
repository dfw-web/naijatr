/**
 * The account's own pages, at their own paths (Vercel serves index.html for
 * them). auth/confirm and auth/reset are where the email links land; invite
 * and invite/rules are the referral program's (src/referral/Invite.tsx).
 *
 * The auth pages (/login, /signup, /auth/confirm, /auth/reset,
 * /auth/set-password) and /account are always opened with a full page load,
 * so they start with no ad script in memory, and none is ever added there
 * (src/ads/authGuard.ts, src/ads/directLink.ts, vercel.json's CSP).
 */
export type Page =
  | 'my-list'
  | 'account'
  | 'privacy'
  | 'login'
  | 'signup'
  | 'auth/confirm'
  | 'auth/reset'
  | 'auth/set-password'
  | 'invite'
  | 'invite/rules'

const PAGES: Page[] = ['my-list', 'account', 'privacy', 'login', 'signup', 'auth/confirm', 'auth/reset', 'auth/set-password', 'invite', 'invite/rules']

/** The auth pages: never an ad script, opened only by a full page load. */
export const AUTH_PAGES: Page[] = ['login', 'signup', 'auth/confirm', 'auth/reset', 'auth/set-password']
/** Those, and /account (Sign out, delete account): opened only by a full page load, never an ad script. */
export const NO_AD_SCRIPT_PAGES: Page[] = [...AUTH_PAGES, 'account']

export const pageFromPath = (pathname: string): Page | null => {
  const name = pathname.replace(/^\/+|\/+$/g, '')
  return (PAGES as string[]).includes(name) ? (name as Page) : null
}

/** True on /login, /signup and /auth/*. */
export const isAuthPath = (pathname = window.location.pathname): boolean => {
  const page = pageFromPath(pathname)
  return page !== null && AUTH_PAGES.includes(page)
}

/** True on the auth pages and /account: no ad script may ever load there. */
export const isNoAdScriptPath = (pathname = window.location.pathname): boolean => {
  const page = pageFromPath(pathname)
  return page !== null && NO_AD_SCRIPT_PAGES.includes(page)
}

/** Full page loads; tests replace it (jsdom can't navigate). */
export const pageLoad = { assign: (url: string) => window.location.assign(url) }

const NEXT_KEY = 'naijatr.auth.next'
/** "Sign up free" from a popup: where it came from (read by account.ts signupSource). */
export const SIGNUP_SOURCE_KEY = 'naijatr.signupSource'

export function rememberSignupSource(source: string): void {
  try {
    localStorage.setItem(SIGNUP_SOURCE_KEY, JSON.stringify({ source, at: Date.now() }))
  } catch {
    // Not counted.
  }
}

/** A same-site path to come back to (never another site, never an auth page). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  try {
    const url = new URL(next, 'https://x.invalid')
    if (url.origin !== 'https://x.invalid' || isAuthPath(url.pathname)) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

/** Where this page should send people back to: ?next=, else the one saved when they left for an auth page. */
export function nextPage(href = window.location.href): string {
  const fromUrl = new URL(href).searchParams.get('next')
  if (fromUrl) return safeNext(fromUrl)
  try {
    return safeNext(localStorage.getItem(NEXT_KEY))
  } catch {
    return '/'
  }
}

/** The page someone is on now, as ?next= for an auth page. */
const currentPage = () => (isAuthPath() ? nextPage() : safeNext(window.location.pathname + window.location.search + window.location.hash))

/** The address of an auth page, coming back to the current page. */
export function authPageUrl(page: Page, next = currentPage()): string {
  return next === '/' ? `/${page}` : `/${page}?next=${encodeURIComponent(next)}`
}

/**
 * Opens an auth page with a full page load (never client-side routing), so it
 * starts with no ad script in memory. The way back is kept for the email link
 * (/auth/confirm) too.
 */
export function goToAuthPage(page: Page, next = currentPage()): void {
  if (page === 'account') return pageLoad.assign('/account')
  try {
    localStorage.setItem(NEXT_KEY, next)
  } catch {
    // ?next= still has it.
  }
  pageLoad.assign(authPageUrl(page, next))
}

/** Signed in, or password set: back where they came from, with a full page load (ads may load there again). */
export function goBackFromAuth(): void {
  const next = nextPage()
  try {
    localStorage.removeItem(NEXT_KEY)
  } catch {
    // Fine.
  }
  pageLoad.assign(next)
}

/** Opens a page in the app (no reload); App follows the address on popstate. Auth pages and /account: a full page load. */
export function goToPage(page: Page): void {
  if (NO_AD_SCRIPT_PAGES.includes(page)) return goToAuthPage(page)
  window.history.pushState(null, '', `/${page}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo({ top: 0 })
}

/** Between /login and /signup (already an auth page, no ads): no reload, ?next= kept. */
export function switchAuthPage(page: 'login' | 'signup'): void {
  window.history.pushState(null, '', `/${page}${window.location.search}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Back to the home page, in the app (from an auth page or /account: a full page load, so ads may load again). */
export function goHome(): void {
  if (isNoAdScriptPath()) return pageLoad.assign('/')
  window.history.pushState(null, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo({ top: 0 })
}
