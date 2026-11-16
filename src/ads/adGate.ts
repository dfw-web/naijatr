/**
 * One switch in front of every ad: the Multitags (monetag.ts), the direct-link
 * ad (adManager.ts) and the TV ad slots (tv/AdSlot.tsx). Open unless something
 * holds it: the welcome popup for signed-out visitors (src/promo/welcomeStore.ts)
 * holds it from the page load until 3 seconds after the popup has closed.
 *
 * Why a gate and not a flag: the ad networks' scripts add their own page-wide
 * tap listeners the moment they load, and can't be paused. So while the gate
 * is held, no ad script is ever added to the page at all.
 *
 * No imports: everything ad-related can depend on it.
 */

let held = false
let timer: number | undefined
const waiting = new Set<() => void>()

/** True when ads may load and open now. */
export const adsAllowedNow = (): boolean => !held

/** Holds every ad until releaseAds. */
export function holdAds(): void {
  window.clearTimeout(timer)
  held = true
}

/** Lets ads load again, now or after `delayMs`. */
export function releaseAds(delayMs = 0): void {
  window.clearTimeout(timer)
  const open = () => {
    held = false
    const due = [...waiting]
    waiting.clear()
    for (const fn of due) fn()
  }
  if (delayMs > 0) timer = window.setTimeout(open, delayMs)
  else open()
}

/** Runs `fn` once ads are allowed (now, if they are). Returns a cancel. */
export function whenAdsAllowed(fn: () => void): () => void {
  if (!held) {
    fn()
    return () => undefined
  }
  waiting.add(fn)
  return () => void waiting.delete(fn)
}

/** Test helper. */
export function resetAdGate(): void {
  window.clearTimeout(timer)
  held = false
  waiting.clear()
}
