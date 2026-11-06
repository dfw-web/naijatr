import { beforeEach, describe, expect, it } from 'vitest'
import { clearLimited, isLimited, markLimited, nextReset } from './streamLimit'

const NOW = Date.parse('2026-11-06T20:30:00Z')

beforeEach(() => localStorage.clear())

describe("this network's daily streaming limit, on this device", () => {
  it('is remembered until the expected reset (midnight UTC), then forgotten', () => {
    expect(nextReset(NOW)).toBe(Date.parse('2026-11-07T00:00:00Z'))
    expect(isLimited(NOW)).toBe(false)
    markLimited(NOW)
    expect(isLimited(NOW)).toBe(true)
    expect(isLimited(Date.parse('2026-11-07T00:00:01Z'))).toBe(false)
  })

  it('is cleared by Try again, or a player that plays', () => {
    markLimited(NOW)
    clearLimited()
    expect(isLimited(NOW)).toBe(false)
    expect(localStorage.getItem('naijatr.streamLimit')).toBeNull()
  })
})
