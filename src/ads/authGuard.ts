import { goToAuthPage, isNoAdScriptPath, pageFromPath, rememberSignupSource, type Page } from '../account/pages'

/**
 * Keeps every ad away from signing up, logging in and passwords.
 *
 * Why this way: the Monetag Multitag (quge5.com tag.min.js) adds its own
 * page-wide listeners (pop-unders on any tap) and shows In-Page Push banners
 * on its own timer. Once it is on a page nothing can pause or remove it, so
 * the app can't keep it quiet around a sign-in form on that page. Instead:
 *
 * 1. Auth lives on its own pages (/login, /signup, /auth/confirm, /auth/reset,
 *    /auth/set-password, and /account), always opened with a full page load:
 *    they start with no ad script in memory, and none is ever added there
 *    (directLink.ts adsDisabled, monetag.ts, vercel.json's CSP, and the
 *    shield below, which removes any third-party script or frame anyway).
 * 2. The tap on an auth button elsewhere (data-auth-page, with data-no-ad)
 *    never reaches an ad script: this guard listens on window in the capture
 *    phase, installed when the app starts, before any ad script exists, so it
 *    runs first. It stops the tap there and opens the auth page itself.
 * 3. The Multitag is added only after the first tap or key that isn't an auth
 *    button (whenInteracted), so nothing pops before then, and a visitor whose
 *    first tap is "Log in" leaves before any ad script loads.
 */

export const NO_AD_ATTR = 'data-no-ad'
/** The auth page an auth button opens: login, signup, account. */
export const AUTH_PAGE_ATTR = 'data-auth-page'
/** Where a "Sign up free" came from (the Play popup), for /admin/live. */
export const SIGNUP_SOURCE_ATTR = 'data-signup-source'

/** The attributes of an auth button: `<button {...authButton('login')}>`. */
export function authButton(page: 'login' | 'signup' | 'account' | 'auth/set-password', source?: string): Record<string, string> {
  return { [NO_AD_ATTR]: '', [AUTH_PAGE_ATTR]: page, ...(source ? { [SIGNUP_SOURCE_ATTR]: source } : {}) }
}

/** True when the tap landed on an auth button (or inside an element marked data-no-ad). */
export function isNoAdTap(event: Event | undefined | null): boolean {
  const target = event?.target as Element | null | undefined
  return Boolean(target && typeof target.closest === 'function' && target.closest(`[${NO_AD_ATTR}], [${AUTH_PAGE_ATTR}]`))
}

const TAP_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'auxclick', 'dblclick', 'contextmenu'] as const
const INTERACTION_EVENTS = new Set(['pointerdown', 'touchstart', 'mousedown', 'keydown', 'wheel'])

let interacted = false
const waiting = new Set<() => void>()

/** Runs `fn` after the visitor's first tap or key that isn't an auth button (now, if that already happened). */
export function whenInteracted(fn: () => void): () => void {
  if (interacted) {
    fn()
    return () => undefined
  }
  waiting.add(fn)
  return () => void waiting.delete(fn)
}

function interactedNow() {
  if (interacted) return
  interacted = true
  const due = [...waiting]
  waiting.clear()
  for (const fn of due) fn()
}

let installed = false

/** Call first thing when the app starts (main.tsx), before any ad script. */
export function installAuthGuard(): void {
  if (installed) return
  installed = true
  const onTap = (event: Event) => {
    const target = event.target as Element | null
    const auth = target?.closest?.(`[${AUTH_PAGE_ATTR}]`) as HTMLElement | null | undefined
    // On the auth pages (no ad script there) their own tabs and links work as usual.
    if (auth && !isNoAdScriptPath()) {
      // Nothing else on the page hears it: not React, not any ad script.
      event.stopImmediatePropagation()
      if (event.type === 'click') {
        event.preventDefault()
        const page = auth.getAttribute(AUTH_PAGE_ATTR) as Page
        const source = auth.getAttribute(SIGNUP_SOURCE_ATTR)
        if (source) rememberSignupSource(source)
        if (pageFromPath(`/${page}`)) goToAuthPage(page)
      }
      return
    }
    if (INTERACTION_EVENTS.has(event.type)) interactedNow()
  }
  for (const type of [...TAP_EVENTS, 'keydown', 'wheel']) window.addEventListener(type, onTap, { capture: true })
  if (isNoAdScriptPath()) shieldAuthPage()
}

/** Scripts and frames allowed on the auth pages: this site, Supabase, Vercel Analytics, Google Fonts. */
const ALLOWED_HOSTS = [/\.supabase\.co$/, /^va\.vercel-scripts\.com$/, /^fonts\.(googleapis|gstatic)\.com$/]

function isAllowed(src: string): boolean {
  if (!src) return true
  try {
    const url = new URL(src, window.location.href)
    if (url.origin === window.location.origin || url.protocol === 'blob:' || url.protocol === 'data:') return true
    return ALLOWED_HOSTS.some((host) => host.test(url.hostname))
  } catch {
    return false
  }
}

/** Monetag's own markup: its script tags carry data-zone; the in-page push and banners are third-party frames. */
function sweep(root: ParentNode) {
  root.querySelectorAll?.('script[data-zone], script[src], iframe, embed, object').forEach((node) => {
    const element = node as HTMLScriptElement | HTMLIFrameElement
    const src = element.getAttribute('src') ?? element.getAttribute('data') ?? ''
    if (element.hasAttribute('data-zone') || !isAllowed(src)) {
      element.remove()
      removed += 1
    }
  })
}

let removed = 0
/** How many ad scripts or frames the shield took off this page (tests, and the e2e check). */
export const shieldRemoved = () => removed

/**
 * On an auth page: removes any third-party script or frame that turns up
 * (none should: no ad script is ever added there, and the CSP blocks them).
 */
export function shieldAuthPage(): void {
  sweep(document)
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return
        const element = node as Element
        if (/^(SCRIPT|IFRAME|EMBED|OBJECT)$/.test(element.tagName)) {
          const src = element.getAttribute('src') ?? element.getAttribute('data') ?? ''
          if (element.hasAttribute('data-zone') || !isAllowed(src)) {
            element.remove()
            removed += 1
          }
        } else sweep(element)
      })
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
}

/** Test helper. */
export function resetAuthGuard({ interacted: next = false }: { interacted?: boolean } = {}): void {
  interacted = next
  waiting.clear()
  removed = 0
}
