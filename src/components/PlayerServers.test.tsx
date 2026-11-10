import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPlayer } from '../test/player'
import type { MediaItem } from '../types/media'
import { HIDDEN_CLOSE_MS, serverTiming } from '../config/players'
import { resetReferralStatus, type ReferralStatus } from '../referral/status'
import { readContinueWatching } from '../utils/continueWatching'
import { PlayerPanel } from './PlayerPanel'

// The account's Continue watching is here (its wait is tested in src/account/sync.test.ts).
vi.mock('../account/sync', async (original) => ({
  ...(await original<typeof import('../account/sync')>()),
  syncLoading: () => false,
  syncSettled: () => Promise.resolve(),
}))

const PLAYER_ID = 'v2pxn252iu6ornvs8i'
const OPTIONS = 'skin=onyx&welcome_page=off&autoplay=on'
const EMBEDMASTER_MOVIE = `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`

const movie: MediaItem = {
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
const show: MediaItem = {
  ...movie,
  id: 'tmdb-series-1399',
  tmdbId: 1399,
  type: 'series',
  title: 'Game of Thrones',
  seasons: [{ number: 1, name: 'Season 1', episodeCount: 3 }],
}
const on = { movie: true, tv: true }

/** NextStream's /api/play check: available or not. */
const checks = (available: boolean) =>
  vi.fn().mockImplementation(async () => new Response(JSON.stringify(available ? { available } : { available, reason: 'not-found' }))) as unknown as typeof fetch

/** What a player posts to the top window, from inside `frame`. */
const post = (frame: HTMLElement, event: string, info: number | null = null, origin = 'https://embedmaster.link') =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'embedmaster_player', event, info },
        origin,
        source: (frame as HTMLIFrameElement).contentWindow,
      }),
    )
  })

/** The server's answers (/api/referral/status). */
const SIGNED_IN_FREE: ReferralStatus = { goal: 5, signedIn: true, userId: 'u1', adFree: false }
const PAID: ReferralStatus = { ...SIGNED_IN_FREE, adFree: true, adFreeUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() }
/** AD_FREE_EMAILS: ad-free for good. */
const ALLOWLISTED: ReferralStatus = { ...SIGNED_IN_FREE, adFree: true, permanent: true }
const answer = (status: ReferralStatus | null) => act(() => resetReferralStatus(status))

const seekTo = (value: number) => ({ source: 'embedmaster_player_command', command: 'seek', value })
const commands = (frame: HTMLElement) =>
  vi.spyOn((frame as HTMLIFrameElement).contentWindow!, 'postMessage').mockImplementation(() => undefined)
const play = (name = 'Play') => userEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  vi.stubEnv('VITE_EMBEDMASTER_PLAYER_ID', PLAYER_ID)
  localStorage.clear()
})

afterEach(() => {
  resetReferralStatus(null)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  serverTiming.hiddenCloseMs = HIDDEN_CLOSE_MS
})

