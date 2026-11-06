import { beforeEach, describe, expect, it } from 'vitest'
import { clearLimited, isLimited, markLimited, nextReset, timeUntil } from './streamLimit'

const NOW = Date.parse('2026-11-06T20:30:00Z')

beforeEach(() => localStorage.clear())

describe('the daily streaming limit, on this device', () => {
  it('marks a server until the expected reset (midnight UTC), then forgets it', () => {
    expect(nextReset(NOW)).toBe(Date.parse('2026-11-07T00:00:00Z'))
    markLimited('embedmaster', NOW)
    expect(isLimited('embedmaster', NOW)).toBe(true)
    expect(isLimited('nextstream', NOW)).toBe(false)
    expect(isLimited('embedmaster', Date.parse('2026-11-07T00:00:01Z'))).toBe(false)
  })

  it('clears one server, or all of them', () => {
    markLimited('embedmaster', NOW)
    markLimited('nextstream', NOW)
    clearLimited('embedmaster', NOW)
    expect(isLimited('embedmaster', NOW)).toBe(false)
    expect(isLimited('nextstream', NOW)).toBe(true)
    clearLimited()
    expect(localStorage.getItem('naijatr.streamLimit')).toBeNull()
  })

  it('says roughly how long until the reset', () => {
    expect(timeUntil(nextReset(NOW), NOW)).toBe('4 hours')
    expect(timeUntil(NOW + 40 * 60_000, NOW)).toBe('40 minutes')
    expect(timeUntil(NOW + 61 * 60_000, NOW)).toBe('1 hour')
    expect(timeUntil(NOW + 10_000, NOW)).toBe('1 minute')
  })
})
