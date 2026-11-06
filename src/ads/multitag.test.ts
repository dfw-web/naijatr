import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MULTITAG, MULTITAG_2 } from '../config/ads'
import { loadMultitag, SECOND_TAG_RETRY_MS } from './monetag'

let beacons: string[]

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  MULTITAG_2.enabled = true
  beacons = []
  navigator.sendBeacon = vi.fn((_url: string | URL, body?: BodyInit | null) => {
    void (body as Blob).text().then((text) => beacons.push((JSON.parse(text) as { event: string }).event))
    return true
  })
})

afterEach(() => {
  vi.useRealTimers()
  delete (navigator as Partial<Navigator>).sendBeacon
  document.querySelectorAll('script[data-zone], .player__frame').forEach((node) => node.remove())
})

const first = () => document.getElementById(MULTITAG.id) as HTMLScriptElement | null
const second = () => document.getElementById(MULTITAG_2.id) as HTMLScriptElement | null

describe('the second Multitag (zone 306795)', () => {
  it('is its own script element, with the exact attributes, added once the first has loaded', async () => {
    expect(loadMultitag()).toBe(true)
    expect(first()?.getAttribute('data-zone')).toBe('302667')
    expect(second()).toBeNull()
    first()!.dispatchEvent(new Event('load'))
    const tag = second()!
    expect(tag.getAttribute('src')).toBe('https://quge5.com/88/tag.min.js')
    expect(tag.getAttribute('data-zone')).toBe('306795')
    expect(tag.async).toBe(true)
    expect(tag.getAttribute('data-cfasync')).toBe('false')
    // Both zones stay on the page.
    expect([...document.querySelectorAll('script[data-zone]')].map((s) => s.getAttribute('data-zone'))).toEqual(['302667', '306795'])
    tag.dispatchEvent(new Event('load'))
    await vi.waitFor(() => expect(beacons).toEqual(['multitag-302667', 'multitag-306795']))
  })

  it('is added only once, however often the page asks', () => {
    loadMultitag()
    first()!.dispatchEvent(new Event('load'))
    loadMultitag()
    first()!.dispatchEvent(new Event('load'))
    expect(document.querySelectorAll(`script[data-zone="${MULTITAG_2.zone}"]`)).toHaveLength(1)
    expect(document.querySelectorAll(`script[data-zone="${MULTITAG.zone}"]`)).toHaveLength(1)
  })

  it('still loads when the first was blocked, and counts the block', async () => {
    loadMultitag()
    first()!.dispatchEvent(new Event('error'))
    expect(second()).not.toBeNull()
    await vi.waitFor(() => expect(beacons).toEqual(['multitag-302667-blocked']))
  })

  it('waits while a player is open', () => {
    vi.useFakeTimers()
    const frame = document.createElement('div')
    frame.className = 'player__frame'
    document.body.append(frame)
    loadMultitag()
    first()!.dispatchEvent(new Event('load'))
    expect(second()).toBeNull()
    vi.advanceTimersByTime(SECOND_TAG_RETRY_MS)
    expect(second()).toBeNull()
    frame.remove()
    vi.advanceTimersByTime(SECOND_TAG_RETRY_MS)
    expect(second()).not.toBeNull()
  })

  it('stays off with MULTITAG_2_ENABLED=false, leaving zone 302667 alone', () => {
    MULTITAG_2.enabled = false
    loadMultitag()
    first()!.dispatchEvent(new Event('load'))
    expect(first()).not.toBeNull()
    expect(second()).toBeNull()
  })

  it('is never added on the pages without ads, or with ?noads=1', () => {
    for (const path of ['/admin/live', '/?noads=1']) {
      window.history.replaceState(null, '', path)
      expect(loadMultitag()).toBe(false)
    }
    expect(document.querySelector('script[data-zone]')).toBeNull()
  })
})
