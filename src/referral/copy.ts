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
