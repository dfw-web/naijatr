import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPlayer } from '../test/player'
import type { MediaItem } from '../types/media'
import { SERVER_START_TIMEOUT_MS, serverTiming } from '../config/players'
import { readContinueWatching } from '../utils/continueWatching'
import { PlayerPanel } from './PlayerPanel'

const PLAYER_ID = 'v2pxn252iu6ornvs8i'
const OPTIONS = 'skin=onyx&welcome_page=off&autoplay=on'

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

const server = (name: string) => screen.getByRole('button', { name })

beforeEach(() => {
  vi.stubEnv('VITE_EMBEDMASTER_PLAYER_ID', PLAYER_ID)
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  serverTiming.startMs = SERVER_START_TIMEOUT_MS
})

describe('Server 1 / Server 2', () => {
  it('offers both servers, Server 1 (NextStream) first', async () => {
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    expect(server('Server 1')).toHaveAttribute('aria-pressed', 'true')
    expect(server('Server 2')).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('plays a movie on EmbedMaster with its options, no sandbox, and remembers the pick', async () => {
    const fetchImpl = checks(true)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={fetchImpl} />)
    await userEvent.click(server('Server 2'))
    expect(localStorage.getItem('naijatr.playerServer')).toBe('embedmaster')
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const frame = await findPlayer('Fight Club player')
    expect(frame).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`)
    expect(frame).toHaveAttribute('allow', 'autoplay *; fullscreen *; picture-in-picture *; encrypted-media *')
    expect(frame).toHaveAttribute('allowfullscreen')
    expect(frame).not.toHaveAttribute('sandbox')
    // Nothing to check first on EmbedMaster.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('plays the chosen episode on EmbedMaster, and Server 2 stays picked next time', async () => {
    localStorage.setItem('naijatr.playerServer', 'embedmaster')
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    expect(server('Server 2')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.selectOptions(screen.getByLabelText('Episode'), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Play S1 E2' }))
    expect(await findPlayer('Game of Thrones player')).toHaveAttribute(
      'src',
      `https://embedmaster.link/${PLAYER_ID}/tv/1399/1/2?${OPTIONS}`,
    )
  })

  it('switches the playing episode between servers, carrying on from the same point', async () => {
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play S1 E1' }))
    const first = await findPlayer('Game of Thrones player')
    expect(first).toHaveAttribute('src', '/api/play/tv/1399/1/1')
    post(first, 'time', 300, 'https://embdmstrplayer.com')

    await userEvent.click(server('Server 2'))
    const second = await findPlayer('Game of Thrones player')
    expect(second).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/tv/1399/1/1?${OPTIONS}`)
    expect(server('Server 2')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText(/Switched to/)).not.toBeInTheDocument()

    const send = vi.spyOn((second as HTMLIFrameElement).contentWindow!, 'postMessage').mockImplementation(() => undefined)
    post(second, 'time', 0)
    expect(send).toHaveBeenCalledWith({ source: 'embedmaster_player_command', command: 'seek', value: 300 }, 'https://embedmaster.link')
    // Still one Continue watching entry, on the same episode.
    expect(readContinueWatching()).toHaveLength(1)
  })

  it('saves EmbedMaster progress for Continue watching and finishes at the end', async () => {
    localStorage.setItem('naijatr.playerServer', 'embedmaster')
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const frame = await findPlayer('Fight Club player')
    post(frame, 'duration', 6000)
    post(frame, 'time', 120)
    expect(readContinueWatching()[0]).toMatchObject({ id: 'tmdb-movie-550', progressSeconds: 120, durationSeconds: 6000 })
    post(frame, 'ended')
    expect(readContinueWatching()).toHaveLength(0)
  })

  it('moves to Server 2 by itself when Server 1 can’t play the title', async () => {
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(false)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const frame = await findPlayer('Fight Club player')
    expect(frame).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`)
    expect(screen.getByText('Switched to Server 2')).toBeInTheDocument()
    // Not remembered: Server 1 stays the viewer's server.
    expect(localStorage.getItem('naijatr.playerServer')).toBeNull()
  })

  it('moves to the other server when the player sends nothing for a while, once', async () => {
    serverTiming.startMs = 50
    localStorage.setItem('naijatr.playerServer', 'embedmaster')
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByText('Switched to Server 1')).toBeInTheDocument()
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
    // Server 1 is silent too: no switching back, but the viewer's daily limit.
    expect(await screen.findByText(/You’ve reached today’s streaming limit 😔 It resets in about/)).toBeInTheDocument()
    expect(screen.queryByTitle('Fight Club player')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '＋ My List' })).toBeInTheDocument()
  })

  it('switches at the same episode and time when the player shows something that isn’t the video', async () => {
    serverTiming.startMs = 80
    localStorage.setItem('naijatr.playerServer', 'embedmaster')
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await userEvent.selectOptions(screen.getByLabelText('Episode'), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Play S1 E2' }))
    const two = await findPlayer('Game of Thrones player')
    // Saved earlier on this device: 10:00 into S1 E2.
    const entry = readContinueWatching()[0]
    localStorage.setItem('naijatr:continueWatching', JSON.stringify([{ ...entry, progressSeconds: 600 }]))
    // A message from the player that isn't a playable start (like a limit screen) doesn't count.
    post(two, 'ready')
    post(two, 'duration', 0)
    expect(await screen.findByText('Switched to Server 1')).toBeInTheDocument()
    const one = await findPlayer('Game of Thrones player')
    expect(one).toHaveAttribute('src', '/api/play/tv/1399/1/2')
    const send = vi.spyOn((one as HTMLIFrameElement).contentWindow!, 'postMessage').mockImplementation(() => undefined)
    post(one, 'duration', 3600, 'https://embdmstrplayer.com')
    expect(send).toHaveBeenCalledWith({ source: 'embedmaster_player_command', command: 'seek', value: 600 }, 'https://embdmstrplayer.com')
    // Server 2 is remembered as limited on this device only.
    expect(JSON.parse(localStorage.getItem('naijatr.streamLimit') ?? '{}')).toHaveProperty('embedmaster')
  })

  it('skips a server limited on this device, and shows the limit at once when both are', async () => {
    const later = Date.now() + 60 * 60_000
    localStorage.setItem('naijatr.streamLimit', JSON.stringify({ nextstream: later }))
    const fetchImpl = checks(true)
    const { unmount } = render(<PlayerPanel item={movie} availability={on} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`)
    expect(fetchImpl).not.toHaveBeenCalled()
    unmount()

    localStorage.setItem('naijatr.streamLimit', JSON.stringify({ nextstream: later, embedmaster: later }))
    render(<PlayerPanel item={movie} availability={on} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('alert')).toHaveTextContent('You’ve reached today’s streaming limit')
    expect(screen.queryByTitle('Fight Club player')).not.toBeInTheDocument()
    expect(fetchImpl).not.toHaveBeenCalled()
    // Another network may work: Try again clears the marks and plays.
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
    expect(localStorage.getItem('naijatr.streamLimit')).toBeNull()
  })

  it('tries a limited server when picked by hand, and clears its mark once it plays', async () => {
    serverTiming.startMs = 100
    localStorage.setItem('naijatr.streamLimit', JSON.stringify({ nextstream: Date.now() + 60 * 60_000 }))
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const two = await findPlayer('Fight Club player')
    expect(two).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`)
    post(two, 'duration', 6000)
    await userEvent.click(server('Server 1'))
    const one = await findPlayer('Fight Club player')
    expect(one).toHaveAttribute('src', '/api/play/movie/550')
    post(one, 'time', 3, 'https://embdmstrplayer.com')
    expect(localStorage.getItem('naijatr.streamLimit')).toBeNull()
  })

  it('stays put once the player reports in', async () => {
    serverTiming.startMs = 100
    localStorage.setItem('naijatr.playerServer', 'embedmaster')
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    post(await findPlayer('Fight Club player'), 'duration', 6000)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(screen.getByTitle('Fight Club player')).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`)
    expect(screen.queryByText(/Switched to/)).not.toBeInTheDocument()
  })

  it('offers only Server 1, with no switcher, without an EmbedMaster player id', async () => {
    vi.stubEnv('VITE_EMBEDMASTER_PLAYER_ID', '')
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    expect(screen.queryByRole('group', { name: 'Server' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('plays on EmbedMaster alone when NextStream isn’t set up', async () => {
    render(<PlayerPanel item={movie} availability={{ movie: false, tv: false }} fetchImpl={checks(true)} />)
    expect(screen.queryByRole('group', { name: 'Server' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await findPlayer('Fight Club player')).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`)
  })
})

