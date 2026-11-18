import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installQuietZones } from '../ads/adManager'
import { deviceKind } from '../live/playerProblems'
import type { MediaItem } from '../types/media'
import { SLOW_LOAD_MS, SLOW_NOTE_HIDE_MS, SLOW_NOTE_KEY, STALL_MS } from './PlayerHelp'
import { AUDIO_NOTE_KEY, PlayerPanel } from './PlayerPanel'

const film: MediaItem = {
  id: 'tmdb-movie-550',
  tmdbId: 550,
  title: 'Fight Club',
  type: 'movie',
  year: 1999,
  releaseDate: '1999-10-15',
  genres: [],
  score: 8.4,
  voteCount: 1000,
  popularity: 1,
  description: '',
  poster: null,
  backdrop: null,
}
const show: MediaItem = { ...film, id: 'tmdb-series-1399', tmdbId: 1399, title: 'Game of Thrones', type: 'series', seasons: [{ number: 1, name: 'Season 1', episodeCount: 10 }] }

const HINT = /Taking too long\?.*Switch server from the menu at the top-left of the player\./
const NOTE = /Movie slow to load or not playing\? Tap the server menu at the top-left of the player and switch to another server \(e\.g\. MovieJoy, VidStore\)\. Pick one that loads fast and doesn’t freeze mid-show\./

let beacons: { url: string; body: Promise<unknown> }[]
let user: ReturnType<typeof userEvent.setup>

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  beacons = []
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: vi.fn((url: string, body: Blob) => {
      beacons.push({ url, body: body.text().then((text) => JSON.parse(text)) })
      return true
    }),
  })
})

afterEach(() => {
  vi.useRealTimers()
  // @ts-expect-error: put back as jsdom has it (none).
  delete navigator.sendBeacon
})

const problems = async () => Promise.all(beacons.filter((b) => b.url === '/api/live/problem').map((b) => b.body))

async function openPlayer(item: MediaItem = film) {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true }))) as unknown as typeof fetch
  render(<PlayerPanel item={item} availability={{ movie: true, tv: true }} fetchImpl={fetchImpl} />)
  await user.click(screen.getByRole('button', { name: item.type === 'series' ? 'Play S1 E1' : 'Play' }))
  const frame = (await screen.findByTitle(`${item.title} player`)) as HTMLIFrameElement
  // The page loads at once; the player inside it is what may be slow.
  fireEvent.load(frame)
  const send = (event: string, info?: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'embedmaster_player', event, info }, source: frame.contentWindow }))
    })
  return { frame, send }
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))
const hint = () => screen.queryByText(HINT)

