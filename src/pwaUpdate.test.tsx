import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateBar } from './components/UpdateBar'
import * as pwa from './pwa'
import serviceWorker from '../public/sw.js?raw'
import viteConfig from '../vite.config.ts?raw'

/** A stand-in for navigator.serviceWorker. */
function fakeContainer(controller: object | null) {
  const target = new EventTarget()
  const registration = { update: vi.fn(async () => undefined) }
  const container = Object.assign(target, {
    controller,
    register: vi.fn(async () => registration),
  }) as unknown as ServiceWorkerContainer
  return { container, registration }
}

const flush = () => act(async () => {})

describe('App updates', () => {
  afterEach(() => {
    vi.useRealTimers()
    pwa.resetUpdateReady()
  })

  it('shows "New update available" when a new version takes over', () => {
    const { container } = fakeContainer({})
    pwa.registerServiceWorker(container, true)
    render(<UpdateBar />)
    expect(screen.queryByRole('button', { name: /New update available/ })).not.toBeInTheDocument()

    act(() => void container.dispatchEvent(new Event('controllerchange')))
    const button = screen.getByRole('button', { name: 'New update available, tap to refresh' })
    expect(screen.getByRole('status')).toContainElement(button)
  })

  it('stays quiet when the first service worker takes over a fresh install', () => {
    const { container } = fakeContainer(null)
    pwa.registerServiceWorker(container, true)
    render(<UpdateBar />)
    act(() => void container.dispatchEvent(new Event('controllerchange')))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('reloads the app when the bar is tapped', async () => {
    const reload = vi.fn()
    const location = Object.getOwnPropertyDescriptor(window, 'location')!
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true })
    try {
      const { container } = fakeContainer({})
      pwa.registerServiceWorker(container, true)
      render(<UpdateBar />)
      act(() => void container.dispatchEvent(new Event('controllerchange')))
      await userEvent.click(screen.getByRole('button', { name: /tap to refresh/ }))
      expect(reload).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(window, 'location', location)
    }
  })

  it('looks for a new version when the app comes back to the front and every 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    const { container, registration } = fakeContainer({})
    pwa.registerServiceWorker(container, true)
    await flush()
    expect(container.register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' })

    document.dispatchEvent(new Event('visibilitychange'))
    expect(registration.update).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(pwa.UPDATE_CHECK_MS)
    expect(registration.update).toHaveBeenCalledTimes(2)
  })

  it('does nothing outside production builds', () => {
    const { container } = fakeContainer({})
    pwa.registerServiceWorker(container, false)
    expect(container.register).not.toHaveBeenCalled()
  })

  it('ships a service worker that updates itself and cleans up old caches', () => {
    expect(serviceWorker).toContain("const BUILD = '__BUILD_ID__'")
    expect(serviceWorker).toMatch(/const CACHE = `naija-tr-v2-\$\{BUILD\}`/)
    expect(serviceWorker).toContain('self.skipWaiting()')
    expect(serviceWorker).toContain('self.clients.claim()')
    expect(serviceWorker).toMatch(/keys\.filter\(\(key\) => key !== CACHE\)\.map\(\(key\) => caches\.delete\(key\)\)/)
    // Analytics and the APIs (players) are never touched.
    expect(serviceWorker).toMatch(/startsWith\('\/_vercel\/'\)\) return/)
    expect(serviceWorker).toMatch(/startsWith\('\/api\/'\)\) return/)
    // Pages: network first, the cached shell offline.
    expect(serviceWorker).toMatch(/await fetch\(request\)\)\s*\} catch \{\s*return \(await caches\.match\('\/'\)\)/)
    // The build stamps each deploy into dist/sw.js.
    expect(viteConfig).toContain("replace('__BUILD_ID__', buildId)")
  })
})
