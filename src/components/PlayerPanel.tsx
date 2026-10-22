import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Captions,
  Clapperboard,
  Download,
  History,
  Maximize,
  Minimize,
  Play,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-react'
import { findFreeMovie, freeSourceUrl, type FreeMovie } from '../data/freeMovies'
import type { MediaItem, Trailer } from '../types/media'
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenElement,
  fullscreenSupported,
  onFullscreenChange,
} from '../tv/fullscreen'
import { QrCode } from '../tv/QrCode'
import { playAfterGate } from '../gate/gateStore'
import { playAfterAdBreak } from '../tv/tvAdBreakStore'
import { isTvMode, phoneLink } from '../tv/tvMode'
import { finishEntry, recordPlay, recordProgress, takeResumeRequest } from '../utils/continueWatching'
import { recordTaste, recordTasteById } from '../taste/profile'
import { reportReferralPlay } from '../referral/api'
import { playerClosed } from '../referral/invitee'
import { useLiveWatching } from '../live/heartbeat'
import { readLastEpisode, saveLastEpisode, type EpisodeRef } from '../utils/watchHistory'
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
  /** Moving on to the next episode: keep the player (and fullscreen) up while it's checked. */
  keepPlayer?: boolean
}

/** Watched this share of a movie or episode: a strong taste signal. */
const HALF_WATCHED = 0.5
/** Started, then closed within this: a negative taste signal. */
const LEFT_EARLY_MS = 2 * 60 * 1000

/** How long a player may take to load before we call it failed. */
export const PLAYER_LOAD_TIMEOUT_MS = 20000

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

/** How often the position is saved for Continue watching. */
const PROGRESS_SAVE_MS = 10_000
/** Resume only past this point (earlier, starting over is no loss). */
const RESUME_MIN_S = 10

