import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../types/media'
import { SERVER_START_TIMEOUT_MS } from '../config/players'
import { readContinueWatching } from '../utils/continueWatching'
import { PlayerPanel, serverTiming } from './PlayerPanel'

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
    expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('plays a movie on EmbedMaster with its options, no sandbox, and remembers the pick', async () => {
    const fetchImpl = checks(true)
    render(<PlayerPanel item={movie} availability={on} fetchImpl={fetchImpl} />)
    await userEvent.click(server('Server 2'))
    expect(localStorage.getItem('naijatr.playerServer')).toBe('embedmaster')
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const frame = await screen.findByTitle('Fight Club player')
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
    expect(await screen.findByTitle('Game of Thrones player')).toHaveAttribute(
      'src',
      `https://embedmaster.link/${PLAYER_ID}/tv/1399/1/2?${OPTIONS}`,
    )
  })

  it('switches the playing episode between servers, carrying on from the same point', async () => {
    render(<PlayerPanel item={show} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play S1 E1' }))
    const first = await screen.findByTitle('Game of Thrones player')
    expect(first).toHaveAttribute('src', '/api/play/tv/1399/1/1')
    post(first, 'time', 300, 'https://embdmstrplayer.com')

    await userEvent.click(server('Server 2'))
    const second = await screen.findByTitle('Game of Thrones player')
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
    const frame = await screen.findByTitle('Fight Club player')
    post(frame, 'duration', 6000)
    post(frame, 'time', 120)
    expect(readContinueWatching()[0]).toMatchObject({ id: 'tmdb-movie-550', progressSeconds: 120, durationSeconds: 6000 })
    post(frame, 'ended')
    expect(readContinueWatching()).toHaveLength(0)
  })

  it('moves to Server 2 by itself when Server 1 can’t play the title', async () => {
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(false)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    const frame = await screen.findByTitle('Fight Club player')
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
    expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
    // Server 1 is silent too: no switching back and forth.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(screen.getByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('stays put once the player reports in', async () => {
    serverTiming.startMs = 100
    localStorage.setItem('naijatr.playerServer', 'embedmaster')
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    post(await screen.findByTitle('Fight Club player'), 'duration', 6000)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(screen.getByTitle('Fight Club player')).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`)
    expect(screen.queryByText(/Switched to/)).not.toBeInTheDocument()
  })

  it('offers only Server 1, with no switcher, without an EmbedMaster player id', async () => {
    vi.stubEnv('VITE_EMBEDMASTER_PLAYER_ID', '')
    render(<PlayerPanel item={movie} availability={on} fetchImpl={checks(true)} />)
    expect(screen.queryByRole('group', { name: 'Server' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/movie/550')
  })

  it('plays on EmbedMaster alone when NextStream isn’t set up', async () => {
    render(<PlayerPanel item={movie} availability={{ movie: false, tv: false }} fetchImpl={checks(true)} />)
    expect(screen.queryByRole('group', { name: 'Server' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', `https://embedmaster.link/${PLAYER_ID}/movie/550?${OPTIONS}`)
  })
})
