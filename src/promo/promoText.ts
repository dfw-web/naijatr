/** The Free Ad-Free Week's wording and timing (src/promo/PromoWeek.tsx). */

/** How long a page is open before a popup may show, and how often it then looks for a free moment. */
export const promoWeekTiming = { delayMs: 3000, pollMs: 2000 }

/** "Tuesday, 17 Nov at 11:59 PM", Lagos time. */
export function promoEndText(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(iso))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('weekday')}, ${part('day')} ${part('month')} at ${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`
}

/** "6d 23h 59m 12s" (seconds only when asked), never below zero. */
export function countdownText(ms: number, seconds = true): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const text = [d > 0 ? `${d}d` : '', d > 0 || h > 0 ? `${h}h` : '', `${m}m`].filter(Boolean).join(' ')
  return seconds ? `${text} ${s}s` : text
}