describe('progress shared between Server 1 and Server 2', () => {
  const S1 = 'https://embdmstrplayer.com'
  const S2 = 'https://embedmaster.link'
  const seekTo = (value: number) => ({ source: 'embedmaster_player_command', command: 'seek', value })
  const commands = (frame: HTMLElement) =>
    vi.spyOn((frame as HTMLIFrameElement).contentWindow!, 'postMessage').mockImplementation(() => undefined)
  const saved = () => readContinueWatching()[0]

  it('S1E3: 20:00 on Server 1 → Server 2 from 20:00 → 25:00 → back to Server 1 from 25:00', async () => {
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await userEvent.selectOptions(screen.getByLabelText('Episode'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Play S1 E3' }))
    const one = await findPlayer('Game of Thrones player')
    expect(one).toHaveAttribute('src', '/api/play/tv/1399/1/3')
    post(one, 'duration', 3600, S1)
    post(one, 'time', 1190, S1)
    post(one, 'time', 1200, S1)
    // Within the 10-second throttle: not saved yet…
    expect(saved()).toMatchObject({ season: 1, episode: 3, progressSeconds: 1190 })

    await userEvent.click(server('Server 2'))
    // …but saved the moment the server is switched.
    expect(saved()).toMatchObject({ season: 1, episode: 3, progressSeconds: 1200 })
    const two = await findPlayer('Game of Thrones player')
    expect(two).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/tv/1399/1/3?${OPTIONS}`)
    const send = commands(two)
    post(two, 'duration', 3600)
    expect(send).toHaveBeenCalledWith(seekTo(1200), S2)
    // Its own early times (0, or the spot it remembers) don't count.
    post(two, 'time', 0)
    post(two, 'time', 300)
    expect(saved().progressSeconds).toBe(1200)
    post(two, 'time', 1201)
    post(two, 'time', 1500)
    post(two, 'pause')
    expect(saved()).toMatchObject({ season: 1, episode: 3, progressSeconds: 1500 })

    await userEvent.click(server('Server 1'))
    const back = await findPlayer('Game of Thrones player')
    expect(back).toHaveAttribute('src', '/api/play/tv/1399/1/3')
    const sendBack = commands(back)
    post(back, 'time', 0, S1)
    expect(sendBack).toHaveBeenCalledWith(seekTo(1500), S1)
    expect(saved()).toMatchObject({ season: 1, episode: 3, progressSeconds: 1500 })
    expect(readContinueWatching()).toHaveLength(1)
  })

  it('a smaller time right after the seek is sent back, not saved', async () => {
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const one = await findPlayer('Fight Club player')
    post(one, 'duration', 6000, S1)
    post(one, 'time', 1200, S1)
    await userEvent.click(server('Server 2'))
    const two = await findPlayer('Fight Club player')
    const send = commands(two)
    post(two, 'duration', 6000)
    post(two, 'time', 1200)
    // The player jumps back to a spot of its own just after.
    post(two, 'time', 400)
    post(two, 'pause')
    expect(saved().progressSeconds).toBe(1200)
    expect(send).toHaveBeenLastCalledWith(seekTo(1200), S2)
  })

  it('a movie resumes on the other server after a page reload (or from another device’s synced entry)', async () => {
    localStorage.setItem('naijatr.playerServer', 'embedmaster')
    const { unmount } = render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const two = await findPlayer('Fight Club player')
    post(two, 'duration', 6000)
    post(two, 'time', 1500)
    unmount()
    expect(saved().progressSeconds).toBe(1500)

    // Reloaded, and Server 1 picked this time.
    localStorage.setItem('naijatr.playerServer', 'nextstream')
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const one = await findPlayer('Fight Club player')
    expect(one).toHaveAttribute('src', '/api/play/movie/550')
    const send = commands(one)
    post(one, 'duration', 6000, S1)
    expect(send).toHaveBeenCalledWith(seekTo(1500), S1)
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
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Continue S1 E3' }))
    const one = await findPlayer('Game of Thrones player')
    expect(one).toHaveAttribute('src', '/api/play/tv/1399/1/3')
    const send = commands(one)
    post(one, 'duration', 3600, S1)
    expect(send).toHaveBeenCalledWith(seekTo(900), S1)
  })
})
