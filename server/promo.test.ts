import { describe, expect, it } from 'vitest'
import { promoActive, promoInfo, promoState, readPromo } from './promo'

const ENV = { PROMO_START: '2026-11-11T00:00:00+01:00', PROMO_END: '2026-11-17T23:59:59+01:00' }

describe('the Free Ad-Free Week window', () => {
  it('reads PROMO_START and PROMO_END with their offset (Lagos, UTC+1)', () => {
    expect(readPromo(ENV)).toEqual({ start: Date.parse('2026-11-10T23:00:00Z'), end: Date.parse('2026-11-17T22:59:59Z') })
    expect(readPromo({ PROMO_START: ` ${ENV.PROMO_START} `, PROMO_END: ENV.PROMO_END })).not.toBeNull()
  })

  it('is off without both times, with a bad one, or with the end before the start', () => {
    expect(readPromo({})).toBeNull()
    expect(readPromo({ PROMO_START: ENV.PROMO_START })).toBeNull()
    expect(readPromo({ ...ENV, PROMO_END: 'next week' })).toBeNull()
    expect(readPromo({ PROMO_START: ENV.PROMO_END, PROMO_END: ENV.PROMO_START })).toBeNull()
  })

  it('switches on at exactly 12:00 AM on 11 Nov (Lagos) and off after 11:59:59 PM on 17 Nov', () => {
    const promo = readPromo(ENV)!
    expect(promoState(promo, Date.parse('2026-11-10T23:59:59.999+01:00'))).toBe('upcoming')
    expect(promoState(promo, Date.parse('2026-11-11T00:00:00+01:00'))).toBe('active')
    expect(promoState(promo, Date.parse('2026-11-14T12:00:00+01:00'))).toBe('active')
    expect(promoState(promo, Date.parse('2026-11-17T23:59:59+01:00'))).toBe('active')
    expect(promoState(promo, Date.parse('2026-11-18T00:00:00+01:00'))).toBe('ended')
    expect(promoActive(null, Date.parse('2026-11-14T12:00:00Z'))).toBe(false)
    expect(promoInfo(promo, Date.parse('2026-11-12T00:00:00Z'))).toEqual({
      start: '2026-11-10T23:00:00.000Z',
      end: '2026-11-17T22:59:59.000Z',
      state: 'active',
    })
  })
})