describe('slow or stuck player', () => {
  it('shows the hint above the player when nothing has come from it 12 s after opening, and logs a slow start', async () => {
    const { frame, send } = await openPlayer()
    await wait(SLOW_LOAD_MS - 1000)
    expect(hint()).toBeNull()
    await wait(1500)
    const shown = screen.getByText(HINT)
    // Above the player, in its own slot: never over the video.
    const slot = shown.closest('.player__status')!
    expect(slot).not.toBeNull()
    expect(frame.closest('.player__frame')).not.toContainElement(shown)
    expect(slot.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(await problems()).toEqual([{ kind: 'slow', item: 'movie:550', ep: null, server: 'nextstream', source: null, device: 'desktop' }])

    // The player answers: gone, and logged only once.
    send('duration', 8000)
    expect(hint()).toBeNull()
    await wait(SLOW_LOAD_MS)
    expect(await problems()).toHaveLength(1)
  })

  it('stays quiet when the player is ready in time (even before Play is pressed)', async () => {
    const { send } = await openPlayer()
    await wait(5000)
    send('ready')
    await wait(SLOW_LOAD_MS * 2)
    expect(hint()).toBeNull()
    expect(await problems()).toEqual([])
  })

  it('shows the hint when playback stops moving for 10 s, logs the stall with the episode and source, and hides once it plays again', async () => {
    const { send } = await openPlayer(show)
    send('serverchange', 'VidStore')
    send('play')
    for (let t = 1; t <= 20; t++) {
      send('time', t)
      await wait(1000)
    }
    expect(hint()).toBeNull()
    // Stuck: the same time, or none at all.
    send('time', 20)
    await wait(STALL_MS - 2000)
    expect(hint()).toBeNull()
    await wait(3000)
    expect(screen.getByText(HINT)).toBeInTheDocument()
    expect(await problems()).toEqual([{ kind: 'stall', item: 'tv:1399', ep: 's1e1', server: 'nextstream', source: 'VidStore', device: 'desktop' }])
    // Moving again: gone by itself.
    send('time', 21)
    expect(hint()).toBeNull()
    // Stuck again later: back (logged once per player).
    await wait(STALL_MS + 1000)
    expect(screen.getByText(HINT)).toBeInTheDocument()
    expect(await problems()).toHaveLength(1)
  })

  it('doesn’t count a pause, or a hidden tab, as a stall', async () => {
    const { send } = await openPlayer()
    send('play')
    send('time', 1)
    send('time', 2)
    send('pause')
    await wait(STALL_MS * 3)
    expect(hint()).toBeNull()
    send('play')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await wait(STALL_MS * 3)
    expect(hint()).toBeNull()
    // @ts-expect-error: back to jsdom's own.
    delete document.visibilityState
  })

  it('has a ✕; a later stall shows it again', async () => {
    const { send } = await openPlayer()
    send('play')
    send('time', 1)
    send('time', 2)
    await wait(STALL_MS + 1000)
    await user.click(screen.getByRole('button', { name: 'Dismiss switch-server hint' }))
    expect(hint()).toBeNull()
    send('time', 3)
    await wait(STALL_MS + 1000)
    expect(screen.getByText(HINT)).toBeInTheDocument()
  })

  it('keeps the slot above the player the same while the hint comes and goes (no layout shift)', async () => {
    const { frame } = await openPlayer()
    const slot = frame.closest('.player')!.querySelector('.player__status')
    expect(slot).toBeInTheDocument()
    expect(slot).toBeEmptyDOMElement()
    await wait(SLOW_LOAD_MS + 500)
    expect(frame.closest('.player')!.querySelector('.player__status')).toBe(slot)
    expect(slot).toHaveTextContent(HINT)
  })

  it('shows even when the always-on note was dismissed; no taps on it reach the ad script', async () => {
    localStorage.setItem(SLOW_NOTE_KEY, String(Date.now()))
    const host = document.createElement('div')
    document.body.append(host)
    installQuietZones(host)
    const adScript = vi.fn()
    document.addEventListener('click', adScript)
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true }))) as unknown as typeof fetch
    render(<PlayerPanel item={film} availability={{ movie: true, tv: true }} fetchImpl={fetchImpl} />, { container: host })
    await user.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.load(await screen.findByTitle('Fight Club player'))
    expect(screen.queryByText(NOTE)).toBeNull()
    await wait(SLOW_LOAD_MS + 500)
    expect(screen.getByText(HINT)).toBeInTheDocument()
    adScript.mockClear()
    await user.click(screen.getByText(HINT))
    await user.click(screen.getByRole('button', { name: 'Dismiss switch-server hint' }))
    await user.click(screen.getByRole('button', { name: 'Dismiss audio note' }))
    expect(adScript).not.toHaveBeenCalled()
    document.removeEventListener('click', adScript)
    host.remove()
  })
})

describe('the notes under the player', () => {
  it('shows “slow to load?” and the audio note together under the buttons; ✕ hides the first for 3 days', async () => {
    const { frame } = await openPlayer()
    const note = screen.getByText(NOTE)
    const audio = screen.getByText(/Different sources in the player menu may have different audio languages/)
    // One list, the ⚡ note first, both under the buttons and never over the video.
    const list = note.closest('.player__notes')!
    expect(list).toContainElement(audio)
    expect(list.querySelectorAll('li')).toHaveLength(3)
    expect(frame.closest('.player__frame')).not.toContainElement(note)
    const bar = frame.closest('.player')!.querySelector('.player__bar')!
    expect(bar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(note.parentElement).toHaveTextContent(/^⚡ Movie slow to load/)

    await user.click(screen.getByRole('button', { name: 'Dismiss slow-loading tip' }))
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(screen.getByText(/different audio languages/)).toBeInTheDocument()
    expect(Number(localStorage.getItem(SLOW_NOTE_KEY))).toBeGreaterThan(0)
    expect(localStorage.getItem(AUDIO_NOTE_KEY)).toBeNull()
  })

  it('stays hidden for 3 days, then comes back', async () => {
    localStorage.setItem(SLOW_NOTE_KEY, String(Date.now() - SLOW_NOTE_HIDE_MS + 60_000))
    const first = render(<PlayerPanel item={film} availability={{ movie: true, tv: true }} fetchImpl={vi.fn().mockResolvedValue(new Response('{"available":true}')) as unknown as typeof fetch} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await screen.findByTitle('Fight Club player')
    expect(screen.queryByText(NOTE)).toBeNull()
    first.unmount()
    localStorage.setItem(SLOW_NOTE_KEY, String(Date.now() - SLOW_NOTE_HIDE_MS - 1))
    await openPlayer()
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })
})

describe('deviceKind', () => {
  it('tells phones, tablets, desktops and TVs apart', () => {
    expect(deviceKind('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5, false)).toBe('iphone')
    expect(deviceKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit', 5, false)).toBe('ipad')
    expect(deviceKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit', 0, false)).toBe('desktop')
    expect(deviceKind('Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari', 5, false)).toBe('android')
    expect(deviceKind('Mozilla/5.0 (Linux; Android 13; SM-X200) Safari', 5, false)).toBe('android-tablet')
    expect(deviceKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, false)).toBe('desktop')
    expect(deviceKind('anything', 0, true)).toBe('tv')
  })
})
