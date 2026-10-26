import { useState } from 'react'
import { AlertTriangle, Download, RotateCcw } from 'lucide-react'
import type { MediaItem } from '../types/media'
import './DownloadButton.css'

interface DownloadOption {
  quality: string
  size: string | null
  filename: string | null
  language: string | null
  url: string
}

type DownloadState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'open'; label: string | null; options: DownloadOption[] }
  | { status: 'unavailable' }
  | { status: 'error' }

interface DownloadButtonProps {
  item: MediaItem
  /** The selected episode, for a series. */
  season?: number
  episode?: number
  fetchImpl?: typeof fetch
}

/** Minutes from a movie's "2h 14m" length. */
const minutesOf = (length?: string) => {
  const match = length ? /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(length.trim()) : null
  return match && (match[1] || match[2]) ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : null
}

/**
 * Download beside Play: asks /api/download/options (the MovieBox Worker,
 * server-side) for this title's files, then lists their qualities. Playback
 * doesn't depend on it in any way.
 */
export function DownloadButton({ item, season, episode, fetchImpl = fetch.bind(globalThis) }: DownloadButtonProps) {
  const isSeries = item.type === 'series'
  const key = `${item.id}:${isSeries ? `${season}:${episode}` : ''}`
  const [current, setCurrent] = useState<{ key: string; state: DownloadState }>({ key, state: { status: 'idle' } })
  // Another title or episode starts over.
  const state = current.key === key ? current.state : ({ status: 'idle' } as const)
  const set = (next: DownloadState) => setCurrent({ key, state: next })

  const load = async () => {
    set({ status: 'checking' })
    const params = new URLSearchParams({
      movieId: String(item.tmdbId ?? item.id),
      title: item.title,
      type: item.type,
    })
    if (item.originalTitle) params.set('originalTitle', item.originalTitle)
    if (item.year) params.set('year', String(item.year))
    if (isSeries && season && episode) {
      params.set('season', String(season))
      params.set('episode', String(episode))
    }
    const runtime = isSeries ? null : minutesOf(item.length)
    if (runtime) params.set('runtime', String(runtime))
    if (item.originCountry?.length) params.set('country', item.originCountry.join(','))
    try {
      const response = await fetchImpl(`/api/download/options?${params}`)
      const body = (await response.json().catch(() => null)) as
        | { available?: boolean; label?: string | null; options?: DownloadOption[]; reason?: string }
        | null
      if (body?.available && body.options?.length) {
        setCurrent({ key, state: { status: 'open', label: body.label ?? null, options: body.options } })
      } else if (!response.ok || !body || body.reason === 'error') {
        setCurrent({ key, state: { status: 'error' } })
      } else {
        setCurrent({ key, state: { status: 'unavailable' } })
      }
    } catch {
      setCurrent({ key, state: { status: 'error' } })
    }
  }

  const checking = state.status === 'checking'
  const label = isSeries && season && episode ? `Download S${season} E${episode}` : 'Download'

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => (state.status === 'open' ? set({ status: 'idle' }) : void load())}
        disabled={checking}
        aria-expanded={state.status === 'open'}
      >
        <Download aria-hidden="true" />
        {checking ? 'Checking downloads…' : label}
      </button>
      {state.status === 'open' && (
        <div className="download-sheet" role="region" aria-label="Download options">
          <p className="download-sheet__title">
            Choose a quality{state.label ? <> · <strong>{state.label}</strong></> : null}
          </p>
          <ul className="download-sheet__list">
            {state.options.map((option) => (
              <li key={option.url}>
                <a
                  className="download-sheet__option"
                  href={option.url}
                  target="_blank"
                  rel="noopener"
                  download={option.filename ?? ''}
                >
                  <Download aria-hidden="true" />
                  <span>
                    {option.quality}
                    {option.size && ` — ${option.size}`}
                  </span>
                  {(option.language || option.filename) && (
                    <small>{[option.language, option.filename].filter(Boolean).join(' · ')}</small>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.status === 'unavailable' && (
        <p className="download-sheet__note" role="status">
          Download unavailable for this title.
        </p>
      )}
      {state.status === 'error' && (
        <p className="download-sheet__note" role="alert">
          <AlertTriangle aria-hidden="true" />
          Couldn’t load download options. Try again.
          <button type="button" className="btn btn--ghost" onClick={() => void load()}>
            <RotateCcw aria-hidden="true" /> Retry
          </button>
        </p>
      )}
    </>
  )
}
