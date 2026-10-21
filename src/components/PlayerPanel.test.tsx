import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../types/media'
import { PLAYER_LOAD_TIMEOUT_MS, PlayerPanel } from './PlayerPanel'

const base: MediaItem = {
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
const withTrailer: MediaItem = { ...base, trailer: { key: 'SUXWAEX2jlg', name: 'Official Trailer' } }
const series: MediaItem = { ...withTrailer, id: 'tmdb-series-1399', tmdbId: 1399, type: 'series' }
// Matched to the curated list by TMDB id.
const archiveFilm: MediaItem = {
  ...withTrailer,
  id: 'tmdb-movie-10331',
  tmdbId: 10331,
  title: 'Night of the Living Dead',
}
// Matched by title and year, without a TMDB id.
const blenderFilm: MediaItem = {
  ...base,
  id: 'local-bbb',
  tmdbId: undefined,
  title: 'Big Buck Bunny',
  year: 2008,
}

const on = { movie: true, tv: true }
const off = { movie: false, tv: false }
const reply = (body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body))) as unknown as typeof fetch

describe('PlayerPanel', () => {
  it('explains when there is no source, and while the trailer is still loading', () => {
    const { rerender } = render(<PlayerPanel item={base} />)
    expect(screen.getByText(/No trailer or free full movie/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    rerender(<PlayerPanel item={base} isLoading />)
    expect(screen.getByRole('status')).toHaveTextContent('Looking for a trailer')
  })

  it('plays the official trailer through youtube-nocookie, then closes', async () => {
    render(<PlayerPanel item={withTrailer} />)
    expect(screen.queryByRole('button', { name: /Watch Free/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Play Trailer/ }))
    const frame = screen.getByTitle('Fight Club trailer')
    expect(frame.getAttribute('src')).toBe(
      'https://www.youtube-nocookie.com/embed/SUXWAEX2jlg?autoplay=1&rel=0',
    )
    expect(screen.queryByText(/Subtitles:/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading player')
    fireEvent.load(frame)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Close player/ }))
    expect(screen.queryByTitle('Fight Club trailer')).not.toBeInTheDocument()
  })

  it('offers trailers for series too', () => {
    render(<PlayerPanel item={series} />)
    expect(screen.getByRole('button', { name: /Play Trailer/ })).toBeInTheDocument()
  })

  it('plays a public-domain film in the Internet Archive embed, with the trailer as an option', async () => {
    render(<PlayerPanel item={archiveFilm} />)
    expect(screen.getByRole('button', { name: /Play Trailer/ })).toBeInTheDocument()
    expect(screen.getByText(/Public domain/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Watch Free/ }))
    expect(screen.getByTitle('Night of the Living Dead full movie')).toHaveAttribute(
      'src',
      'https://archive.org/embed/night_of_the_living_dead',
    )
  })

  it('plays a Blender open movie as a direct video file and reports playback errors', async () => {
    render(<PlayerPanel item={blenderFilm} />)
    await userEvent.click(screen.getByRole('button', { name: /Watch Free/ }))
    const video = screen.getByTitle('Big Buck Bunny full movie')
    expect(video.tagName).toBe('VIDEO')
    expect(video.querySelector('source')?.getAttribute('src')).toMatch(
      /^https:\/\/download\.blender\.org\//,
    )
    fireEvent.error(video)
    expect(screen.getByRole('alert')).toHaveTextContent('couldn’t be played')
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(screen.getByTitle('Big Buck Bunny full movie')).toBeInTheDocument()
  })

  it('hides NextStream when it is not configured or the title is a sample', () => {
    const { rerender } = render(<PlayerPanel item={base} availability={off} />)
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()
    rerender(<PlayerPanel item={{ ...base, tmdbId: undefined }} availability={on} />)
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()
  })

  it('checks NextStream availability, then loads the movie player by TMDB id', async () => {
    const fetchImpl = reply({ available: true })
    render(<PlayerPanel item={withTrailer} availability={on} fetchImpl={fetchImpl} />)
    expect(screen.getByRole('button', { name: /Play Trailer/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(fetchImpl).toHaveBeenCalledWith('/api/play/movie/550?check=1')
    const frame = await screen.findByTitle('Fight Club player')
    expect(frame).toHaveAttribute('src', '/api/play/movie/550')
    // `*` so autoplay still works after /api/play redirects to another host.
    expect(frame.getAttribute('allow')).toContain('autoplay *')
    // Fullscreen goes through ours, which keeps Skip and Close on screen.
    expect(frame.getAttribute('allow')).not.toContain('fullscreen')
    expect(frame).not.toHaveAttribute('allowfullscreen')
    expect(screen.getByText(/Subtitles: tap the CC button/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading player')
    fireEvent.load(frame)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('streams the chosen season and episode of a series', async () => {
    const fetchImpl = reply({ available: true })
    const withSeasons: MediaItem = {
      ...series,
      seasons: [
        { number: 1, name: 'Season 1', episodeCount: 10 },
        { number: 2, name: 'Season 2', episodeCount: 3 },
      ],
    }
    render(<PlayerPanel item={withSeasons} availability={on} fetchImpl={fetchImpl} />)
    await userEvent.selectOptions(screen.getByLabelText('Season'), '2')
    expect(screen.getAllByRole('option', { name: /^Episode/ })).toHaveLength(3)
    await userEvent.selectOptions(screen.getByLabelText('Episode'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Play S2 E3' }))
    expect(await screen.findByTitle('Fight Club player')).toHaveAttribute(
      'src',
      '/api/play/tv/1399/2/3',
    )
  })

  it('remembers the last episode played and offers to continue it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ available: true }))) as unknown as typeof fetch
    const withSeasons: MediaItem = {
      ...series,
      seasons: [
        { number: 1, name: 'Season 1', episodeCount: 10 },
        { number: 2, name: 'Season 2', episodeCount: 3 },
      ],
    }
    const first = render(<PlayerPanel item={withSeasons} availability={on} fetchImpl={fetchImpl} />)
    expect(screen.queryByText(/You were watching/)).not.toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Season'), '2')
    await userEvent.selectOptions(screen.getByLabelText('Episode'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Play S2 E3' }))
    await screen.findByTitle('Fight Club player')
    first.unmount()

    // Another series has no history of its own.
    const other = render(
      <PlayerPanel item={{ ...withSeasons, id: 'tmdb-series-1', tmdbId: 1 }} availability={on} fetchImpl={fetchImpl} />,
    )
    expect(screen.queryByText(/You were watching/)).not.toBeInTheDocument()
    other.unmount()

    render(<PlayerPanel item={withSeasons} availability={on} fetchImpl={fetchImpl} />)
    expect(screen.getByText(/You were watching/)).toHaveTextContent('You were watching S2 E3. Continue where you left off?')
    await userEvent.click(screen.getByRole('button', { name: 'Continue S2 E3' }))
    expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/tv/1399/2/3')
    expect(screen.getByLabelText('Season')).toHaveValue('2')
    expect(screen.getByLabelText('Episode')).toHaveValue('3')
    expect(screen.queryByText(/You were watching/)).not.toBeInTheDocument()
  })

  it('lets the viewer dismiss the continue prompt, and ignores movies and unplayable episodes', async () => {
    window.localStorage.setItem('naijatr:last-episode:tmdb-series-1399', JSON.stringify({ season: 1, episode: 4 }))
    window.localStorage.setItem('naijatr:last-episode:tmdb-movie-550', JSON.stringify({ season: 1, episode: 4 }))
    const movie = render(<PlayerPanel item={base} availability={on} />)
    expect(screen.queryByText(/You were watching/)).not.toBeInTheDocument()
    movie.unmount()

    const unavailable = reply({ available: false, reason: 'not-found' })
    render(<PlayerPanel item={series} availability={on} fetchImpl={unavailable} />)
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText(/You were watching/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Play S1 E1' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    // S1 E1 never played, so S1 E4 is still the one remembered.
    expect(JSON.parse(window.localStorage.getItem('naijatr:last-episode:tmdb-series-1399') ?? '')).toEqual({
      season: 1,
      episode: 4,
    })
  })

  it('shows a NextStream error with retry when the video is unavailable', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ available: false, reason: 'not-found' })))
      .mockRejectedValueOnce(new Error('offline')) as unknown as typeof fetch
    render(<PlayerPanel item={base} availability={on} fetchImpl={fetchImpl} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('isn’t available to stream')
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t be reached')
    expect(screen.queryByTitle('Fight Club player')).not.toBeInTheDocument()
  })

  it('times out a player that never loads', () => {
    vi.useFakeTimers()
    try {
      render(<PlayerPanel item={withTrailer} />)
      fireEvent.click(screen.getByRole('button', { name: /Play Trailer/ }))
      act(() => {
        vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS)
      })
      expect(screen.getByRole('alert')).toHaveTextContent('took too long')
      expect(screen.queryByTitle('Fight Club trailer')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('next episode', () => {
    const show: MediaItem = {
      ...series,
      seasons: [
        { number: 1, name: 'Season 1', episodeCount: 2 },
        { number: 2, name: 'Season 2', episodeCount: 3 },
      ],
    }
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
    const end = (frame: HTMLElement) => post(frame, 'ended')

    /** Plays S1 E{episode}; `credits` is what TheIntroDB knows about it. */
    const watch = async (episode: string, credits?: { start_ms: number; end_ms: number | null }[]) => {
      // A fresh response per call: the next episode is checked too.
      const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
        url.startsWith('https://api.theintrodb.org/')
          ? credits
            ? new Response(JSON.stringify({ credits }))
            : new Response(JSON.stringify({ error: 'media not found' }), { status: 404 })
          : new Response(JSON.stringify({ available: true })),
      ) as unknown as typeof fetch
      render(<PlayerPanel item={show} availability={on} fetchImpl={fetchImpl} />)
      await userEvent.selectOptions(screen.getByLabelText('Episode'), episode)
      await userEvent.click(screen.getByRole('button', { name: `Play S1 E${episode}` }))
      return screen.findByTitle('Fight Club player')
    }

    it('stays on the episode when it ends, with no countdown', async () => {
      const frame = await watch('2')
      vi.useFakeTimers()
      try {
        end(frame)
        await act(async () => {
          vi.advanceTimersByTime(30_000)
        })
      } finally {
        vi.useRealTimers()
      }
      expect(screen.queryByRole('button', { name: /Next episode/ })).not.toBeInTheDocument()
      expect(screen.getByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/tv/1399/1/2')
    })

    it('can skip to the next episode at any time, keeping the player up while it loads', async () => {
      const frame = await watch('1')
      post(frame, 'time', 30)
      await userEvent.click(screen.getByRole('button', { name: 'Skip to S1 E2' }))
      // No trip back to the Play buttons in between (that would leave fullscreen).
      expect(screen.queryByRole('button', { name: /^Play S/ })).not.toBeInTheDocument()
      expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/tv/1399/1/2')
      expect(screen.getByLabelText('Episode')).toHaveValue('2')
      // The last episode of a season skips to the next season.
      await userEvent.click(screen.getByRole('button', { name: 'Skip to S2 E1' }))
      expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/tv/1399/2/1')
    })

    it('has no Skip on the last episode', async () => {
      render(<PlayerPanel item={show} availability={on} fetchImpl={reply({ available: true })} />)
      await userEvent.selectOptions(screen.getByLabelText('Season'), '2')
      await userEvent.selectOptions(screen.getByLabelText('Episode'), '3')
      await userEvent.click(screen.getByRole('button', { name: 'Play S2 E3' }))
      await screen.findByTitle('Fight Club player')
      expect(screen.queryByRole('button', { name: /^Skip to/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument()
    })

    it('goes fullscreen with the Skip button, and stays fullscreen on the next episode', async () => {
      const doc = document as Document & { fullscreenEnabled: boolean; fullscreenElement: Element | null }
      let current: Element | null = null
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current })
      const change = (el: Element | null) => {
        current = el
        document.dispatchEvent(new Event('fullscreenchange'))
      }
      const request = vi.fn(function (this: Element) {
        change(this)
        return Promise.resolve()
      })
      const { requestFullscreen } = HTMLElement.prototype
      const { exitFullscreen } = document
      HTMLElement.prototype.requestFullscreen = request
      document.exitFullscreen = vi.fn(() => {
        change(null)
        return Promise.resolve()
      })
      try {
        await watch('1')
        await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
        const section = screen.getByRole('region', { name: 'Watch' })
        expect(request.mock.contexts).toEqual([section])
        expect(doc.fullscreenElement).toBe(section)
        // The Skip button is inside what went fullscreen.
        const skip = screen.getByRole('button', { name: 'Skip to S1 E2' })
        expect(section).toContainElement(skip)
        await userEvent.click(skip)
        expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/tv/1399/1/2')
        expect(doc.fullscreenElement).toBe(section)
        await userEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }))
        expect(doc.fullscreenElement).toBeNull()
        expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument()
      } finally {
        HTMLElement.prototype.requestFullscreen = requestFullscreen
        document.exitFullscreen = exitFullscreen
        delete (document as Partial<typeof doc>).fullscreenEnabled
        delete (document as Partial<typeof doc>).fullscreenElement
      }
    })

    it('fills the window where only videos can go fullscreen (iPhone), and Escape leaves it', async () => {
      await watch('1')
      const section = screen.getByRole('region', { name: 'Watch' })
      await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
      expect(section).toHaveClass('player--fill')
      await userEvent.click(screen.getByRole('button', { name: 'Skip to S1 E2' }))
      expect(await screen.findByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/tv/1399/1/2')
      expect(section).toHaveClass('player--fill')
      await userEvent.keyboard('{Escape}')
      expect(section).not.toHaveClass('player--fill')
      expect(screen.getByTitle('Fight Club player')).toBeInTheDocument()
    })
  })
})
