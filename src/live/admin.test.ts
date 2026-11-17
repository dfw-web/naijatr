import { describe, expect, it } from 'vitest'
import { keyWarning, problemBreakdown } from './admin'

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-11-26T12:00:00Z')
const issued = (expiresAt: number | null) => ({ issued: '2026-10-28', expiresAt, okAt: null, rejectedAt: null })

describe('the CodeSpecter key warning on /admin/live', () => {
  it('warns 5 days before the 30 days are up, and once they are', () => {
    expect(keyWarning(issued(NOW + 10 * DAY), NOW)).toBeNull()
    expect(keyWarning(issued(NOW + 4.5 * DAY), NOW)).toMatch(/expires in 5 days/)
    expect(keyWarning(issued(NOW + 0.5 * DAY), NOW)).toMatch(/expires in 1 day \(/)
    expect(keyWarning(issued(NOW - DAY), NOW)).toMatch(/passed its 30 days/)
  })

  it('says at once when CodeSpecter refused the key since it last took it', () => {
    expect(keyWarning({ ...issued(null), okAt: 1, rejectedAt: 2 }, NOW)).toMatch(/refused our API key/)
    expect(keyWarning({ ...issued(null), okAt: 3, rejectedAt: 2 }, NOW)).toBeNull()
    expect(keyWarning(issued(null), NOW)).toBeNull()
  })
})

describe('player problems on /admin/live', () => {
  it('sums each kind by server, then device, then in-player source, most first', () => {
    const breakdown = {
      'slow:server:nextstream': 4,
      'slow:server:embedmaster': 1,
      'slow:device:iphone': 3,
      'slow:device:desktop': 2,
      'slow:source:MovieJoy': 2,
      'stall:server:embedmaster': 2,
      'stall:device:tv': 2,
    }
    expect(problemBreakdown(breakdown, 'slow')).toBe('Server 1 4 · Server 2 1 · iPhone 3 · Desktop 2 · MovieJoy 2')
    expect(problemBreakdown(breakdown, 'stall')).toBe('Server 2 2 · TV 2')
    expect(problemBreakdown({}, 'stall')).toBe('')
  })
})
