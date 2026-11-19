import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginLoading, isLoading, resetLoading, trackLoading } from '../ui/loadingTracker'
import {
  hideSplashWhenReady,
  onSplashGone,
  SPLASH_EXIT_FULL_MS,
  SPLASH_EXIT_QUICK_MS,
  SPLASH_MAX_MS,
  SPLASH_MIN_MS,
  SPLASH_PLAYED_KEY,
  SPLASH_QUICK_MIN_MS,
} from '../ui/splash'
import { NavProgress, PROGRESS_DONE_MS, PROGRESS_SHOW_AFTER_MS, PROGRESS_SLOW_AFTER_MS } from './NavProgress'

beforeEach(() => {
  vi.useFakeTimers()
  resetLoading()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const bar = () => screen.queryByTestId('nav-progress')
const logo = () => screen.queryByTestId('nav-progress-logo')
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

describe('the loading bar at the top', () => {
  it('shows nothing for a quick load (no flicker)', () => {
    render(<NavProgress />)
    let done = () => {}
    act(() => void (done = beginLoading()))
    wait(PROGRESS_SHOW_AFTER_MS - 50)
    act(() => done())
    wait(1000)
    expect(bar()).toBeNull()
    expect(logo()).toBeNull()
  })

  it('shows the bar while loading, the bouncing logo after 300 ms, then fills and goes', () => {
    render(<NavProgress />)
    let done = () => {}
    act(() => void (done = beginLoading()))
    wait(PROGRESS_SHOW_AFTER_MS)
    expect(bar()).toHaveClass('nav-progress--loading')
    expect(bar()).toHaveAttribute('aria-hidden', 'true')
    expect(logo()).toBeNull()
    wait(PROGRESS_SLOW_AFTER_MS - PROGRESS_SHOW_AFTER_MS)
    expect(logo()).not.toBeNull()
    act(() => done())
    expect(bar()).toHaveClass('nav-progress--done')
    expect(logo()).toBeNull()
    wait(PROGRESS_DONE_MS)
    expect(bar()).toBeNull()
  })

  it('waits for everything loading at once', async () => {
    render(<NavProgress />)
    let first = () => {}
    let finish: (value: unknown) => void = () => {}
    act(() => {
      first = beginLoading()
      void trackLoading(new Promise((resolve) => (finish = resolve)))
    })
    wait(PROGRESS_SHOW_AFTER_MS)
    act(() => {
      first()
      first()
    })
    expect(isLoading()).toBe(true)
    expect(bar()).toHaveClass('nav-progress--loading')
    await act(async () => finish(null))
    expect(isLoading()).toBe(false)
    expect(bar()).toHaveClass('nav-progress--done')
  })
})

describe('the splash', () => {
  const setup = ({ shownAt = 0, quick = false } = {}) => {
    const splash = document.createElement('div')
    splash.id = 'nt-splash'
    if (quick) splash.classList.add('nt-splash--quick')
    const root = document.createElement('div')
    document.body.append(splash, root)
    let clock = shownAt
    ;(window as { ntSplashAt?: number }).ntSplashAt = shownAt
    const gone = vi.fn()
    hideSplashWhenReady(root, () => clock)
    onSplashGone(gone)
    const tick = (ms: number) => {
      clock += ms
      wait(ms)
    }
    const draw = async () => {
      root.append(document.createElement('main'))
      await act(async () => {})
      tick(40)
    }
    return { splash, tick, draw, gone }
  }
  beforeEach(() => sessionStorage.clear())

  it('plays the intro once (1.1 s), then the full exit once the app is ready, and is removed', async () => {
    // Up at 2 s (a slow network); the app is ready at once.
    const { splash, tick, draw, gone } = setup({ shownAt: 2000 })
    await draw()
    tick(SPLASH_MIN_MS - 100)
    expect(splash).not.toHaveClass('is-leaving')
    tick(100)
    // The ring was showing: it closes, becomes a ▶, then the iris.
    expect(splash).toHaveClass('is-leaving', 'is-leaving--full')
    expect(Number(splash.style.getPropertyValue('--nt-iris-scale'))).toBeGreaterThan(10)
    tick(SPLASH_EXIT_FULL_MS - 100)
    expect(splash.isConnected).toBe(true)
    expect(gone).not.toHaveBeenCalled()
    tick(150)
    expect(splash.isConnected).toBe(false)
    expect(gone).toHaveBeenCalledOnce()
    // A reload in this tab: the short version.
    expect(sessionStorage.getItem(SPLASH_PLAYED_KEY)).toBe('1')
  })

  it('the short version: out after 0.45 s, straight to the iris, without waiting for the titles', async () => {
    const { splash, tick, draw } = setup({ quick: true })
    beginLoading()
    await draw()
    tick(SPLASH_QUICK_MIN_MS)
    expect(splash).toHaveClass('is-leaving', 'is-leaving--quick')
    tick(SPLASH_EXIT_QUICK_MS)
    expect(splash.isConnected).toBe(false)
  })

  it('waits while the first screen is still loading', async () => {
    const { splash, tick, draw } = setup()
    const done = beginLoading()
    await draw()
    tick(2000)
    expect(splash).not.toHaveClass('is-leaving')
    act(() => done())
    tick(40)
    expect(splash).toHaveClass('is-leaving')
  })

  it('starts its exit by 4 s even if the app is slow or never comes', () => {
    const { splash, tick } = setup()
    beginLoading()
    tick(SPLASH_MAX_MS - 1)
    expect(splash).not.toHaveClass('is-leaving')
    tick(1)
    expect(splash).toHaveClass('is-leaving')
  })
})
