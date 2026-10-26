import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../types/media'
import { DownloadButton } from './DownloadButton'

const movie: MediaItem = {
  id: 'tmdb-movie-438631',
  tmdbId: 438631,
  title: 'Dune',
  type: 'movie',
  year: 2021,
  releaseDate: '2021-09-15',
  genres: [],
  score: 8,
  voteCount: 1,
  popularity: 1,
  description: '',
  poster: null,
  backdrop: null,
  length: '2h 35m',
  originCountry: ['US'],
}
const series: MediaItem = { ...movie, id: 'tmdb-series-1399', tmdbId: 1399, title: 'Dark', type: 'series', length: undefined }

describe('DownloadButton', () => {
  it('asks for the options and lists the qualities', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        available: true,
        label: null,
        options: [
          { quality: '1080p', size: '1.8 GB', filename: null, language: null, url: 'https://cdn.example/1080.mp4' },
          { quality: '720p', size: '950 MB', filename: 'Dune.720p.mp4', language: 'English', url: 'https://cdn.example/720.mp4' },
        ],
      }),
    )
    render(<DownloadButton item={movie} fetchImpl={fetchImpl as never} />)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))

    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]), 'http://x')
    expect(url.pathname).toBe('/api/download/options')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      movieId: '438631',
      title: 'Dune',
      type: 'movie',
      year: '2021',
      runtime: '155',
      country: 'US',
    })
    expect(screen.getByRole('link', { name: /1080p — 1\.8 GB/ })).toHaveAttribute('href', 'https://cdn.example/1080.mp4')
    expect(screen.getByRole('link', { name: /720p — 950 MB/ })).toHaveTextContent('English · Dune.720p.mp4')
  })

  it('sends the episode for a series', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ available: false, reason: 'no-downloads' }))
    render(<DownloadButton item={series} season={2} episode={5} fetchImpl={fetchImpl as never} />)
    await userEvent.click(screen.getByRole('button', { name: 'Download S2 E5' }))
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]), 'http://x')
    expect(url.searchParams.get('season')).toBe('2')
    expect(url.searchParams.get('episode')).toBe('5')
    expect(await screen.findByText('Download unavailable for this title.')).toBeInTheDocument()
  })

  it('offers a retry when the options could not be loaded', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ available: false, reason: 'error' }, { status: 502 }))
      .mockRejectedValueOnce(new Error('offline'))
    render(<DownloadButton item={movie} fetchImpl={fetchImpl as never} />)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load download options. Try again.')
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
