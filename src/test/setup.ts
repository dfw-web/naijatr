import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
})

// jsdom does not implement layout or scrolling APIs; stub the ones the UI calls.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
// Title cards open an ad tab; jsdom has no window.open. Tests that check it stub their own.
window.open = vi.fn(() => null) as unknown as typeof window.open
Element.prototype.scrollIntoView = vi.fn()
Element.prototype.scrollBy = vi.fn() as unknown as typeof Element.prototype.scrollBy
