import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../types/media'
import { WorkerDownload } from './WorkerDownload'

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
}
const series: MediaItem = { ...movie, id: 'tmdb-series-1399', tmdbId: 1399, title: 'Dark', type: 'series' }
const ID = '1d384563-e3f2-4838-815d-96ebd429c8d7'
const FILE = `https://worker.example/download/file/${ID}?token=t0k`
const status = (state: string, extra = {}) => ({ state, progress: { done: 0, total: 0 }, error: null, filename: null, bytes: null, height: null, ...extra })

/** A server that starts the job, then answers each status poll with the next state. */
const server = (states: object[]) => {
  let i = 0
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/download/job') return Response.json({ id: ID, fileUrl: FILE, attribution: 'CC BY test' }, { status: 202 })
    if (init?.method === 'DELETE') return Response.json({ cancelled: true })
    return Response.json(states[Math.min(i++, states.length - 1)])
  })
}

describe('WorkerDownload', () => {
  it('starts a job with numbers only, shows progress, then the save link', async () => {
    const fetchImpl = server([status('downloading', { progress: { done: 16, total: 64 } }), status('remuxing'), status('ready', { filename: 'Dune.mp4', bytes: 66978277, height: 480 })])
    render(<WorkerDownload item={movie} fetchImpl={fetchImpl as never} />)
    await userEvent.selectOptions(screen.getByLabelText('Quality'), '480')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({ type: 'movie', tmdbId: 438631, quality: '480', title: 'Dune' })
    expect(await screen.findByText('Downloading… 25%')).toBeInTheDocument()
    expect(await screen.findByText('Preparing the file…', {}, { timeout: 3000 })).toBeInTheDocument()
    const save = await screen.findByRole('link', { name: /Save video \(64 MB\)/ }, { timeout: 4000 })
    expect(save).toHaveAttribute('href', FILE)
    expect(save).toHaveAttribute('download', 'Dune.mp4')
    expect(screen.getByText(/480p MP4/)).toBeInTheDocument()
    expect(screen.getByText('CC BY test')).toBeInTheDocument()
  })

  it('sends the chosen episode for a series', async () => {
    const fetchImpl = server([status('resolving')])
    render(<WorkerDownload item={series} fetchImpl={fetchImpl as never} />)
    await userEvent.clear(screen.getByLabelText('Episode'))
    await userEvent.type(screen.getByLabelText('Episode'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({ type: 'tv', tmdbId: 1399, season: 1, episode: 3 })
    expect(await screen.findByText('Finding the video…')).toBeInTheDocument()
  })

  it("shows the worker's error and lets the viewer retry", async () => {
    const fetchImpl = server([status('error', { error: 'no media found on the player page' })])
    render(<WorkerDownload item={movie} fetchImpl={fetchImpl as never} />)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no media found on the player page')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('says when the downloader is busy', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ reason: 'busy', message: 'The downloader is busy with another file. Try again in a few minutes.' }, { status: 429 }))
    render(<WorkerDownload item={movie} fetchImpl={fetchImpl as never} />)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('busy with another file')
  })

  it('cancels the job on the server', async () => {
    const fetchImpl = server([status('downloading', { progress: { done: 1, total: 64 } })])
    render(<WorkerDownload item={movie} fetchImpl={fetchImpl as never} />)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith(`/api/download/job/${ID}`, { method: 'DELETE' }))
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
  })
})
