import { isLoading, subscribeLoading } from './loadingTracker'

/**
 * Hides the splash (inline in index.html) once the app is ready: it has drawn
 * its first screen, nothing it asked for is still loading, and its own styles
 * are in. At least 600 ms after the page started (so the animation is seen),
 * and gone by 4 s: it starts leaving at 3.65 s (index.html's CSS does the same,
 * even without this code).
 * The logo zooms forward and the splash fades (350 ms), then it's removed.
 */

export const SPLASH_MIN_MS = 600
export const SPLASH_FADE_MS = 350
/** Starts leaving by then, so it's gone by 4 s. */
export const SPLASH_MAX_MS = 4000 - SPLASH_FADE_MS

/** The app's own stylesheets (index.html loads them without blocking the splash). */
function stylesReady(): boolean {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-app-css]')].every((link) => link.media !== 'print' && link.sheet !== null)
}

export function hideSplashWhenReady(root: HTMLElement, now: () => number = () => performance.now()): void {
  const splash = document.getElementById('nt-splash')
  if (!splash) return
  let left = false
  const cleanups: (() => void)[] = []

  const leave = () => {
    if (left) return
    left = true
    cleanups.forEach((cleanup) => cleanup())
    splash.classList.add('is-leaving')
    window.setTimeout(() => splash.remove(), SPLASH_FADE_MS)
  }
  const leaveSoon = () => {
    if (left) return
    window.setTimeout(leave, Math.max(0, SPLASH_MIN_MS - now()))
  }
  const check = () => {
    if (!left && root.childElementCount > 0 && !isLoading() && stylesReady()) leaveSoon()
  }
  // Two frames after a change: what the app asks for on its first render has started by then.
  const checkSoon = () => requestAnimationFrame(() => requestAnimationFrame(check))

  const timer = window.setTimeout(leave, Math.max(0, SPLASH_MAX_MS - now()))
  cleanups.push(() => window.clearTimeout(timer))
  const observer = new MutationObserver(checkSoon)
  observer.observe(root, { childList: true })
  cleanups.push(() => observer.disconnect())
  cleanups.push(subscribeLoading(checkSoon))
  const onStyles = () => checkSoon()
  document.addEventListener('load', onStyles, true)
  cleanups.push(() => document.removeEventListener('load', onStyles, true))
  checkSoon()
}
