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
