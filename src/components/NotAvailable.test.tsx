import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installQuietZones } from '../ads/adManager'
import type { MediaItem } from '../types/media'
import { NOT_AVAILABLE_MS, SLOW_LOAD_MS } from './PlayerHelp'
import { PlayerPanel } from './PlayerPanel'

const token = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('../account/client', async (original) => ({
  ...(await original<typeof import('../account/client')>()),
  accessToken: async () => token.value,
}))

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

const BOX = 'Not available on NAIJA TR yet'
const HINT = /Taking too long\?/
const SERVER_NOTE = /Movie slow to load or not playing\?/

let user: ReturnType<typeof userEvent.setup>
let requests: { body: Record<string, unknown>; auth: string | null }[]
let answer: () => Response

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  requests = []
  token.value = null
  localStorage.clear()
  answer = () => Response.json({ ok: true, count: 1, already: false, email: false })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/live/request') {
        requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: new Headers(init?.headers).get('Authorization') })
        return answer()
      }
      return new Response('{}')
    }),
  )
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: vi.fn(() => true) })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // @ts-expect-error: put back as jsdom has it (none).
  delete navigator.sendBeacon
})

async function openPlayer(item: MediaItem = film, onWatchSimilar?: () => void, container?: HTMLElement) {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true }))) as unknown as typeof fetch
  render(<PlayerPanel item={item} availability={{ movie: true, tv: true }} fetchImpl={fetchImpl} onWatchSimilar={onWatchSimilar} />, container ? { container } : undefined)
  await user.click(screen.getByRole('button', { name: item.type === 'series' ? 'Play S1 E1' : 'Play' }))
  const frame = (await screen.findByTitle(`${item.title} player`)) as HTMLIFrameElement
  fireEvent.load(frame)
  const send = (event: string, info?: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'embedmaster_player', event, info }, source: frame.contentWindow }))
    })
  return { frame, send }
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))
const box = () => screen.queryByRole('region', { name: BOX })

describe('"No server found": not available on NAIJA TR yet', () => {
  it('shows the box under the player 15 s after opening with no sign of life, instead of the switch-server tips', async () => {
    const { frame } = await openPlayer()
    await wait(SLOW_LOAD_MS + 500)
    expect(screen.getByText(HINT)).toBeInTheDocument()
    expect(box()).toBeNull()
    await wait(NOT_AVAILABLE_MS - SLOW_LOAD_MS)
    const shown = box()!
    expect(shown).toHaveTextContent(
      '😔 Not available on NAIJA TR yet‘No server found’ means this title isn’t available on any of our servers right now, so there’s no need to switch servers. It’s usually added later, especially new releases.',
    )
    // Under the player's buttons, never over the video; the slot above the video stays (no shift).
    const player = frame.closest('.player')!
    expect(frame.closest('.player__frame')).not.toContainElement(shown)
    expect(player.querySelector('.player__bar')!.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(player.querySelector('.player__status')).toBeEmptyDOMElement()
    // No "switch server" anywhere now.
    expect(screen.queryByText(HINT)).toBeNull()
    expect(screen.queryByText(SERVER_NOTE)).toBeNull()
    expect(screen.getByText(/‘No server found’ = this title isn’t on NAIJA TR yet\./)).toBeInTheDocument()
  })

  it('shows at once when the player says it has no source, and goes if it plays after all', async () => {
    const { send } = await openPlayer()
    send('error', 'No sources found')
    expect(box()).toBeInTheDocument()
    send('ready')
    expect(box()).toBeNull()
    await wait(NOT_AVAILABLE_MS * 2)
    expect(box()).toBeNull()
    expect(screen.getByText(SERVER_NOTE)).toBeInTheDocument()
  })

  it('isn’t fooled by one server failing while the player moves to the next', async () => {
    const { send } = await openPlayer()
    send('duration', 6000)
    send('error', 'VidStore failed')
    send('error', 'server failed')
    expect(box()).toBeNull()
    await wait(NOT_AVAILABLE_MS * 2)
    expect(box()).toBeNull()
  })

  it('stays away when the player answers in time', async () => {
    const { send } = await openPlayer()
    await wait(10_000)
    send('duration', 6000)
    await wait(NOT_AVAILABLE_MS * 2)
    expect(box()).toBeNull()
  })

  it('“Request this title” saves the request, with the episode; remembered next time', async () => {
    const { send } = await openPlayer(show)
    send('error', 'No server found')
    await user.click(screen.getByRole('button', { name: 'Request this title' }))
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({ item: 'tv:1399', title: 'Game of Thrones', ep: 's1e1' })
    expect(requests[0].body.device).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(requests[0].auth).toBeNull()
    expect(await screen.findByRole('button', { name: 'Requested' })).toBeDisabled()
    expect(screen.getByText('Thanks! Your request is saved.')).toBeInTheDocument()
    // The note says so too.
    expect(screen.getByText('Requested ✓ We’ll add it soon.')).toBeInTheDocument()
  })

  it('says “Requested” on a title this device already asked for', async () => {
    localStorage.setItem('naijatr.requestedTitles', JSON.stringify(['movie:550']))
    const { send } = await openPlayer()
    send('error', 'No server found')
    expect(screen.getByRole('button', { name: 'Requested' })).toBeDisabled()
    expect(requests).toHaveLength(0)
  })

  it('signed in: sends the account and says we’ll email them', async () => {
    token.value = 'access-token'
    answer = () => Response.json({ ok: true, count: 3, already: false, email: true })
    const { send } = await openPlayer()
    send('error', 'No sources found.')
    await user.click(screen.getByRole('button', { name: 'Request this title' }))
    expect(requests[0].auth).toBe('Bearer access-token')
    expect(await screen.findByText('Thanks! Your request is saved. We’ll email you when it’s available.')).toBeInTheDocument()
  })

  it('the note’s “Request” sends it too; a failure can be tried again', async () => {
    answer = () => new Response('{}', { status: 503 })
    await openPlayer()
    await user.click(screen.getByRole('button', { name: 'Request' }))
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({ item: 'movie:550', ep: null })
    answer = () => Response.json({ ok: true, count: 1, already: false, email: false })
    await user.click(screen.getByRole('button', { name: 'Request' }))
    expect(await screen.findByText('Requested ✓ We’ll add it soon.')).toBeInTheDocument()
    expect(requests).toHaveLength(2)
  })

  it('“Watch something similar” asks for “More like this”; no tap on the box reaches the ad script', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    installQuietZones(host)
    const adScript = vi.fn()
    document.addEventListener('click', adScript)
    const similar = vi.fn()
    const { send } = await openPlayer(film, similar, host)
    send('error', 'No server found')
    adScript.mockClear()
    await user.click(screen.getByRole('button', { name: 'Watch something similar' }))
    expect(similar).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Request this title' }))
    await screen.findByRole('button', { name: 'Requested' })
    await user.click(screen.getByRole('button', { name: 'Dismiss No server found note' }))
    expect(adScript).not.toHaveBeenCalled()
    document.removeEventListener('click', adScript)
    host.remove()
  })

  it('has no “Watch something similar” without similar titles', async () => {
    const { send } = await openPlayer()
    send('error', 'No server found')
    expect(screen.queryByRole('button', { name: 'Watch something similar' })).toBeNull()
  })
})
