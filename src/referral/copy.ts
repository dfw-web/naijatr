import { lagosDay } from '../ads/adManager'

/** The referral program's wording and the daily popup's once-a-day rule (src/referral/Invite.tsx). */

export const shareMessage = (link: string) => `Join me on NAIJA TR 🍿⚽ Movies, series & live football. Sign up with my link 👉 ${link}`

/** "3/5 friends joined. 2 more to unlock ad-free!" (progress towards the next unlock). */
export function progressText(counted: number, goal: number): string {
  const towards = counted % goal
  return `${towards}/${goal} friends joined. ${goal - towards} more to unlock ad-free!`
}

export const PROMO_DAY_KEY = 'naijatr.promo.day'
/** How long a page is open before the popup may show, and how often it then looks for a free moment. */
export const promoTiming = { delayMs: 15_000, pollMs: 2000 }

/** The daily popup already showed today (Lagos day) on this device. */
export function promoShownToday(now = Date.now()): boolean {
  try {
    return localStorage.getItem(PROMO_DAY_KEY) === lagosDay(now)
  } catch {
    return true
  }
}

export function markPromoShown(now = Date.now()): void {
  try {
    localStorage.setItem(PROMO_DAY_KEY, lagosDay(now))
  } catch {
    // Storage blocked: promoShownToday() already says yes.
  }
}

/** "Ad-free until 16 November 2026" (Lagos date). */
export const lagosDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' })

/** Ad-free ending within this: the renew reminder shows. */
export const RENEW_REMINDER_MS = 3 * 24 * 60 * 60 * 1000
export const RENEW_DAY_KEY = 'naijatr.adFree.renewDay'

/** The renew reminder was closed today (Lagos day) on this device. */
export function renewDismissedToday(now = Date.now()): boolean {
  try {
    return localStorage.getItem(RENEW_DAY_KEY) === lagosDay(now)
  } catch {
    return false
  }
}

export function dismissRenewToday(now = Date.now()): void {
  try {
    localStorage.setItem(RENEW_DAY_KEY, lagosDay(now))
  } catch {
    // Shown again on the next page.
  }
}

// /invite opens on "Buy ad-free" when asked to (the "Ads are back" card, the account page).
let buyRequested = false
export const requestBuyOption = () => void (buyRequested = true)
export function takeBuyRequest(): boolean {
  const asked = buyRequested
  buyRequested = false
  return asked
}