/** The episode a /api/play/tv/{id}/{season}/{episode} source plays. */
const episodeOfSrc = (src: string) => {
  const match = /\/tv\/\d+\/(\d+)\/(\d+)$/.exec(src)
  return match ? { season: Number(match[1]), episode: Number(match[2]) } : {}
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

  // The episode this browser last played of this series, offered as "Continue" until
  // the viewer plays something or dismisses it.
  const [resume, setResume] = useState(() => ({
    itemId: item.id,
    episode: isSeries ? readLastEpisode(item.id) : null,
  }))
  if (resume.itemId !== item.id) {
    setResume({ itemId: item.id, episode: isSeries ? readLastEpisode(item.id) : null })
  }
  const lastEpisode = resume.itemId === item.id ? resume.episode : null
  const dismissResume = () => setResume({ itemId: item.id, episode: null })
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

  // No moving on by itself: the player runs its own next-episode countdown on
  // `ended`, which can't be turned off from here. Stepping back from the end
  // stops it; the Skip button moves on.
  const frameRef = useRef<HTMLIFrameElement>(null)
  const watchingSrc =
    active?.choice === 'stream' && active.state.status !== 'checking' ? active.streamSrc : null
  useEffect(() => {
    if (!watchingSrc) return
    let position = 0
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown; info?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      if (data.event === 'time' && typeof data.info === 'number') position = data.info
      if (data.event === 'ended') {
        const player = ev.source as Window
        player.postMessage({ source: PLAYER_COMMANDS, command: 'pause' }, '*')
        player.postMessage({ source: PLAYER_COMMANDS, command: 'seek', value: Math.max(0, position - 2) }, '*')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [watchingSrc])

  // Continue watching: save the position every 10s, resume a tapped card's
  // saved time once the player reports in, and move on when it's finished.
  const resumeAtRef = useRef<{ src: string; at: number } | null>(null)
  const itemId = item.id
  useEffect(() => {
    if (!watchingSrc) return
    const src = watchingSrc
    const ep = episodeOfSrc(src)
    let player: Window | null = null
    let position: number | null = null
    let duration: number | null = null
    let savedAt = 0
    let finished = false
    // Taste: watched past half (or to the end), or left within 2 minutes.
    const startedAt = Date.now()
    let watched = false
    const markWatched = () => {
      if (watched) return
      watched = true
      recordTasteById(itemId, 'watched')
    }
    const save = () => {
      if (position === null || finished) return
      savedAt = Date.now()
      recordProgress(itemId, ep, position, duration)
    }
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown; info?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      player = ev.source as Window
      if (data.event === 'duration' && typeof data.info === 'number' && data.info > 0) duration = data.info
      if (data.event === 'time' && typeof data.info === 'number') {
        position = data.info
        const resume = resumeAtRef.current
        if (resume?.src === src) {
          resumeAtRef.current = null
          if (resume.at > RESUME_MIN_S && position < resume.at - 5) {
            player.postMessage({ source: PLAYER_COMMANDS, command: 'seek', value: resume.at }, '*')
            position = resume.at
          }
        }
        if (duration && position >= duration * HALF_WATCHED) markWatched()
        if (Date.now() - savedAt >= PROGRESS_SAVE_MS) save()
      }
      if (data.event === 'ended' && !finished) {
        finished = true
        markWatched()
        finishEntry(itemId, ep)
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      // The last few seconds since the previous save.
      save()
      if (position !== null && !watched && Date.now() - startedAt < LEFT_EARLY_MS) recordTasteById(itemId, 'left')
    }
  }, [watchingSrc, itemId])

  // TV: the remote plays and pauses the video (OK on the video, or the media
  // keys), and pausing shows a "watch on your phone" QR code.
  const tv = isTvMode()
  const sectionRef = useRef<HTMLElement>(null)
  const frameBoxRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const controllable =
    tv && (active?.state.status === 'loading' || active?.state.status === 'playing') && active.choice !== 'trailer'
      ? `${active.choice}-${active.attempt}`
      : null
  useEffect(() => {
    if (!controllable) return
    frameBoxRef.current?.focus({ preventScroll: true })
    let player: Window | null = null
    const show = (isPaused: boolean) => {
      pausedRef.current = isPaused
      setPaused(isPaused)
    }
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      player = ev.source as Window
      if (data.event === 'play') show(false)
      if (data.event === 'pause') show(true)
    }
    const onMedia = (ev: Event) => {
      const mode = (ev as CustomEvent<'toggle' | 'play' | 'pause'>).detail
      const pause = mode === 'pause' || (mode === 'toggle' && !pausedRef.current)
      const video = frameBoxRef.current?.querySelector('video')
      if (video) {
        if (pause) video.pause()
        else void video.play().catch(() => undefined)
      } else {
        // The stream player (embedmaster) takes play/pause commands like the others it gets here.
        player?.postMessage({ source: PLAYER_COMMANDS, command: pause ? 'pause' : 'play' }, '*')
      }
      show(pause)
    }
    window.addEventListener('message', onMessage)
    window.addEventListener('tv:media', onMedia)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('tv:media', onMedia)
    }
  }, [controllable])

  // Fullscreen covers the whole player section, so the Skip and Close buttons stay
  // on screen. Where only videos can go fullscreen (iPhone), the section fills the
  // window instead.
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [filling, setFilling] = useState(false)
  useEffect(
    () =>
      onFullscreenChange(() =>
        setIsFullscreen(Boolean(sectionRef.current) && fullscreenElement() === sectionRef.current),
      ),
    [],
  )
  useEffect(() => {
    if (!filling) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Leave the fill first; the details panel stays open.
      event.stopImmediatePropagation()
      setFilling(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [filling])
  const toggleFullscreen = () => {
    if (filling) return setFilling(false)
    if (isFullscreen) return exitFullscreen()
    if (fullscreenSupported()) enterFullscreen(sectionRef.current)
    else setFilling(true)
  }
  const sectionClass = filling ? 'player player--fill' : 'player'

  // A Continue watching card was tapped: start its movie or episode straight away.
  // (`play` is defined below the early return; the ref is set once it exists.)
  const playRef = useRef<((choice: Choice, ep?: EpisodeRef) => void) | null>(null)
  const scrollToPlayerRef = useRef(false)
  useEffect(() => {
    const request = takeResumeRequest(itemId)
    if (!request) return
    const ep = request.season !== null && request.episode !== null ? { season: request.season, episode: request.episode } : undefined
    if (ep) setSelected(ep)
    const choice = request.source === 'free' ? 'free' : 'stream'
    if (choice === 'stream' && request.at !== null) {
      const src = ep ? `/api/play/tv/${item.tmdbId}/${ep.season}/${ep.episode}` : `/api/play/movie/${item.tmdbId}`
      resumeAtRef.current = { src, at: request.at }
    }
    scrollToPlayerRef.current = true
    playRef.current?.(choice, ep)
    // Once per title opened from a card; item.tmdbId doesn't change for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  // Bring the resumed player into view once it's on the page (the details above it may still be loading).
  const playerShown = active?.state.status === 'loading' || active?.state.status === 'playing'
  // Counts as watching (for the live viewer count) while the film or episode's player is open.
  useLiveWatching(
    playerShown && active.choice !== 'trailer' && item.tmdbId !== undefined ? (isSeries ? `tv:${item.tmdbId}` : `movie:${item.tmdbId}`) : null,
  )
  // A movie or an episode was open: closing it (or the details around it) may bring the "You can win too" popup.
  const watchedRef = useRef(false)
  const watchingFilm = Boolean(active && active.choice !== 'trailer')
  useEffect(() => {
    if (watchingFilm) watchedRef.current = true
  }, [watchingFilm])
  useEffect(
    () => () => {
      if (watchedRef.current) void playerClosed()
    },
    [],
  )
  useEffect(() => {
    if (!playerShown || !scrollToPlayerRef.current) return
    scrollToPlayerRef.current = false
    sectionRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [playerShown])

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

  /**
   * Plays `choice`; for a series stream, `ep` picks the episode (default: the
   * selected one). `keepPlayer` keeps the player on screen while it's checked.
   */
  const start = async (choice: Choice, ep: EpisodeRef = { season, episode }, keepPlayer = false) => {
    const attempt = (run?.attempt ?? 0) + 1
    pausedRef.current = false
    setPaused(false)
    if (choice !== 'trailer') {
      recordPlay(item, { ...(isSeries ? ep : {}), source: choice === 'free' ? 'free' : 'stream' })
      recordTaste(item, 'play')
      // An invited friend counts once they play a movie or a series episode (not a trailer or a match).
      void reportReferralPlay()
    }
    const src = isSeries && streamSrc ? tvSrc(ep.season, ep.episode) : streamSrc
    if (choice !== 'stream') {
      setRun({ itemId: item.id, choice, streamSrc: null, attempt, state: { status: 'loading' } })
      return
    }
    if (!src) return
    dismissResume()
    setRun({ itemId: item.id, choice, streamSrc: src, attempt, state: { status: 'checking' }, keepPlayer })
    try {
      const response = await fetchImpl(`${src}?check=1`)
      const body = (await response.json().catch(() => ({}))) as {
        available?: boolean
        reason?: string | null
      }
      if (body.available && isSeries) saveLastEpisode(item.id, ep)
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

  /**
   * A Play button: the first play on a phone, tablet or TV asks to join the
   * Telegram channel (the gate); on a TV, the title's first play shows the ad
   * break, then the player goes fullscreen. Trailers skip both.
   */
  const play = (choice: Choice, ep?: EpisodeRef) => {
    const go = () => {
      if (tv) enterFullscreen(sectionRef.current)
      void start(choice, ep)
    }
    if (choice === 'trailer') return go()
    playAfterGate(() => playAfterAdBreak(`title:${item.id}`, go, phoneLink(item)))
  }
  playRef.current = play

  const closePlayer = () => {
    if (fullscreenElement()) exitFullscreen()
    setFilling(false)
    setRun(null)
    if (watchedRef.current) {
      watchedRef.current = false
      void playerClosed()
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

  const resumePrompt = streamSrc && lastEpisode && (
    <div className="player__resume">
      <History aria-hidden="true" />
      <p>
        You were watching{' '}
        <strong>
          S{lastEpisode.season} E{lastEpisode.episode}
        </strong>
        . Continue where you left off?
      </p>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => {
          setSelected(lastEpisode)
          play('stream', lastEpisode)
        }}
      >
        <Play aria-hidden="true" /> Continue S{lastEpisode.season} E{lastEpisode.episode}
      </button>
      <button type="button" className="btn btn--ghost" onClick={dismissResume}>
        Not now
      </button>
    </div>
  )

  const actions = (
    <div className="player__actions">
      {streamSrc && (
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => play('stream')}
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
          onClick={() => play('free')}
        >
          <Play aria-hidden="true" /> Watch Free
        </button>
      )}
      {trailer && (
        <button
          type="button"
          className={streamSrc || free ? 'btn btn--ghost' : 'btn btn--primary'}
          onClick={() => play('trailer')}
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

  if (
    !active ||
    (active.state.status === 'checking' && !active.keepPlayer) ||
    active.state.status === 'error'
  ) {
    return (
      <section ref={sectionRef} className={sectionClass} aria-label="Watch">
        {!active && resumePrompt}
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
    setSelected(nextEpisode)
    void start('stream', nextEpisode, true)
  }

  const fullscreenOn = isFullscreen || filling

  return (
    <section ref={sectionRef} className={sectionClass} aria-label="Watch">
      {active.choice === 'stream' && pickers}
      <div
        ref={frameBoxRef}
        className="player__frame"
        tabIndex={tv ? 0 : undefined}
        aria-label={tv && active.choice !== 'trailer' ? 'Video: press OK to play or pause' : undefined}
        onKeyDown={
          tv
            ? (event) => {
                if (event.key !== 'Enter' || event.target !== event.currentTarget) return
                event.preventDefault()
                window.dispatchEvent(new CustomEvent('tv:media', { detail: 'toggle' }))
              }
            : undefined
        }
      >
        {(active.state.status === 'loading' || active.state.status === 'checking') && (
          <div className="player__overlay" role="status">
            <span className="player__spinner" aria-hidden="true" />
            {active.state.status === 'checking' ? `Loading S${season} E${episode}…` : 'Loading player…'}
          </div>
        )}
        {active.state.status === 'checking' ? null : active.choice === 'stream' && active.streamSrc ? (
          <iframe
            key={key}
            ref={frameRef}
            src={active.streamSrc}
            title={titles.stream}
            // `*`: /api/play may redirect to another host, which must keep these.
            // No fullscreen: the player's own would hide our Skip and Close
            // buttons, so it goes fullscreen through ours (toggleFullscreen).
            allow="autoplay *; encrypted-media *; picture-in-picture *"
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
        {tv && paused && active.choice !== 'trailer' && (
          <div className="player__paused" role="status">
            <QrCode url={phoneLink(item)} label="QR code: watch this on your phone" size="8em" />
            <p>
              <strong>Paused</strong> Press OK to resume
            </p>
            <p className="player__paused-note">Scan to watch on your phone</p>
          </div>
        )}
      </div>
      <div className="player__bar">
        {active.choice === 'stream' && nextEpisode && (
          <button type="button" className="btn btn--primary" onClick={playNext}>
            <SkipForward aria-hidden="true" /> Skip to S{nextEpisode.season} E{nextEpisode.episode}
          </button>
        )}
        {active.choice !== 'trailer' && (
          <button type="button" className="btn btn--ghost" onClick={toggleFullscreen} aria-pressed={fullscreenOn}>
            {fullscreenOn ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
            {fullscreenOn ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        )}
        <button type="button" className="btn btn--ghost player__close" onClick={closePlayer}>
          <X aria-hidden="true" /> Close player
        </button>
      </div>
      {active.choice === 'stream' && (
        <p className="player__hint">
          <Captions aria-hidden="true" />
          Subtitles: tap the CC button in the player to choose a language.
        </p>
      )}
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
