/**
 * The account's own pages, at their own paths (Vercel serves index.html for
 * them). auth/confirm and auth/reset are where the email links land.
 */
export type Page = 'my-list' | 'account' | 'privacy' | 'auth/confirm' | 'auth/reset'

const PAGES: Page[] = ['my-list', 'account', 'privacy', 'auth/confirm', 'auth/reset']

export const pageFromPath = (pathname: string): Page | null => {
  const name = pathname.replace(/^\/+|\/+$/g, '')
  return (PAGES as string[]).includes(name) ? (name as Page) : null
}

/** Opens a page in the app (no reload); App follows the address on popstate. */
export function goToPage(page: Page): void {
  window.history.pushState(null, '', `/${page}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo({ top: 0 })
}

/** Back to the home page, in the app. */
export function goHome(): void {
  window.history.pushState(null, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo({ top: 0 })
}
