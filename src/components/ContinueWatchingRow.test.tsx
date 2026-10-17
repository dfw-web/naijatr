import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { createLocalProvider } from '../data/localProvider'
import { CatalogProviderContext } from '../data/provider'
import type { MediaItem } from '../types/media'
import { readContinueWatching, recordPlay, recordProgress, requestResume } from '../utils/continueWatching'
import { ContinueWatchingRow } from './ContinueWatchingRow'
import { PlayerPanel } from './PlayerPanel'

const film: MediaItem = {
  id: 'tmdb-movie-550',
  tmdbId: 550,
  title: 'Fight Club',
  type: 'movie',
  year: 1999,
  releaseDate: null,
  genres: [],
  score: 8.4,
  voteCount: 1000,
  popularity: 1,
  description: '',
  poster: null,
  backdrop: 'https://image.tmdb.org/t/p/w1280/fc.jpg',
}
const show: MediaItem = {
  ...film,
  id: 'tmdb-series-1399',
  tmdbId: 1399,
  title: 'Game of Thrones',
  type: 'series',
  seasons: [
    { number: 1, name: 'Season 1', episodeCount: 10 },
    { number: 2, name: 'Season 2', episodeCount: 10 },
  ],
}

afterEach(() => vi.unstubAllGlobals())

describe('Continue watching row', () => {
  it('is hidden until something is played', () => {
    const { container } = render(<ContinueWatchingRow onSelect={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows one card per title, newest first, with the episode and progress, and ✕ removes it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'The Night Lands', still_path: '/still.jpg' }))))
    recordPlay(film, {}, 1000)
    recordProgress(film.id, {}, 1500, 6000, 1500)
    recordPlay(show, { season: 2, episode: 2 }, 2000)
    render(<ContinueWatchingRow onSelect={vi.fn()} />)

    const row = screen.getByRole('region', { name: 'Continue watching' })
    // The episode's name and still arrive from TMDB a moment later.
    await within(row).findByRole('button', { name: /The Night Lands/ })
    const cards = within(row).getAllByRole('button', { name: /^Continue watching / })
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Continue watching Game of Thrones, S2 · E2 – The Night Lands',
      'Continue watching Fight Club, 25% watched',
    ])
    expect(cards[0].querySelector('img')).toHaveAttribute('src', 'https://image.tmdb.org/t/p/w780/still.jpg')

    await userEvent.click(within(row).getByRole('button', { name: 'Remove Game of Thrones from Continue watching' }))
    expect(within(row).getAllByRole('button', { name: /^Continue watching / })).toHaveLength(1)
    await userEvent.click(within(row).getByRole('button', { name: 'Remove Fight Club from Continue watching' }))
    expect(screen.queryByRole('region', { name: 'Continue watching' })).not.toBeInTheDocument()
  })

  it('is the first row on the home page, and a card opens the title', async () => {
    recordPlay(film, {}, 1000)
    render(
      <CatalogProviderContext.Provider value={createLocalProvider({ latencyMs: 0 })}>
        <App />
      </CatalogProviderContext.Provider>,
    )
    await screen.findByRole('heading', { name: 'Trending Now' })
    const rows = screen.getAllByRole('region').filter((r) => r.classList.contains('media-row'))
    expect(rows[0]).toHaveAccessibleName('Continue watching')
    expect(rows[1]).toHaveAccessibleName('Trending Now')

    await userEvent.click(within(rows[0]).getByRole('button', { name: 'Continue watching Fight Club' }))
    expect(await screen.findByRole('dialog', { name: 'Fight Club' })).toBeInTheDocument()
  })
})

describe('resuming from a card', () => {
  const on = { movie: true, tv: true }
  const available = () =>
    vi.fn(async (url: string) =>
      url.startsWith('https://api.theintrodb.org/')
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ available: true })),
    ) as unknown as typeof fetch

  /** What the stream player posts to the top window as it plays. */
  const post = (frame: HTMLElement, event: string, info: number | null = null) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'embedmaster_player', event, info },
          source: (frame as HTMLIFrameElement).contentWindow,
        }),
      )
    })

  it('plays the saved episode straight away and seeks to the saved time', async () => {
    recordPlay(show, { season: 2, episode: 5 }, 1000)
    recordProgress(show.id, { season: 2, episode: 5 }, 1234, 3000, 2000)
    requestResume(readContinueWatching()[0])
    render(<PlayerPanel item={show} availability={on} fetchImpl={available()} />)

    const frame = await screen.findByTitle('Game of Thrones player', {}, { timeout: 5000 })
    expect(frame).toHaveAttribute('src', '/api/play/tv/1399/2/5')
    const player = (frame as HTMLIFrameElement).contentWindow!
    const send = vi.spyOn(player, 'postMessage').mockImplementation(() => {})
    post(frame, 'duration', 3000)
    post(frame, 'time', 1)
    expect(send).toHaveBeenCalledWith({ source: 'embedmaster_player_command', command: 'seek', value: 1234 }, '*')
  })

  it('saves progress from the player, and moves on to the next episode when it ends', async () => {
    recordPlay(show, { season: 1, episode: 10 }, 1000)
    requestResume(readContinueWatching()[0])
    render(<PlayerPanel item={show} availability={on} fetchImpl={available()} />)
    const frame = await screen.findByTitle('Game of Thrones player', {}, { timeout: 5000 })
    vi.spyOn((frame as HTMLIFrameElement).contentWindow!, 'postMessage').mockImplementation(() => {})

    post(frame, 'duration', 3000)
    post(frame, 'time', 600)
    expect(readContinueWatching()[0]).toMatchObject({ season: 1, episode: 10, progressSeconds: 600, durationSeconds: 3000 })
    // Saved at most every 10 seconds.
    post(frame, 'time', 605)
    expect(readContinueWatching()[0].progressSeconds).toBe(600)

    post(frame, 'ended')
    expect(readContinueWatching()[0]).toMatchObject({ season: 2, episode: 1, progressSeconds: null })
  })
})
