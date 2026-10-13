import { useEffect, useState } from 'react'
import { AlertTriangle, Clapperboard, Download, Play, RotateCcw, X } from 'lucide-react'
import { findFreeMovie, freeSourceUrl, type FreeMovie } from '../data/freeMovies'
import type { MediaItem, Trailer } from '../types/media'
import './PlayerPanel.css'

export interface PlaybackAvailability {
  movie: boolean
  tv: boolean
}

interface PlayerPanelProps {
  item: MediaItem
  /** True while details (and so the trailer) are still loading. */
  isLoading?: boolean
  /** NextStream flags; defaults to the build-time values from vite.config.ts. Tests pass their own. */
  availability?: PlaybackAvailability
  /** Download flags; defaults to the build-time values from vite.config.ts. */
  downloads?: PlaybackAvailability
  fetchImpl?: typeof fetch
}

type Choice = 'stream' | 'free' | 'trailer'

type PlayerState =
  | { status: 'checking' }
  | { status: 'loading' }
  | { status: 'playing' }
  | { status: 'error'; message: string }

interface Run {
  itemId: string
  choice: Choice
  /** NextStream URL the run belongs to; changing season or episode stops it. */
  streamSrc: string | null
  attempt: number
  state: PlayerState
}

/** How long a player may take to load before we call it failed. */
export const PLAYER_LOAD_TIMEOUT_MS = 20000

const TIMEOUT_MESSAGE = 'The player took too long to load. Please try again.'

const STREAM_MESSAGES: Record<string, string> = {
  'not-found': 'This title isn’t available to stream right now.',
  'not-configured': 'Playback isn’t configured on this server.',
  unreachable: 'The streaming service couldn’t be reached. Please try again.',
  'upstream-error': 'The streaming service returned an error. Please try again.',
}

/**
 * Sandbox for the NextStream player: everything it needs to play, but no
 * `allow-popups` or `allow-top-navigation`, so it (and the frames it nests)
 * cannot open ad tabs or redirect our page.
 */
export const STREAM_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-presentation allow-orientation-lock'

const trailerUrl = (trailer: Trailer) =>
  `https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.key)}?autoplay=1&rel=0`

