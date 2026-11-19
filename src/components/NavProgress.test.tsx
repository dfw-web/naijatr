import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginLoading, isLoading, resetLoading, trackLoading } from '../ui/loadingTracker'
import { hideSplashWhenReady, SPLASH_FADE_MS, SPLASH_MAX_MS, SPLASH_MIN_MS } from '../ui/splash'
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
    let finish = (_: unknown) => {}
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
  const setup = () => {
    const splash = document.createElement('div')
    splash.id = 'nt-splash'
    const root = document.createElement('div')
    document.body.append(splash, root)
    let clock = 0
    hideSplashWhenReady(root, () => clock)
    const frames = () => wait(40)
    return { splash, root, frames, at: (ms: number) => void (clock = ms) }
  }

  it('stays at least 600 ms, then zooms and fades out, and is removed', async () => {
    const { splash, root, frames, at } = setup()
    at(100)
    root.append(document.createElement('main'))
    await act(async () => {})
    frames()
    expect(splash).not.toHaveClass('is-leaving')
    wait(SPLASH_MIN_MS)
    expect(splash).toHaveClass('is-leaving')
    expect(splash.isConnected).toBe(true)
    wait(SPLASH_FADE_MS)
    expect(splash.isConnected).toBe(false)
  })

  it('waits while the first screen is still loading, but never past 4 s', async () => {
    const { splash, root, frames, at } = setup()
    const done = beginLoading()
    root.append(document.createElement('main'))
    await act(async () => {})
    at(1000)
    frames()
    wait(1000)
    expect(splash).not.toHaveClass('is-leaving')
    // It finishes: gone soon after.
    at(1500)
    act(() => done())
    frames()
    expect(splash).toHaveClass('is-leaving')
  })

  it('goes at 4 s even if the app never gets ready', () => {
    const { splash } = setup()
    beginLoading()
    wait(SPLASH_MAX_MS - 1)
    expect(splash).not.toHaveClass('is-leaving')
    wait(1)
    expect(splash).toHaveClass('is-leaving')
  })
})
