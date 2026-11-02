/**
 * Buying ad-free: the plans, their prices and where to pay. Payment is done
 * by chatting on Telegram; the admin then grants the days at /admin/ad-free.
 * Change prices, durations or the Telegram account here (one place for the
 * "Buy ad-free" option, the "Ads are back" card and the admin page).
 */

/** The Telegram account buyers chat with. */
export const BUY_TELEGRAM_USERNAME = 'Dfw_Brun0'
export const BUY_TELEGRAM_URL = `https://t.me/${BUY_TELEGRAM_USERNAME}`

export interface AdFreePlan {
  id: string
  /** "1 Month" */
  label: string
  /** Days added to the account's ad-free time. */
  days: number
  /** Price in naira. */
  price: number
  /** Shown after the price, e.g. "🔥 (save ₦1,000)". */
  extra?: string
}

export const AD_FREE_PLANS: AdFreePlan[] = [
  { id: '1m', label: '1 Month', days: 30, price: 2000 },
  { id: '3m', label: '3 Months', days: 90, price: 5000, extra: '🔥 (save ₦1,000)' },
]

/** "₦2,000" */
export const naira = (amount: number) => `₦${amount.toLocaleString('en-NG')}`

/** The cheapest plan's price, for "buy ad-free from ₦2,000". */
export const FROM_PRICE = Math.min(...AD_FREE_PLANS.map((plan) => plan.price))

/** The chat link, with the message filled in where Telegram supports it. */
export function buyLink(plan: AdFreePlan, email?: string | null): string {
  const text = email ? `Hi, I want NAIJA TR ad-free (${plan.label}). My account email is ${email}` : `Hi, I want NAIJA TR ad-free (${plan.label}).`
  return `${BUY_TELEGRAM_URL}?text=${encodeURIComponent(text)}`
}
