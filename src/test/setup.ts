import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { resetAdBreaks } from '../ads/adBreakStore'
import { adTiming } from '../ads/directLink'
import { resetTvAdBreaks } from '../tv/tvAdBreakStore'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetAdBreaks()
  resetTvAdBreaks()
  document.documentElement.classList.remove('tv-mode')
  adTiming.blockCheckMs = Infinity
  vi.mocked(HTMLAnchorElement.prototype.click).mockClear()
})

// No blocked-ad check unless a test asks for one (jsdom never loses focus).
adTiming.blockCheckMs = Infinity
// Ads open by clicking a hidden link, which jsdom can't follow: record it instead (see adLinkClicks).
const anchorClick = HTMLAnchorElement.prototype.click
vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
  if (this.dataset.adLink === undefined) anchorClick.call(this)
})

// jsdom does not implement layout or scrolling APIs; stub the ones the UI calls.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
// jsdom has no window.open (the ad's fallback opener). Tests that check it stub their own.
window.open = vi.fn(() => null) as unknown as typeof window.open
Element.prototype.scrollIntoView = vi.fn()
Element.prototype.scrollBy = vi.fn() as unknown as typeof Element.prototype.scrollBy
