import { useEffect, useState } from 'react'
import { AlertTriangle, Download, LoaderCircle, RotateCcw, X } from 'lucide-react'
import type { MediaItem } from '../types/media'
import './WorkerDownload.css'

type JobState = 'queued' | 'resolving' | 'downloading' | 'remuxing' | 'ready' | 'error'

interface JobStatus {
  state: JobState
  progress: { done: number; total: number }
  error: string | null
  filename: string | null
  bytes: number | null
  height: number | null
}

type Run =
  | { status: 'starting' }
  | { status: 'running'; id: string; fileUrl: string; attribution: string | null; job: JobStatus | null }
  | { status: 'error'; message: string }

const QUALITIES = [
  { value: 'best', label: 'Best' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
  { value: 'worst', label: 'Smallest' },
]

const POLL_MS = 2000
const GENERIC_ERROR = 'The download could not be prepared. Try again.'

// One function for every render, so the polling effect isn't restarted.
const defaultFetch: typeof fetch = (input, init) => fetch(input, init)

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`

/** What the job is doing, in words. */
function describeJob(job: JobStatus | null) {
  if (!job || job.state === 'queued' || job.state === 'resolving') return 'Finding the video…'
  if (job.state === 'downloading') {
    const { done, total } = job.progress
    return total > 1 ? `Downloading… ${Math.floor((done / total) * 100)}%` : 'Downloading…'
  }
  if (job.state === 'remuxing') return 'Preparing the file…'
  return ''
}

interface WorkerDownloadProps {
  item: MediaItem
  fetchImpl?: typeof fetch
}

/**
 * Download: the server (/api/download/job) has the naijatr-download-worker
 * prepare an MP4 for this title, shows its progress, then hands over the
 * job's own file link to save. The worker key never reaches the browser.
 */
export function WorkerDownload({ item, fetchImpl = defaultFetch }: WorkerDownloadProps) {
  const isSeries = item.type === 'series'
  // What the viewer typed; read as a number (at least 1) when used.
  const [seasonText, setSeasonText] = useState('1')
  const [episodeText, setEpisodeText] = useState('1')
  const season = Math.max(1, Number(seasonText) || 1)
  const episode = Math.max(1, Number(episodeText) || 1)
  const [quality, setQuality] = useState('best')
  const key = `${item.id}:${isSeries ? `${season}:${episode}` : ''}:${quality}`
  const [current, setCurrent] = useState<{ key: string; run: Run | null }>({ key, run: null })
  // Another title, episode or quality starts over.
  const run = current.key === key ? current.run : null
  const set = (next: Run | null) => setCurrent({ key, run: next })

  const runId = run?.status === 'running' ? run.id : null
  const finished = run?.status === 'running' && run.job?.state === 'ready'

  useEffect(() => {
    if (!runId || finished) return
    let stopped = false
    const poll = async () => {
      try {
        const response = await fetchImpl(`/api/download/job/${runId}`)
        const body = (await response.json().catch(() => null)) as (JobStatus & { reason?: string; message?: string }) | null
        if (stopped) return
        if (response.status === 404) return setCurrent((c) => ({ ...c, run: { status: 'error', message: 'This download expired. Start it again.' } }))
        if (!response.ok || !body) return
        if (body.state === 'error') return setCurrent((c) => ({ ...c, run: { status: 'error', message: body.error || GENERIC_ERROR } }))
        setCurrent((c) => (c.run?.status === 'running' && c.run.id === runId ? { ...c, run: { ...c.run, job: body } } : c))
      } catch {
        // A missed poll; the next one tries again.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [runId, finished, fetchImpl])

  const start = async () => {
    set({ status: 'starting' })
    try {
      const response = await fetchImpl('/api/download/job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: isSeries ? 'tv' : 'movie',
          tmdbId: item.tmdbId,
          ...(isSeries ? { season, episode } : {}),
          quality,
          title: item.title,
        }),
      })
      const body = (await response.json().catch(() => null)) as
        | { id?: string; fileUrl?: string; attribution?: string | null; message?: string }
        | null
      if (response.ok && body?.id && body.fileUrl) {
        set({ status: 'running', id: body.id, fileUrl: body.fileUrl, attribution: body.attribution ?? null, job: null })
      } else {
        set({ status: 'error', message: body?.message || GENERIC_ERROR })
      }
    } catch {
      set({ status: 'error', message: GENERIC_ERROR })
    }
  }

  const cancel = () => {
    if (run?.status === 'running') void fetchImpl(`/api/download/job/${run.id}`, { method: 'DELETE' }).catch(() => undefined)
    set(null)
  }

  const busy = run?.status === 'starting' || (run?.status === 'running' && !finished)
  const job = run?.status === 'running' ? run.job : null
  const percent = job?.state === 'downloading' && job.progress.total > 1 ? (job.progress.done / job.progress.total) * 100 : null

  return (
    <section className="worker-download" aria-label="Download">
      <div className="worker-download__pickers">
        {isSeries && (
          <>
            <label>
              Season
              <input type="number" min={1} max={99} value={seasonText} disabled={busy} onChange={(e) => setSeasonText(e.target.value.replace(/\D/g, '').slice(0, 2))} />
            </label>
            <label>
              Episode
              <input type="number" min={1} max={999} value={episodeText} disabled={busy} onChange={(e) => setEpisodeText(e.target.value.replace(/\D/g, '').slice(0, 3))} />
            </label>
          </>
        )}
        <label>
          Quality
          <select value={quality} disabled={busy} onChange={(e) => setQuality(e.target.value)}>
            {QUALITIES.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!run && (
        <button type="button" className="btn btn--ghost worker-download__start" onClick={() => void start()}>
          <Download aria-hidden="true" /> Download
        </button>
      )}

      {busy && (
        <div className="worker-download__progress" role="status">
          <p>
            <LoaderCircle className="worker-download__spin" aria-hidden="true" />
            {run?.status === 'starting' ? 'Starting the download…' : describeJob(job)}
          </p>
          <progress max={100} value={percent ?? undefined} aria-label="Download progress" />
          <p className="worker-download__hint">The file is prepared on our server first. Keep this page open.</p>
          {run?.status === 'running' && (
            <button type="button" className="btn btn--ghost" onClick={cancel}>
              <X aria-hidden="true" /> Cancel
            </button>
          )}
        </div>
      )}

      {finished && run?.status === 'running' && (
        <div className="worker-download__ready">
          <a className="btn btn--primary" href={run.fileUrl} download={job?.filename ?? true}>
            <Download aria-hidden="true" /> Save video{job?.bytes ? ` (${formatBytes(job.bytes)})` : ''}
          </a>
          <p className="worker-download__hint">
            {job?.height ? `${job.height}p MP4. ` : 'MP4. '}The link works once, for the next hour.
          </p>
          {run.attribution && <p className="worker-download__credit">{run.attribution}</p>}
        </div>
      )}

      {run?.status === 'error' && (
        <p className="worker-download__error" role="alert">
          <AlertTriangle aria-hidden="true" /> {run.message}
          <button type="button" className="btn btn--ghost" onClick={() => void start()}>
            <RotateCcw aria-hidden="true" /> Try again
          </button>
        </p>
      )}
    </section>
  )
}
