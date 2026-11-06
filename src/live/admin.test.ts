import { describe, expect, it } from 'vitest'
import { keyWarning } from './admin'

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
