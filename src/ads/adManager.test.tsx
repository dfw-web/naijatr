import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MULTITAG } from '../config/ads'
import { playAfterGate } from '../gate/gateStore'
import { TelegramGateHost } from '../gate/TelegramGate'
import { openInviteGuide } from '../referral/guide'
import { AD_LINK, adLinkClicks } from '../test/ads'
import { playAfterAdBreak } from '../tv/tvAdBreakStore'
import { adClock, cardAd, holdAdsThisTap, lagosDay, playbackAd, searchAd, useAdOverlay } from './adManager'
import { loadMultitag } from './monetag'

const MINUTE = 60_000
// 12:00 in Lagos.
let now = Date.UTC(2026, 9, 27, 11)
let beacons: unknown[]

/** Runs `fn` inside a real click, as the site's buttons do. */
function tap(fn: (event: Event) => void) {
  const button = document.createElement('button')
  button.addEventListener('click', fn)
  document.body.append(button)
  button.click()
  button.remove()
}

const card = (id: string) => tap((event) => cardAd(event, { id }))
const play = (id: string) => tap(() => playbackAd(`title:${id}`))
const watch = (match: string) => tap(() => playbackAd(`match:${match}`))
const search = () => tap((event) => searchAd(event))
const ads = () => adLinkClicks().length
const reported = () => beacons.map((body) => (body as { event: string }).event)

beforeEach(() => {
  now = Date.UTC(2026, 9, 27, 11)
  adClock.now = () => now
  beacons = []
  navigator.sendBeacon = vi.fn((_url: string | URL, body?: BodyInit | null) => {
    void (body as Blob).text().then((text) => beacons.push(JSON.parse(text)))
    return true
  })
})

afterEach(() => {
  delete (navigator as Partial<Navigator>).sendBeacon
  document.querySelectorAll('.player__frame, .fb-stream__player, script[data-zone]').forEach((node) => node.remove())
})

describe('the shared limits', () => {
  it('leaves at least a minute between two ads', async () => {
    card('a')
    now += 30_000
    card('b')
    expect(ads()).toBe(1)
    now += 30_000
    card('b')
    expect(adLinkClicks()).toEqual([AD_LINK, AD_LINK])
    await vi.waitFor(() => expect(reported()).toEqual(['card', 'cooldown', 'card']))
    expect(navigator.sendBeacon).toHaveBeenCalledWith('/api/live/ad', expect.any(Blob))
  })

  it('opens at most 8 a day, and starts again at midnight Lagos time', async () => {
    now = Date.UTC(2026, 9, 27, 14)
    for (let i = 0; i < 8; i++) {
      card(`t${i}`)
      now += MINUTE
    }
    expect(ads()).toBe(8)
    card('t8')
    expect(ads()).toBe(8)
    // 23:59 in Lagos: still today.
    now = Date.UTC(2026, 9, 27, 22, 59)
    card('t8')
    expect(ads()).toBe(8)
    // Midnight in Lagos is 23:00 UTC.
    now = Date.UTC(2026, 9, 27, 23)
    expect(lagosDay(now)).toBe('2026-10-28')
    card('t8')
    expect(ads()).toBe(9)
    await vi.waitFor(() => expect(reported().filter((e) => e === 'cap')).toHaveLength(2))
  })

  it('keeps the turn of a held-back tap for the next one', () => {
    card('a')
    now += 10_000
    card('b') // cooldown
    now += MINUTE
    card('b')
    expect(ads()).toBe(2)
  })
})