export function PlayerPanel({
  item,
  isLoading = false,
  availability = __PLAYBACK_ENABLED__,
  downloads = __DOWNLOAD_ENABLED__,
  fetchImpl = fetch.bind(globalThis),
}: PlayerPanelProps) {
  const isSeries = item.type === 'series'
  const free = findFreeMovie(item)
  const trailer = item.trailer ?? null

  // NextStream season/episode selection.
  const seasons = item.seasons ?? []
  const [selected, setSelected] = useState({ season: 1, episode: 1 })
  const validSeason = seasons.length === 0 || seasons.some((s) => s.number === selected.season)
  const season = validSeason ? selected.season : seasons[0].number
  const episode = validSeason ? selected.episode : 1
  const episodeCount = seasons.find((s) => s.number === season)?.episodeCount ?? 0
  const streamEnabled = (isSeries ? availability.tv : availability.movie) && item.tmdbId !== undefined
  const streamSrc = !streamEnabled
    ? null
    : isSeries
      ? `/api/play/tv/${item.tmdbId}/${season}/${episode}`
      : `/api/play/movie/${item.tmdbId}`

  const downloadEnabled = (isSeries ? downloads.tv : downloads.movie) && item.tmdbId !== undefined
  const downloadSrc = !downloadEnabled
    ? null
    : isSeries
      ? `/api/download/tv/${item.tmdbId}/${season}/${episode}`
      : `/api/download/movie/${item.tmdbId}`
  const freeDownload =
    free &&
    (free.source.kind === 'file'
      ? free.source.url
      : `https://archive.org/download/${encodeURIComponent(free.source.identifier)}`)

  // One run per title (and per episode for streams); anything else resets the player.
  const [run, setRun] = useState<Run | null>(null)
  const active =
    run && run.itemId === item.id && (run.choice !== 'stream' || run.streamSrc === streamSrc)
      ? run
      : null

  const loadingKey = active?.state.status === 'loading' ? `${active.choice}-${active.attempt}` : null
  useEffect(() => {
    if (!loadingKey) return
    const timer = window.setTimeout(
      () =>
        setRun((r) =>
          r && r.state.status === 'loading'
            ? { ...r, state: { status: 'error', message: TIMEOUT_MESSAGE } }
            : r,
        ),
      PLAYER_LOAD_TIMEOUT_MS,
    )
    return () => window.clearTimeout(timer)
  }, [loadingKey])

  if (!streamSrc && !free && !trailer) {
    return (
      <p className="player__unavailable" role={isLoading ? 'status' : undefined}>
        {isLoading
          ? 'Looking for a trailer…'
          : 'No trailer or free full movie is available for this title.'}
      </p>
    )
  }

  const update = (attempt: number, state: PlayerState) =>
    setRun((r) => (r && r.itemId === item.id && r.attempt === attempt ? { ...r, state } : r))
  const loaded = () => active && update(active.attempt, { status: 'playing' })

  const start = async (choice: Choice) => {
    const attempt = (run?.attempt ?? 0) + 1
    if (choice !== 'stream') {
      setRun({ itemId: item.id, choice, streamSrc: null, attempt, state: { status: 'loading' } })
      return
    }
    if (!streamSrc) return
    setRun({ itemId: item.id, choice, streamSrc, attempt, state: { status: 'checking' } })
    try {
      const response = await fetchImpl(`${streamSrc}?check=1`)
      const body = (await response.json().catch(() => ({}))) as {
        available?: boolean
        reason?: string | null
      }
      update(
        attempt,
        body.available
          ? { status: 'loading' }
          : {
              status: 'error',
              message: STREAM_MESSAGES[body.reason ?? ''] ?? 'This title can’t be played right now.',
            },
      )
    } catch {
      update(attempt, { status: 'error', message: STREAM_MESSAGES.unreachable })
    }
  }

  const checking = active?.state.status === 'checking'
  const streamLabel = isSeries ? `Play S${season} E${episode}` : 'Play'

  const pickers = streamSrc && isSeries && (
    <div className="player__pickers">
      <label>
        Season
        {seasons.length > 0 ? (
          <select
            value={season}
            onChange={(e) => setSelected({ season: Number(e.target.value), episode: 1 })}
          >
            {seasons.map((s) => (
              <option key={s.number} value={s.number}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="number"
            min={1}
            value={season}
            onChange={(e) =>
              setSelected({ season: Math.max(1, Number(e.target.value) || 1), episode: 1 })
            }
          />
        )}
      </label>
      <label>
        Episode
        {episodeCount > 0 ? (
          <select
            value={episode}
            onChange={(e) => setSelected({ season, episode: Number(e.target.value) })}
          >
            {Array.from({ length: episodeCount }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                Episode {i + 1}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="number"
            min={1}
            value={episode}
            onChange={(e) =>
              setSelected({ season, episode: Math.max(1, Number(e.target.value) || 1) })
            }
          />
        )}
      </label>
    </div>
  )

  const actions = (
    <div className="player__actions">
      {streamSrc && (
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void start('stream')}
          disabled={checking}
        >
          <Play aria-hidden="true" />
          {checking ? 'Checking availability…' : streamLabel}
        </button>
      )}
      {free && (
        <button
          type="button"
          className={streamSrc ? 'btn btn--ghost' : 'btn btn--primary'}
          onClick={() => void start('free')}
        >
          <Play aria-hidden="true" /> Watch Free
        </button>
      )}
      {trailer && (
        <button
          type="button"
          className={streamSrc || free ? 'btn btn--ghost' : 'btn btn--primary'}
          onClick={() => void start('trailer')}
        >
          <Clapperboard aria-hidden="true" /> Play Trailer
        </button>
      )}
      {(downloadSrc ?? freeDownload) && (
        <a className="btn btn--ghost" href={downloadSrc ?? freeDownload ?? undefined} download>
          <Download aria-hidden="true" /> {isSeries ? `Download S${season} E${episode}` : 'Download'}
        </a>
      )}
      {free && <span className="player__license">{free.license} · full movie</span>}
    </div>
  )

  if (!active || active.state.status === 'checking' || active.state.status === 'error') {
    return (
      <section className="player" aria-label="Watch">
        {pickers}
        {active?.state.status === 'error' && (
          <p className="player__error" role="alert">
            <AlertTriangle aria-hidden="true" />
            {active.state.message}
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void start(active.choice)}
            >
              <RotateCcw aria-hidden="true" /> Retry
            </button>
          </p>
        )}
        {actions}
      </section>
    )
  }

  const titles: Record<Choice, string> = {
    stream: `${item.title} player`,
    free: `${item.title} full movie`,
    trailer: `${item.title} trailer`,
  }
  const key = `${active.choice}-${active.attempt}`

  return (
    <section className="player" aria-label="Watch">
      {active.choice === 'stream' && pickers}
      <div className="player__frame">
        {active.state.status === 'loading' && (
          <div className="player__overlay" role="status">
            <span className="player__spinner" aria-hidden="true" />
            Loading player…
          </div>
        )}
        {active.choice === 'stream' && active.streamSrc ? (
          <iframe
            key={key}
            src={active.streamSrc}
            title={titles.stream}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            sandbox={STREAM_SANDBOX}
            referrerPolicy="origin"
            onLoad={loaded}
          />
        ) : active.choice === 'free' && free ? (
          <FreePlayer
            key={key}
            movie={free}
            title={titles.free}
            onLoad={loaded}
            onError={() =>
              update(active.attempt, {
                status: 'error',
                message: 'This video couldn’t be played. Please try again.',
              })
            }
          />
        ) : (
          trailer && (
            <iframe
              key={key}
              src={trailerUrl(trailer)}
              title={titles.trailer}
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={loaded}
            />
          )
        )}
      </div>
      <button type="button" className="btn btn--ghost player__close" onClick={() => setRun(null)}>
        <X aria-hidden="true" /> Close player
      </button>
    </section>
  )
}

interface FreePlayerProps {
  movie: FreeMovie
  title: string
  onLoad: () => void
  onError: () => void
}

function FreePlayer({ movie, title, onLoad, onError }: FreePlayerProps) {
  const src = freeSourceUrl(movie.source)
  if (movie.source.kind === 'archive') {
    return (
      <iframe
        src={src}
        title={title}
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        onLoad={onLoad}
      />
    )
  }
  return (
    <video
      title={title}
      controls
      autoPlay
      playsInline
      preload="metadata"
      onLoadedData={onLoad}
      onError={onError}
    >
      <source src={src} type={movie.source.mimeType} onError={onError} />
    </video>
  )
}
