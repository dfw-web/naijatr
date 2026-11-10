/**
 * The "Free Ad-Free Week": a window (PROMO_START, PROMO_END, ISO times with
 * their offset, e.g. 2026-11-11T00:00:00+01:00) in which every signed-in
 * account is ad-free and plays on Server 2. Nobody's ad_free_until changes:
 * it's a rule checked here, on the server's clock, on every status request.
 * Without both (or with an end before the start) there's no promo.
 */

export interface PromoWindow {
  /** First moment of the promo (ms). */
  start: number
  /** Last moment of the promo (ms), included. */
  end: number
}

export type PromoState = 'upcoming' | 'active' | 'ended'

/** What the status answer (and /admin/live) says about the promo. */
export interface PromoInfo {
  start: string
  end: string
  state: PromoState
}

export function readPromo(env: Record<string, string | undefined>): PromoWindow | null {
  const start = Date.parse(env.PROMO_START?.trim() ?? '')
  const end = Date.parse(env.PROMO_END?.trim() ?? '')
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null
}

export function promoState(promo: PromoWindow, now: number): PromoState {
  if (now < promo.start) return 'upcoming'
  return now <= promo.end ? 'active' : 'ended'
}

export const promoActive = (promo: PromoWindow | null, now: number) => promo !== null && promoState(promo, now) === 'active'

export const promoInfo = (promo: PromoWindow | null, now: number): PromoInfo | null =>
  promo ? { start: new Date(promo.start).toISOString(), end: new Date(promo.end).toISOString(), state: promoState(promo, now) } : null

/** "Wednesday, 11 Nov at 12:00 AM", Lagos time. */
export function lagosWhen(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('weekday')}, ${part('day')} ${part('month')} at ${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The email to every account about the week ("from … until …", or "from now until …" once it's on). */
export function promoEmail(promo: PromoWindow, siteUrl: string, now: number): { subject: string; text: string; html: string } {
  const from = now < promo.start ? `from ${lagosWhen(promo.start)}` : 'from now'
  const site = siteUrl.replace(/^https:\/\//, '')
  const lines = [
    'Hi! 🎉',
    `It's the FREE AD-FREE WEEK on NAIJA TR: ${from} until ${lagosWhen(promo.end)} (Lagos time), you can watch with NO ADS.`,
    `Just sign in at ${site} with this email, on any device: movies, series, anime, K-drama and live football, with no ads and no pop-ups. 🍿⚽`,
    '⏳ This offer is for one week only.',
    'NAIJA TR',
  ]
  const footer = "You're getting this because you have a NAIJA TR account."
  return {
    subject: '🎉 FREE AD-FREE WEEK on NAIJA TR!',
    text: `${lines.join('\n\n')}\n\n${footer}`,
    html: `${lines.map((line) => `<p>${escapeHtml(line).replace(escapeHtml(site), `<a href="${siteUrl}">${escapeHtml(site)}</a>`)}</p>`).join('')}<p style="color:#888;font-size:12px">${escapeHtml(footer)}</p>`,
  }
}