describe('one server per account', () => {
  it('free (signed out): Server 1 only, no server buttons', async () => {
    const fetchImpl = checks(true)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={fetchImpl} />)
    expect(screen.queryByRole('group', { name: 'Server' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Server 2' })).not.toBeInTheDocument()
    await play()
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
    expect(fetchImpl).toHaveBeenCalledWith('/api/play/movie/550?check=1')
  })

  it('free (signed in without ad-free): Server 1 only', async () => {
    resetReferralStatus(SIGNED_IN_FREE)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    expect(screen.queryByRole('group', { name: 'Server' })).not.toBeInTheDocument()
    await play()
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('ad-free (paid until a later date): Server 2 only, with its options and no sandbox', async () => {
    resetReferralStatus(PAID)
    const fetchImpl = checks(true)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={fetchImpl} />)
    expect(screen.queryByRole('group', { name: 'Server' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Server 1' })).not.toBeInTheDocument()
    await play()
    const frame = await findPlayer('Fight Club player')
    expect(frame).toHaveAttribute('src', EMBEDMASTER_MOVIE)
    expect(frame).not.toHaveAttribute('sandbox')
    // Nothing to check first, and no Server 1 behind it.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('ad-free (AD_FREE_EMAILS): Server 2, the chosen episode', async () => {
    resetReferralStatus(ALLOWLISTED)
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await userEvent.selectOptions(screen.getByLabelText('Episode'), '2')
    await play('Play S1 E2')
    expect(await findPlayer('Game of Thrones player')).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/tv/1399/1/2?${OPTIONS}`)
  })

  it('goes by the server’s answer, not this device’s saved copy or an old pick', async () => {
    localStorage.setItem('naijatr.adFree', JSON.stringify({ userId: 'u1', adFree: true, until: null, permanent: true, at: Date.now() }))
    localStorage.setItem('naijatr.playerServer', 'embedmaster')
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('moves to Server 2 as soon as the account is ad-free, and back to Server 1 when it runs out', async () => {
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    answer({ ...PAID, adFreeUntil: new Date(Date.now() + 1000).toISOString() })
    await play()
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', EMBEDMASTER_MOVIE)
    await userEvent.click(screen.getByRole('button', { name: /Close player/ }))
    // Its ad-free ends: the status re-reads the moment it does (plus a second).
    await new Promise((resolve) => setTimeout(resolve, 2200))
    await play()
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('signed in, Play before the server has answered: waits for it, then opens Server 2', async () => {
    // A signed-in device: a stored session.
    localStorage.setItem('naijatr.auth', '{}')
    let reply: (status: ReferralStatus) => void = () => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (reply = (status) => resolve(new Response(JSON.stringify(status)))))),
    )
    const fetchImpl = checks(true)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={fetchImpl} />)
    await play()
    // Not on Server 1 meanwhile.
    expect(screen.queryByTitle('Fight Club player')).not.toBeInTheDocument()
    await act(async () => reply(PAID))
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', EMBEDMASTER_MOVIE)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('found ad-free while Server 1 plays: Server 2 carries on from the same point', async () => {
    resetReferralStatus(SIGNED_IN_FREE)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    const one = await findPlayer('Fight Club player')
    expect(one).toHaveAttribute('src', '/api/play/movie/550')
    post(one, 'duration', 6000, 'https://embdmstrplayer.com')
    post(one, 'time', 1300, 'https://embdmstrplayer.com')
    answer(PAID)
    await vi.waitFor(() => expect(screen.getByTitle('Fight Club player')).toHaveAttribute('src', EMBEDMASTER_MOVIE))
    const two = screen.getByTitle('Fight Club player')
    const send = commands(two)
    post(two, 'duration', 6000)
    expect(send).toHaveBeenCalledWith(seekTo(1300), 'https://embedmaster.link')
  })

  it('never falls back to the other server: a title Server 1 can’t play says so', async () => {
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(false)} />)
    await play()
    expect(await screen.findByRole('alert')).toHaveTextContent('This title isn’t available to stream right now.')
    expect(screen.queryByTitle('Fight Club player')).not.toBeInTheDocument()
  })

  it('keeps an ad-free account on Server 1 when there is no EmbedMaster player id', async () => {
    vi.stubEnv('VITE_EMBEDMASTER_PLAYER_ID', '')
    resetReferralStatus(PAID)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('plays on EmbedMaster when NextStream isn’t set up', async () => {
    render(<PlayerPanel item={movie} availability={{ movie: false, tv: false }} fetchImpl={checks(true)} />)
    await play()
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', EMBEDMASTER_MOVIE)
  })
})

describe('progress shared between Server 1 and Server 2', () => {
  it('S1E3 to 20:00 on Server 1, then ad-free: Server 2 carries on from 20:00', async () => {
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await userEvent.selectOptions(screen.getByLabelText('Episode'), '3')
    await play('Play S1 E3')
    const one = await findPlayer('Game of Thrones player')
    expect(one).toHaveAttribute('src', '/api/play/tv/1399/1/3')
    post(one, 'duration', 3600, 'https://embdmstrplayer.com')
    post(one, 'time', 1200, 'https://embdmstrplayer.com')
    await userEvent.click(screen.getByRole('button', { name: /Close player/ }))
    expect(readContinueWatching()[0]).toMatchObject({ season: 1, episode: 3, progressSeconds: 1200 })

    answer(PAID)
    await play('Play S1 E3')
    const two = await findPlayer('Game of Thrones player')
    expect(two).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/tv/1399/1/3?${OPTIONS}`)
    const send = commands(two)
    post(two, 'duration', 3600)
    expect(send).toHaveBeenCalledWith(seekTo(1200), 'https://embedmaster.link')
    // Its own early times (0, or a spot it remembers) don't count.
    post(two, 'time', 0)
    post(two, 'time', 300)
    expect(readContinueWatching()[0].progressSeconds).toBe(1200)
    post(two, 'time', 1201)
    post(two, 'time', 1500)
    post(two, 'pause')
    expect(readContinueWatching()[0]).toMatchObject({ season: 1, episode: 3, progressSeconds: 1500 })
    expect(readContinueWatching()).toHaveLength(1)
  })

  it('a smaller time right after the seek is sent back, not saved', async () => {
    resetReferralStatus(PAID)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    const first = await findPlayer('Fight Club player')
    post(first, 'duration', 6000)
    post(first, 'time', 1200)
    await userEvent.click(screen.getByRole('button', { name: /Close player/ }))
    await play()
    const two = await findPlayer('Fight Club player')
    const send = commands(two)
    post(two, 'duration', 6000)
    post(two, 'time', 1200)
    // The player jumps back to a spot of its own just after.
    post(two, 'time', 400)
    post(two, 'pause')
    expect(readContinueWatching()[0].progressSeconds).toBe(1200)
    expect(send).toHaveBeenLastCalledWith(seekTo(1200), 'https://embedmaster.link')
  })

  it('saves EmbedMaster progress for Continue watching and finishes at the end', async () => {
    resetReferralStatus(PAID)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    const frame = await findPlayer('Fight Club player')
    post(frame, 'duration', 6000)
    post(frame, 'time', 120)
    expect(readContinueWatching()[0]).toMatchObject({ id: 'tmdb-movie-550', progressSeconds: 120, durationSeconds: 6000 })
    post(frame, 'ended')
    expect(readContinueWatching()).toHaveLength(0)
  })

  it('offers the episode Continue watching is on, whichever server played it', async () => {
    localStorage.setItem('naijatr:last-episode:tmdb-series-1399', JSON.stringify({ season: 1, episode: 1 }))
    localStorage.setItem(
      'naijatr:continueWatching',
      JSON.stringify([
        {
          id: show.id, type: 'tv', tmdbId: 1399, title: show.title, poster: null, backdrop: null,
          season: 1, episode: 3, episodeTitle: null, still: null, progressSeconds: 900, durationSeconds: 3600,
          lastWatchedAt: Date.now(), seasons: [{ number: 1, episodeCount: 3 }], source: 'stream', item: show,
        },
      ]),
    )
    resetReferralStatus(PAID)
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await play('Continue S1 E3')
    const two = await findPlayer('Game of Thrones player')
    expect(two).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/tv/1399/1/3?${OPTIONS}`)
    const send = commands(two)
    post(two, 'duration', 3600)
    expect(send).toHaveBeenCalledWith(seekTo(900), 'https://embedmaster.link')
  })
})

describe('players closed properly', () => {
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }
  beforeEach(() => resetReferralStatus(PAID))
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('shows the provider’s player straight away, with nothing of ours over it, even if it sends nothing', async () => {
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    const frame = await findPlayer('Fight Club player')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(screen.getByTitle('Fight Club player')).toBe(frame)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(localStorage.getItem('naijatr.streamLimit')).toBeNull()
  })

  it('Close player unloads the iframe (about:blank) and removes it, saving the progress first', async () => {
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    const frame = await findPlayer('Fight Club player')
    post(frame, 'duration', 6000)
    post(frame, 'time', 700)
    await userEvent.click(screen.getByRole('button', { name: /Close player/ }))
    expect(frame).not.toBeInTheDocument()
    expect(frame.getAttribute('src')).toBe('about:blank')
    expect(readContinueWatching()[0].progressSeconds).toBe(700)
  })

  it('keeps the same player through re-renders, fullscreen and a short trip to another tab', async () => {
    serverTiming.hiddenCloseMs = 150
    const { rerender } = render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    const frame = await findPlayer('Fight Club player')
    const src = frame.getAttribute('src')
    post(frame, 'duration', 6000)
    rerender(<PlayerPanel item={{ ...movie, description: 'More details loaded' }} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
    await userEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }))
    setHidden(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    setHidden(false)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(screen.getByTitle('Fight Club player')).toBe(frame)
    expect(frame.getAttribute('src')).toBe(src)
  })

  it('closes a player left in a hidden tab for 2 minutes; Play carries on from the saved time', async () => {
    serverTiming.hiddenCloseMs = 80
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await play()
    const frame = await findPlayer('Fight Club player')
    post(frame, 'duration', 6000)
    post(frame, 'time', 900)
    setHidden(true)
    await vi.waitFor(() => expect(frame).not.toBeInTheDocument())
    expect(frame.getAttribute('src')).toBe('about:blank')
    expect(readContinueWatching()[0].progressSeconds).toBe(900)
    setHidden(false)
    expect(screen.getByRole('status')).toHaveTextContent('The player was closed while you were away')
    await play()
    const again = await findPlayer('Fight Club player')
    const send = commands(again)
    post(again, 'duration', 6000)
    expect(send).toHaveBeenCalledWith(seekTo(900), 'https://embedmaster.link')
  })

  it('another episode picked: the playing one is unloaded, and the new one loads only on Play', async () => {
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await play('Play S1 E1')
    const first = await findPlayer('Game of Thrones player')
    await userEvent.selectOptions(screen.getByLabelText('Episode'), '2')
    expect(first).not.toBeInTheDocument()
    expect(first.getAttribute('src')).toBe('about:blank')
    expect(screen.queryByTitle('Game of Thrones player')).not.toBeInTheDocument()
    await play('Play S1 E2')
    expect(await findPlayer('Game of Thrones player')).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/tv/1399/1/2?${OPTIONS}`)
  })
})
