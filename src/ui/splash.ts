import { isLoading, subscribeLoading } from './loadingTracker'

/**
 * Runs the splash's exit (inline in index.html) once the app is ready: it has
 * drawn its first screen, nothing it asked for is still loading (the short
 * version doesn't wait for that), and its own styles are in. Not before the intro has played once (1.1 s; 0.45 s for the
 * short version on a reload in the same tab), and by 4 s at the latest, even
 * if something is slow. Index.html's CSS fades it out at 4 s on its own if the
 * app's code never runs.
 *
 * The exit: with the loader ring showing, the ring closes, flashes, becomes a
 * ▶ that's pressed, then the iris opens on the site (~1.1 s); before the ring
 * shows, just the iris (0.45 s). Reduced motion: a plain fade. Then the
 * splash is removed, and `onSplashGone` callbacks run (the welcome popup).
 */

/** The intro, played once before any exit. */
export const SPLASH_MIN_MS = 1100
export const SPLASH_QUICK_MIN_MS = 450
/** The exit starts by then, however slow the app is. */
export const SPLASH_MAX_MS = 4000
/** When the loader ring has come in (full and short versions). */
export const SPLASH_RING_MS = 1100
export const SPLASH_QUICK_RING_MS = 900
/** How long each exit takes. */
export const SPLASH_EXIT_FULL_MS = 1120
export const SPLASH_EXIT_QUICK_MS = 470
export const SPLASH_EXIT_REDUCED_MS = 320
/** The iris's hole, before it opens (index.html). */
const IRIS_PX = 60
/** Set once a splash has played in this tab: a reload plays the short version. */
export const SPLASH_PLAYED_KEY = 'naijatr.splashPlayed'

const GONE_EVENT = 'nt-splash-gone'

/** Runs `callback` once the splash has gone (at once if there's none), e.g. the welcome popup's countdown. */
export function onSplashGone(callback: () => void): void {
  if (typeof document === 'undefined' || !document.getElementById('nt-splash')) return callback()
  window.addEventListener(GONE_EVENT, () => callback(), { once: true })
}

/** The app's own stylesheets (index.html loads them without blocking the splash). */
function stylesReady(): boolean {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-app-css]')].every((link) => link.media !== 'print' && link.sheet !== null)
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function hideSplashWhenReady(root: HTMLElement, now: () => number = () => performance.now()): void {
  const splash = document.getElementById('nt-splash')
  if (!splash) return
  // Set by index.html's inline script as the splash went up.
  const shownAt = Number((window as { ntSplashAt?: unknown }).ntSplashAt) || 0
  const quick = splash.classList.contains('nt-splash--quick')
  let left = false
  const cleanups: (() => void)[] = []

  const finish = () => {
    splash.remove()
    try {
      sessionStorage.setItem(SPLASH_PLAYED_KEY, '1')
    } catch {
      // The full version again next time.
    }
    window.dispatchEvent(new Event(GONE_EVENT))
  }

  const leave = () => {
    if (left) return
    left = true
    cleanups.forEach((cleanup) => cleanup())
    // Already faded out by its own CSS (the app's code came late): just tidy up.
    if (getComputedStyle(splash).visibility === 'hidden') return finish()
    const reduced = reducedMotion()
    const ringShowing = now() - shownAt >= (quick ? SPLASH_QUICK_RING_MS : SPLASH_RING_MS)
    const full = ringShowing && !reduced
    // Big enough for the hole to clear every corner of the screen.
    splash.style.setProperty('--nt-iris-scale', String(Math.ceil(Math.hypot(window.innerWidth, window.innerHeight) / IRIS_PX) + 2))
    splash.classList.add('is-leaving', full ? 'is-leaving--full' : 'is-leaving--quick')
    window.setTimeout(finish, reduced ? SPLASH_EXIT_REDUCED_MS : full ? SPLASH_EXIT_FULL_MS : SPLASH_EXIT_QUICK_MS)
  }
  const leaveSoon = () => window.setTimeout(leave, Math.max(0, shownAt + (quick ? SPLASH_QUICK_MIN_MS : SPLASH_MIN_MS) - now()))
  const check = () => {
    // The short version (a reload: the app's code is cached) doesn't wait for the titles: its skeleton cards show.
    if (!left && root.childElementCount > 0 && (quick || !isLoading()) && stylesReady()) leaveSoon()
  }
  // Two frames after a change: what the app asks for on its first render has started by then.
  const checkSoon = () => requestAnimationFrame(() => requestAnimationFrame(check))

  const cap = window.setTimeout(leave, Math.max(0, shownAt + SPLASH_MAX_MS - now()))
  cleanups.push(() => window.clearTimeout(cap))
  const observer = new MutationObserver(checkSoon)
  observer.observe(root, { childList: true })
  cleanups.push(() => observer.disconnect())
  cleanups.push(subscribeLoading(checkSoon))
  const onStyles = () => checkSoon()
  document.addEventListener('load', onStyles, true)
  cleanups.push(() => document.removeEventListener('load', onStyles, true))
  checkSoon()
}
