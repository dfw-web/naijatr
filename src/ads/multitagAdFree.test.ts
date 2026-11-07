import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The account's ad-free answer, set by each test.
const adFree = vi.hoisted(() => ({ now: false }))
vi.mock('../referral/status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../referral/status')>()),
  adFreeReady: () => Promise.resolve(),
  isAdFreeNow: () => adFree.now,
  subscribeReferralStatus: () => () => undefined,
}))

// The setup file loaded the real status module; a fresh graph picks up the mock.
vi.resetModules()
const { MULTITAG } = await import('../config/ads')
const { AD_FREE_RELOAD_RETRY_MS, dropMultitagIfAdFree, loadMultitag } = await import('./monetag')

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  window.sessionStorage.clear()
  adFree.now = false
})

afterEach(() => {
  vi.useRealTimers()
  document.querySelectorAll('script[data-zone], .player__frame').forEach((node) => node.remove())
})

describe('an account that turns out ad-free after the Multitag loaded', () => {
  it('reloads the page once, so the Multitag is gone', () => {
    expect(loadMultitag()).toBe(true)
    const reload = vi.fn()
    adFree.now = true
    expect(dropMultitagIfAdFree(reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    // The fresh page knows: no Multitag, and no second reload.
    document.getElementById(MULTITAG.id)!.remove()
    expect(loadMultitag()).toBe(false)
    expect(dropMultitagIfAdFree(reload)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('waits for an open player to close first', () => {
    vi.useFakeTimers()
    loadMultitag()
    const frame = document.createElement('div')
    frame.className = 'player__frame'
    document.body.append(frame)
    const reload = vi.fn()
    adFree.now = true
    expect(dropMultitagIfAdFree(reload)).toBe(false)
    vi.advanceTimersByTime(AD_FREE_RELOAD_RETRY_MS)
    expect(reload).not.toHaveBeenCalled()
    frame.remove()
    vi.advanceTimersByTime(AD_FREE_RELOAD_RETRY_MS)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never reloads a free account, or a page without the Multitag', () => {
    const reload = vi.fn()
    adFree.now = true
    expect(dropMultitagIfAdFree(reload)).toBe(false)
    adFree.now = false
    loadMultitag()
    expect(dropMultitagIfAdFree(reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads at most once in 10 minutes in a tab', () => {
    loadMultitag()
    const reload = vi.fn()
    adFree.now = true
    dropMultitagIfAdFree(reload)
    dropMultitagIfAdFree(reload)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
