import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Clapperboard, Download, Play, RotateCcw, SkipForward, X } from 'lucide-react'
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

/** Seconds the "Next episode" button counts down before playing it. */
export const NEXT_EPISODE_DELAY_S = 10

/**
 * The stream player (embdmstrplayer.com, inside the NextStream page) posts
 * `{ source: 'embedmaster_player', event, info }` to the top window and takes
 * `{ source: 'embedmaster_player_command', command, value }` back.
 */
const PLAYER_EVENTS = 'embedmaster_player'
const PLAYER_COMMANDS = 'embedmaster_player_command'

/** True when `win` is `frame`'s window or one nested inside it. */
const isInside = (win: MessageEventSource | null, frame: Window | null | undefined) => {
  let w = win as Window | null
  for (let depth = 0; w && frame && depth < 4; depth++) {
    if (w === frame) return true
    if (w === w.parent) break
    w = w.parent
  }
  return false
}

const TIMEOUT_MESSAGE = 'The player took too long to load. Please try again.'

const STREAM_MESSAGES: Record<string, string> = {
  'not-found': 'This title isn’t available to stream right now.',
  'not-configured': 'Playback isn’t configured on this server.',
  unreachable: 'The streaming service couldn’t be reached. Please try again.',
  'upstream-error': 'The streaming service returned an error. Please try again.',
}

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
  const tvSrc = (s: number, e: number) => `/api/play/tv/${item.tmdbId}/${s}/${e}`
  const streamSrc = !streamEnabled
    ? null
    : isSeries
      ? tvSrc(season, episode)
      : `/api/play/movie/${item.tmdbId}`

  // The episode after this one: the next in the season, else the next season's first.
  const nextSeason = seasons
    .filter((s) => s.number > season)
    .sort((a, b) => a.number - b.number)[0]
  const nextEpisode =
    !streamSrc || !isSeries
      ? null
      : episodeCount === 0 || episode < episodeCount
        ? { season, episode: episode + 1 }
        : nextSeason
          ? { season: nextSeason.number, episode: 1 }
          : null

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

  // When a streamed episode ends, offer the next one (see UpNext).
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [endedSrc, setEndedSrc] = useState<string | null>(null)
  const watchingSrc =
    active?.choice === 'stream' && active.state.status !== 'checking' ? active.streamSrc : null
  const hasNext = nextEpisode !== null
  useEffect(() => {
    if (!watchingSrc || !hasNext) return
    let position = 0
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown; info?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      if (data.event === 'time' && typeof data.info === 'number') position = data.info
      if (data.event !== 'ended') return
      // The player runs its own next-episode countdown on `ended`, which can't be
      // turned off from here and would ignore a dismiss on our side. Stepping
      // back from the end stops it; leaving fullscreen lets our button show.
      const send = (command: string, value?: number) =>
        (ev.source as Window).postMessage({ source: PLAYER_COMMANDS, command, value }, '*')
      send('exitfullscreen')
      send('pause')
      send('seek', Math.max(0, position - 2))
      setEndedSrc(watchingSrc)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [watchingSrc, hasNext])

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

  const start = async (choice: Choice, src = streamSrc) => {
    const attempt = (run?.attempt ?? 0) + 1
    if (choice !== 'stream') {
      setRun({ itemId: item.id, choice, streamSrc: null, attempt, state: { status: 'loading' } })
      return
    }
    if (!src) return
    setRun({ itemId: item.id, choice, streamSrc: src, attempt, state: { status: 'checking' } })
    try {
      const response = await fetchImpl(`${src}?check=1`)
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

  const playNext = () => {
    if (!nextEpisode) return
    setEndedSrc(null)
    setSelected(nextEpisode)
    void start('stream', tvSrc(nextEpisode.season, nextEpisode.episode))
  }

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
            ref={frameRef}
            src={active.streamSrc}
            title={titles.stream}
            // `*`: /api/play may redirect to another host, which must keep these.
            allow="autoplay *; fullscreen *; encrypted-media *; picture-in-picture *"
            allowFullScreen
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
        {nextEpisode && endedSrc !== null && endedSrc === active.streamSrc && (
          <UpNext
            label={`S${nextEpisode.season} E${nextEpisode.episode}`}
            onPlay={playNext}
            onDismiss={() => setEndedSrc(null)}
          />
        )}
      </div>
      <button type="button" className="btn btn--ghost player__close" onClick={() => setRun(null)}>
        <X aria-hidden="true" /> Close player
      </button>
    </section>
  )
}

interface UpNextProps {
  label: string
  onPlay: () => void
  onDismiss: () => void
}

/**
 * "Next episode" button that fills up over NEXT_EPISODE_DELAY_S and then plays
 * the next episode. Clicking it plays it now; clicking anywhere else (or
 * pressing Escape) dismisses it and stays on this episode.
 */
function UpNext({ label, onPlay, onDismiss }: UpNextProps) {
  const [left, setLeft] = useState(NEXT_EPISODE_DELAY_S)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const actions = useRef({ onPlay, onDismiss })
  useEffect(() => {
    actions.current = { onPlay, onDismiss }
  })

  useEffect(() => {
    const timer = window.setInterval(() => setLeft((n) => n - 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (left <= 0) actions.current.onPlay()
  }, [left])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!buttonRef.current?.contains(e.target as Node)) actions.current.onDismiss()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') actions.current.onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    // Covers the player so a click on the video lands here and dismisses.
    <div className="player__upnext">
      <button
        ref={buttonRef}
        type="button"
        className="player__next"
        style={{ animationDuration: `${NEXT_EPISODE_DELAY_S}s` }}
        onClick={onPlay}
      >
        <SkipForward aria-hidden="true" />
        Next episode · {label}
        <span className="player__next-count" aria-hidden="true">
          {Math.max(left, 0)}
        </span>
      </button>
    </div>
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
