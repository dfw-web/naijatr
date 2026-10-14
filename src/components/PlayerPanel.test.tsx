import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../types/media'
import { NEXT_EPISODE_DELAY_S, PLAYER_LOAD_TIMEOUT_MS, PlayerPanel } from './PlayerPanel'

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
    // `*` so fullscreen still works after /api/play redirects to another host.
    expect(frame.getAttribute('allow')).toContain('fullscreen *')
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

    it('counts down and then plays the next season when the last episode ends', async () => {
      const frame = await watch('2')
      vi.useFakeTimers()
      try {
        end(frame)
        expect(screen.getByRole('button', { name: /Next episode · S2 E1/ })).toBeInTheDocument()
        await act(async () => {
          vi.advanceTimersByTime(NEXT_EPISODE_DELAY_S * 1000)
        })
      } finally {
        vi.useRealTimers()
      }
      expect(await screen.findByTitle('Fight Club player')).toHaveAttribute(
        'src',
        '/api/play/tv/1399/2/1',
      )
      expect(screen.getByLabelText('Season')).toHaveValue('2')
    })

    it('shows the button when the closing credits start', async () => {
      // Opening credits early on don't count.
      const frame = await watch('1', [
        { start_ms: 60_000, end_ms: 90_000 },
        { start_ms: 3_000_000, end_ms: null },
      ])
      post(frame, 'duration', 3_300)
      post(frame, 'time', 70)
      post(frame, 'time', 2_999)
      expect(screen.queryByRole('button', { name: /Next episode/ })).not.toBeInTheDocument()
      post(frame, 'time', 3_001)
      expect(screen.getByRole('button', { name: /Next episode · S1 E2/ })).toBeInTheDocument()
    })

    it('guesses 90 seconds before the end when the credits time is unknown', async () => {
      const frame = await watch('1')
      post(frame, 'duration', 3_000)
      post(frame, 'time', 2_909)
      expect(screen.queryByRole('button', { name: /Next episode/ })).not.toBeInTheDocument()
      post(frame, 'time', 2_911)
      expect(screen.getByRole('button', { name: /Next episode/ })).toBeInTheDocument()
    })

    it('stays dismissed through the rest of the credits and the end', async () => {
      const frame = await watch('1')
      post(frame, 'duration', 3_000)
      post(frame, 'time', 2_950)
      fireEvent.pointerDown(document.body)
      post(frame, 'time', 2_960)
      end(frame)
      expect(screen.queryByRole('button', { name: /Next episode/ })).not.toBeInTheDocument()
    })

    it('plays the next episode right away when the button is clicked', async () => {
      end(await watch('1'))
      await userEvent.click(screen.getByRole('button', { name: /Next episode · S1 E2/ }))
      expect(await screen.findByTitle('Fight Club player')).toHaveAttribute(
        'src',
        '/api/play/tv/1399/1/2',
      )
    })

    it('stays on the episode when anything else is clicked', async () => {
      const frame = await watch('1')
      vi.useFakeTimers()
      try {
        end(frame)
        fireEvent.pointerDown(document.querySelector('.player__upnext')!)
        expect(screen.queryByRole('button', { name: /Next episode/ })).not.toBeInTheDocument()
        await act(async () => {
          vi.advanceTimersByTime(NEXT_EPISODE_DELAY_S * 1000)
        })
      } finally {
        vi.useRealTimers()
      }
      expect(screen.getByTitle('Fight Club player')).toHaveAttribute('src', '/api/play/tv/1399/1/1')
    })

    it('ignores ended messages from other frames', async () => {
      const frame = await watch('1')
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { data: { source: 'embedmaster_player', event: 'ended' } }),
        )
      })
      expect(screen.queryByRole('button', { name: /Next episode/ })).not.toBeInTheDocument()
      end(frame)
      expect(screen.getByRole('button', { name: /Next episode/ })).toBeInTheDocument()
    })
  })
})