describe('when each ad opens', () => {
  it('opens up to 2 per title: its first card click and its first Play', () => {
    card('dune')
    now += MINUTE
    card('dune')
    expect(ads()).toBe(1)
    play('dune')
    expect(ads()).toBe(2)
    now += MINUTE
    play('dune')
    card('dune')
    expect(ads()).toBe(2)
    // Another title has its own two.
    play('arcane')
    expect(ads()).toBe(3)
  })

  it('never opens without a tap (a resumed title starts its player by itself)', () => {
    expect(playbackAd('title:dune')).toBe(false)
    expect(ads()).toBe(0)
  })

  it('opens on a match’s first Watch, then only 5+ minutes after its last ad', () => {
    watch('1')
    now += 4 * MINUTE
    watch('1')
    expect(ads()).toBe(1)
    now += MINUTE
    watch('1')
    expect(ads()).toBe(2)
  })

  it('opens on the first search of the visit, then at most every 10 minutes', () => {
    search()
    now += 9 * MINUTE
    search()
    expect(ads()).toBe(1)
    now += MINUTE
    search()
    expect(ads()).toBe(2)
  })
})

describe('no ads during playback', () => {
  it('opens nothing while a film, episode or trailer player is open', () => {
    const frame = document.createElement('div')
    frame.className = 'player__frame'
    document.body.append(frame)
    card('a')
    play('a')
    search()
    expect(ads()).toBe(0)
    // Closed: the title's turns are still there.
    frame.remove()
    play('a')
    expect(ads()).toBe(1)
  })

  it('opens nothing while a football stream plays', () => {
    const player = document.createElement('div')
    player.className = 'fb-stream__player'
    player.append(document.createElement('video'))
    document.body.append(player)
    watch('1')
    card('a')
    expect(ads()).toBe(0)
  })
})

describe('no ads with the popups', () => {
  it('opens nothing while a popup is open, then on the next eligible tap', () => {
    function Popup() {
      useAdOverlay()
      return null
    }
    const { unmount } = render(<Popup />)
    card('a')
    expect(ads()).toBe(0)
    unmount()
    card('a')
    expect(ads()).toBe(1)
  })

  it('opens nothing on the tap that opens the invite guide', () => {
    tap((event) => {
      openInviteGuide()
      cardAd(event, { id: 'a' })
    })
    expect(ads()).toBe(0)
  })

  it('opens nothing on a tap that holds it back', () => {
    tap((event) => {
      holdAdsThisTap()
      cardAd(event, { id: 'a' })
    })
    expect(ads()).toBe(0)
    card('a')
    expect(ads()).toBe(1)
  })

  it('waits for the Play after the Telegram gate', async () => {
    vi.stubEnv('VITE_TELEGRAM_GATE_ENABLED', 'true')
    const started = vi.fn()
    const user = userEvent.setup()
    render(
      <>
        <button type="button" onClick={() => playAfterGate(() => playAfterAdBreak('title:dune', started))}>
          Play
        </button>
        <TelegramGateHost />
      </>,
    )
    // The tap that opens the gate, and the one that closes it and starts the video: no ad.
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue without joining' }))
    expect(started).toHaveBeenCalledTimes(1)
    expect(ads()).toBe(0)
    // The next Play opens it.
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(started).toHaveBeenCalledTimes(2)
    expect(ads()).toBe(1)
    vi.unstubAllEnvs()
  })
})

describe('the Multitag', () => {
  it('is added once, with its exact attributes', () => {
    expect(loadMultitag()).toBe(true)
    expect(loadMultitag()).toBe(true)
    const scripts = document.querySelectorAll(`script[data-zone="${MULTITAG.zone}"]`)
    expect(scripts).toHaveLength(1)
    const script = scripts[0] as HTMLScriptElement
    expect(script.getAttribute('src')).toBe('https://quge5.com/88/tag.min.js')
    expect(script.getAttribute('data-zone')).toBe('302667')
    expect(script.async).toBe(true)
    expect(script.getAttribute('data-cfasync')).toBe('false')
    expect(document.querySelectorAll('script[src*="vignette"], script[data-zone="12033047"], script[data-zone="12038439"]')).toHaveLength(0)
  })

  it('is not added with ?noads=1, on the admin pages, the contest rules or the claim form', () => {
    for (const path of ['/admin/live', '/challenge/rules', '/challenge/claim', '/?noads=1']) {
      window.history.replaceState(null, '', path)
      expect(loadMultitag()).toBe(false)
    }
    expect(document.querySelector('script[data-zone]')).toBeNull()
  })
})
