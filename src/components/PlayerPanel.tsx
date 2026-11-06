import { useCallback, useEffect, useRef, useState } from 'react'
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
import {
  currentEpisodeOf,
  finishEntry,
  recordPlay,
  recordProgress,
  savedProgressOf,
  takeResumeRequest,
} from '../utils/continueWatching'
import { recordTaste, recordTasteById } from '../taste/profile'
import { reportReferralPlay } from '../referral/status'
import { WatchLaterButton } from './WatchLater'
import { useLiveWatching } from '../live/heartbeat'
import { readLastEpisode, saveLastEpisode, type EpisodeRef } from '../utils/watchHistory'
import { requestSyncNow } from '../account/sync'
import { embedmasterUrl, serverTiming, type PlayerServerId } from '../config/players'
import { availableServers, preferredServer, savePreferredServer, serverLabel, trackServerSwitch } from '../utils/playerServer'
import { clearLimited, isLimited, markLimited } from '../utils/streamLimit'
import { reportPlayer } from '../live/playerStats'
import { episodeAd, QUIET_ADS_ATTR, serverAd } from '../ads/adManager'
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
  /** This network hit today's limit earlier (src/utils/streamLimit.ts): the message, no player loaded. */
  | { status: 'limited' }

interface Run {
  itemId: string
  choice: Choice
  /**
   * The movie or episode the run belongs to, as its /api/play path (the same
   * on every server); changing season or episode stops it.
   */
  streamSrc: string | null
  /** The server playing a stream. */
  server?: PlayerServerId
  /** Moved here by itself after the other server failed: no second switch, and a "Switched to" note. */
  autoSwitched?: boolean
  attempt: number
  state: PlayerState
  /** Moving on to the next episode: keep the player (and fullscreen) up while it's checked. */
  keepPlayer?: boolean
  /** No playable start within 10 s: most likely the network's daily limit (the message covers the player). */
  limitHit?: boolean
}

/** The friendly message for EmbedMaster's per-network daily limit. */
export const LIMIT_MESSAGE =
  'This network has reached today’s streaming limit 😔 Try switching between Wi-Fi and mobile data, or come back in a few hours.'

/**
 * True when this play has opened EmbedMaster's player: always on Server 2,
 * and on Server 1 once its page (ours, same origin) has given its stream
 * frame a source. A page we can't look into (the original player, after a
 * redirect) counts as opened.
 */
function openedEmbedMaster(frame: HTMLIFrameElement | null, server: PlayerServerId): boolean {
  if (server === 'embedmaster' || !frame) return true
  try {
    const doc = frame.contentDocument
    if (!doc) return true
    return Boolean(doc.getElementById('stream-frame')?.getAttribute('src'))
  } catch {
    return true
  }
}

/** Watched this share of a movie or episode: a strong taste signal. */
const HALF_WATCHED = 0.5
/** Started, then closed within this: a negative taste signal. */
const LEFT_EARLY_MS = 2 * 60 * 1000

/** How long a player may take to load before we call it failed. */
export const PLAYER_LOAD_TIMEOUT_MS = 20000

/** The "how to download with Abyss" walkthrough, opened from the hint under the player. */
const HOW_TO_DOWNLOAD_VIDEO = '/videos/how-to-download.mp4'
const HOW_TO_DOWNLOAD_POSTER = '/videos/how-to-download.jpg'

/**
 * Both servers' players (embdmstrplayer.com inside the NextStream page, and
 * embedmaster.link) post `{ source: 'embedmaster_player', event, info }` to the
 * top window and take `{ source: 'embedmaster_player_command', command, value }`
 * back: play, pause, seek (seconds), volume (0-100), mute, unmute, fullscreen.
 */
const PLAYER_EVENTS = 'embedmaster_player'
const PLAYER_COMMANDS = 'embedmaster_player_command'

/** Sends a command to the player window `ev` came from, at its own origin. */
const command = (ev: MessageEvent, name: string, value?: number) =>
  (ev.source as Window).postMessage(
    { source: PLAYER_COMMANDS, command: name, value },
    ev.origin && ev.origin !== 'null' ? ev.origin : '*',
  )

/**
 * Logs each kind of player event once, in dev or with
 * localStorage['naijatr.playerLog'] = '1' (to check the names a server sends).
 */
const loggedEvents = new Set<string>()
function logPlayerEvent(ev: MessageEvent, event: unknown, info: unknown) {
  let enabled = import.meta.env.DEV && import.meta.env.MODE !== 'test'
  try {
    enabled ||= localStorage.getItem('naijatr.playerLog') === '1'
  } catch {
    // Storage blocked: dev only.
  }
  const name = `${ev.origin} ${String(event)}`
  if (!enabled || loggedEvents.has(name)) return
  loggedEvents.add(name)
  console.info('[player]', ev.origin, event, info)
}

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
/** A player this close to our saved time is there. */
const SEEK_TOLERANCE_S = 5
/** Not there yet: the seek is sent again this often. */
const SEEK_RETRY_MS = 1500
/** A player that still isn't there after this won't seek: what it plays counts from then on. */
const SEEK_GIVE_UP_MS = 20_000
/** For this long after a player reaches our time, a smaller one from it isn't taken. */
const EARLY_GUARD_MS = 10_000

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
  'key-rejected': 'The streaming service couldn’t be reached. Please try again.',
}

/** A player event that means the video really started: its length, a time, or play. */
const isPlayableStart = (data: { event?: unknown; info?: unknown }) =>
  data.event === 'play' ||
  (data.event === 'time' && typeof data.info === 'number') ||
  (data.event === 'duration' && typeof data.info === 'number' && data.info > 0)

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
  // The servers that can play this title ("Server 1", "Server 2"…), and the one Play uses.
  const servers = availableServers(isSeries ? availability.tv : availability.movie, item.tmdbId)
  const [pickedServer, setPickedServer] = useState<PlayerServerId | null>(null)
  const server = pickedServer && servers.includes(pickedServer) ? pickedServer : preferredServer(servers)
  const streamEnabled = servers.length > 0
  const tvSrc = (s: number, e: number) => `/api/play/tv/${item.tmdbId}/${s}/${e}`

  // The episode this browser last played of this series, offered as "Continue" until
  // the viewer plays something or dismisses it.
  // Continue watching's episode first: it has moved on past a finished one.
  const lastPlayed = () => (isSeries ? (currentEpisodeOf(item.id) ?? readLastEpisode(item.id)) : null)
  const [resume, setResume] = useState(() => ({ itemId: item.id, episode: lastPlayed() }))
  if (resume.itemId !== item.id) {
    setResume({ itemId: item.id, episode: lastPlayed() })
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
  // Counts every start, so a run started from an earlier render's callback still gets a new number.
  const attemptRef = useRef(0)
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
        command(ev, 'pause')
        command(ev, 'seek', Math.max(0, position - 2))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [watchingSrc])

  // Continue watching: save the position every 10s (and at once on pause, a
  // server switch, hiding or leaving the page), resume the saved time on
  // whichever server plays it, and move on when it's finished.
  // Progress belongs to the movie or episode, never to a server.
  const resumeAtRef = useRef<{ src: string; at: number } | null>(null)
  // Where the stream is now (as last accepted), so a server switch carries on from there.
  const positionRef = useRef<{ src: string; at: number } | null>(null)
  // Saves the playing position now: a server switch calls it before the other player loads.
  const saveNowRef = useRef<(() => void) | null>(null)
  // Leaving this player for the other server: not "left early" for taste.
  const switchingRef = useRef(false)
  const itemId = item.id
  // One run of the effect per player opened (a server switch opens a new one).
  const watchingRun = watchingSrc && active ? `${active.attempt}` : null
  useEffect(() => {
    if (!watchingSrc) return
    const src = watchingSrc
    const ep = episodeOfSrc(src)
    let position: number | null = null
    let duration: number | null = null
    let savedAt = 0
    let finished = false
    // Our saved time wins over wherever the new player starts (0, or its own
    // remembered spot): it's sent once the player reports in and again until
    // the player is there; until then its times are ignored.
    const resumeAt = resumeAtRef.current?.src === src ? resumeAtRef.current.at : null
    if (resumeAt !== null) resumeAtRef.current = null
    let pendingSeek = resumeAt !== null && resumeAt > RESUME_MIN_S ? resumeAt : null
    const floor = pendingSeek
    let firstEventAt = 0
    let settledAt = 0
    let seekSentAt = 0
    const seek = (ev: MessageEvent, to: number) => {
      seekSentAt = Date.now()
      command(ev, 'seek', to)
    }
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
    const saveAndSync = () => {
      save()
      void requestSyncNow()
    }
    saveNowRef.current = saveAndSync
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown; info?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      logPlayerEvent(ev, data.event, data.info)
      const now = Date.now()
      if (!firstEventAt) {
        firstEventAt = now
        // Ready (its first event, usually the duration): go to our saved time.
        if (pendingSeek !== null) seek(ev, pendingSeek)
        else settledAt = now
      }
      if (data.event === 'duration' && typeof data.info === 'number' && data.info > 0) duration = data.info
      if (data.event === 'time' && typeof data.info === 'number') {
        const time = data.info
        if (pendingSeek !== null) {
          if (Math.abs(time - pendingSeek) <= SEEK_TOLERANCE_S || now - firstEventAt >= SEEK_GIVE_UP_MS) {
            // There (or it won't seek: what it plays now counts).
            pendingSeek = null
            settledAt = now
          } else {
            if (now - seekSentAt >= SEEK_RETRY_MS) seek(ev, pendingSeek)
            return
          }
        }
        // Just loaded: a smaller time (the player jumping back to its own spot) neither
        // replaces the saved one nor stays; it's sent back to ours.
        if (floor !== null && time < floor - SEEK_TOLERANCE_S && now - settledAt < EARLY_GUARD_MS) {
          if (now - seekSentAt >= SEEK_RETRY_MS) seek(ev, floor)
          return
        }
        position = time
        positionRef.current = { src, at: position }
        if (duration && position >= duration * HALF_WATCHED) markWatched()
        if (now - savedAt >= PROGRESS_SAVE_MS) save()
      }
      // Paused: the position goes to the account now (signed in), not at the next 15-second sync.
      if (data.event === 'pause') saveAndSync()
      if (data.event === 'ended' && !finished && pendingSeek === null) {
        finished = true
        markWatched()
        finishEntry(itemId, ep)
      }
    }
    // The tab hidden or the page closed: saved now.
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveAndSync()
    }
    window.addEventListener('message', onMessage)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', saveAndSync)
    return () => {
      window.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', saveAndSync)
      if (saveNowRef.current === saveAndSync) saveNowRef.current = null
      // The last few seconds since the previous save, sent to the account at once.
      saveAndSync()
      const switching = switchingRef.current
      switchingRef.current = false
      if (!switching && position !== null && !watched && Date.now() - startedAt < LEFT_EARLY_MS) recordTasteById(itemId, 'left')
    }
    // watchingRun: a new player (server switch, retry) starts over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchingSrc, watchingRun, itemId])

  // A player with no playable start within 10s. EmbedMaster counts every
  // player opened, per network, and both servers end in it, so the other
  // server is tried only while this play hasn't opened EmbedMaster yet (Server
  // 1's page never got that far): one open per play. Otherwise it's most
  // likely the network's daily limit, and the message covers the player.
  // (`switchServer` is defined below the early return; the ref is set once it exists.)
  const switchServerRef = useRef<((to: PlayerServerId, how: 'picked' | 'auto') => void) | null>(null)
  const startingRun =
    active?.choice === 'stream' && (active.state.status === 'loading' || active.state.status === 'playing')
      ? active.attempt
      : null
  const startingServer = active?.server
  const startingAuto = active?.autoSwitched ?? false
  useEffect(() => {
    if (startingRun === null || !startingServer) return
    const setLimitHit = (limitHit: boolean) =>
      setRun((r) => (r && r.attempt === startingRun && Boolean(r.limitHit) !== limitHit ? { ...r, limitHit } : r))
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown; info?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      if (!isPlayableStart(data)) return
      // Playing (even after the message): no limit on this network after all.
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      clearLimited()
      setLimitHit(false)
    }
    const timer = window.setTimeout(() => {
      reportPlayer(startingServer, 'nostart')
      const to = startingAuto ? null : servers.find((id) => id !== startingServer)
      if (to && !openedEmbedMaster(frameRef.current, startingServer)) {
        window.removeEventListener('message', onMessage)
        reportPlayer(startingServer, 'fallback')
        switchServerRef.current?.(to, 'auto')
        return
      }
      // Still listening: a late start takes the message away again.
      reportPlayer(startingServer, 'limited')
      markLimited()
      setLimitHit(true)
    }, serverTiming.startMs)
    window.addEventListener('message', onMessage)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
    }
    // Once per run; the server list doesn't change while it plays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startingRun])

  // The player's iframe, unloaded (about:blank) as it leaves the page: Close
  // player, leaving the title, another server or episode, or the hidden-tab
  // close below. Stable, so a re-render never reloads it.
  const attachFrame = useCallback((node: HTMLIFrameElement | null) => {
    frameRef.current = node
    if (!node) return
    return () => {
      if (frameRef.current === node) frameRef.current = null
      node.src = 'about:blank'
    }
  }, [])

  // A film or episode left in a hidden tab (or app) for 2 minutes is closed,
  // its progress saved first (the watching effect's cleanup); Play carries on
  // from there. Back sooner: the same player, untouched.
  const [closedAway, setClosedAway] = useState(false)
  const streamShown =
    active?.choice === 'stream' && (active.state.status === 'loading' || active.state.status === 'playing')
  useEffect(() => {
    if (!streamShown) return
    let timer: number | undefined
    const onVisibility = () => {
      window.clearTimeout(timer)
      if (document.visibilityState !== 'hidden') return
      timer = window.setTimeout(() => {
        if (fullscreenElement()) exitFullscreen()
        setRun(null)
        setClosedAway(true)
      }, serverTiming.hiddenCloseMs)
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [streamShown])

  // TV: the remote plays and pauses the video (OK on the video, or the media
  // keys), and pausing shows a "watch on your phone" QR code.
  const tv = isTvMode()
  const sectionRef = useRef<HTMLElement>(null)
  const frameBoxRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [howToOpen, setHowToOpen] = useState(false)
  const pausedRef = useRef(false)
  const controllable =
    tv && (active?.state.status === 'loading' || active?.state.status === 'playing') && active.choice !== 'trailer'
      ? `${active.choice}-${active.attempt}`
      : null
  useEffect(() => {
    if (!controllable) return
    frameBoxRef.current?.focus({ preventScroll: true })
    let player: MessageEvent | null = null
    const show = (isPaused: boolean) => {
      pausedRef.current = isPaused
      setPaused(isPaused)
    }
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      player = ev
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
        if (player) command(player, pause ? 'pause' : 'play')
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
    // Its saved time is picked up by start(), like any play of that movie or episode.
    const choice = request.source === 'free' ? 'free' : 'stream'
    scrollToPlayerRef.current = true
    playRef.current?.(choice, ep)
  }, [itemId])

  // Bring the resumed player into view once it's on the page (the details above it may still be loading).
  const playerShown = active?.state.status === 'loading' || active?.state.status === 'playing'
  // Counts as watching (for the live viewer count) while the film or episode's player is open.
  useLiveWatching(
    playerShown && active.choice !== 'trailer' && item.tmdbId !== undefined ? (isSeries ? `tv:${item.tmdbId}` : `movie:${item.tmdbId}`) : null,
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
   * A stream plays on `via.server` (default: the viewer's server); a switch
   * between servers isn't a new play (no Continue watching or taste entry).
   */
  const start = async (
    choice: Choice,
    ep: EpisodeRef = { season, episode },
    keepPlayer = false,
    via: { server: PlayerServerId; autoSwitched: boolean; switching?: boolean } | null = null,
  ) => {
    const attempt = (attemptRef.current = Math.max(attemptRef.current, run?.attempt ?? 0) + 1)
    pausedRef.current = false
    setPaused(false)
    const src = isSeries && streamSrc ? tvSrc(ep.season, ep.episode) : streamSrc
    // Playing a movie or episode again picks up where it was left, on any server
    // (a switch has already set where to carry on from). Read before recordPlay moves it up.
    if (choice === 'stream' && src && !via?.switching) {
      const at = savedProgressOf(item.id, isSeries ? ep : {})
      resumeAtRef.current = at !== null ? { src, at } : null
    }
    if (choice !== 'trailer' && !via?.switching) {
      recordPlay(item, { ...(isSeries ? ep : {}), source: choice === 'free' ? 'free' : 'stream' })
      recordTaste(item, 'play')
      // An invited friend counts once they play a movie or a series episode (not a trailer or a match).
      void reportReferralPlay()
    }
    if (choice !== 'stream') {
      setRun({ itemId: item.id, choice, streamSrc: null, attempt, state: { status: 'loading' } })
      return
    }
    const onServer = via?.server ?? server
    if (!src || !onServer) return
    setClosedAway(false)
    // This network hit today's limit earlier: the message, without opening (and counting) another player.
    if (!via && isLimited()) {
      reportPlayer(onServer, 'limited')
      setRun({ itemId: item.id, choice, streamSrc: src, server: onServer, attempt, state: { status: 'limited' } })
      return
    }
    dismissResume()
    const autoSwitched = via?.autoSwitched ?? false
    if (onServer === 'embedmaster') {
      // Played straight from embedmaster.link: nothing to check first.
      if (isSeries) saveLastEpisode(item.id, ep)
      reportPlayer(onServer, 'load')
      setRun({ itemId: item.id, choice, streamSrc: src, server: onServer, autoSwitched, attempt, state: { status: 'loading' }, keepPlayer })
      return
    }
    setRun({ itemId: item.id, choice, streamSrc: src, server: onServer, autoSwitched, attempt, state: { status: 'checking' }, keepPlayer })
    // This server can't play it: the other one tries, once.
    const fallBack = () => {
      // Its check failed before any player opened: the other server is still the play's first open.
      const to = autoSwitched ? null : servers.find((id) => id !== onServer)
      if (!to) return false
      reportPlayer(onServer, 'fallback')
      trackServerSwitch(to, 'auto')
      void start(choice, ep, true, { server: to, autoSwitched: true, switching: true })
      return true
    }
    try {
      const response = await fetchImpl(`${src}?check=1`)
      const body = (await response.json().catch(() => ({}))) as {
        available?: boolean
        reason?: string | null
      }
      if (body.available && isSeries) saveLastEpisode(item.id, ep)
      if (body.available) reportPlayer(onServer, 'load')
      if (!body.available && fallBack()) return
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
      if (fallBack()) return
      update(attempt, { status: 'error', message: STREAM_MESSAGES.unreachable })
    }
  }

  /** Plays the current movie or episode on `to`: picked by the viewer (and remembered), or after the other failed. */
  const switchServer = (to: PlayerServerId, how: 'picked' | 'auto') => {
    if (how === 'picked') {
      savePreferredServer(to)
      setPickedServer(to)
    }
    trackServerSwitch(to, how)
    if (!active || active.choice !== 'stream' || !active.streamSrc) return
    // Saved now, not at the next 10-second save, then the other server opens
    // the same movie or episode at that point.
    if (saveNowRef.current) {
      switchingRef.current = true
      saveNowRef.current()
    }
    const ep = episodeOfSrc(active.streamSrc)
    const now = positionRef.current
    const from = now?.src === active.streamSrc ? now.at : savedProgressOf(item.id, ep)
    resumeAtRef.current = from !== null && from > RESUME_MIN_S ? { src: active.streamSrc, at: from } : null
    const at = ep.season !== undefined && ep.episode !== undefined ? { season: ep.season, episode: ep.episode } : undefined
    void start('stream', at, true, { server: to, autoSwitched: how === 'auto', switching: true })
  }
  switchServerRef.current = switchServer

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
            onChange={(e) => {
              episodeAd(e.nativeEvent, item)
              setSelected({ season: Number(e.target.value), episode: 1 })
            }}
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
            onChange={(e) => {
              episodeAd(e.nativeEvent, item)
              setSelected({ season, episode: Number(e.target.value) })
            }}
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

  // Server 1 / Server 2: switches the playing stream (or picks the server Play uses), remembered on this device.
  const playingServer = active?.choice === 'stream' ? (active.server ?? server) : server
  const serverSwitch = streamSrc && servers.length > 1 && (
    <div className="player__servers" role="group" aria-label="Server">
      {servers.map((id) => (
        <button
          key={id}
          type="button"
          className={id === playingServer ? 'player__server player__server--on' : 'player__server'}
          aria-pressed={id === playingServer}
          onClick={(event) => {
            if (id === playingServer) return
            // An ad only before Play: never while a player is open.
            serverAd(event.nativeEvent, item)
            switchServer(id, 'picked')
          }}
        >
          {serverLabel(servers, id)}
        </button>
      ))}
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

  // How to download (Abyss server, then ⬇), with a walkthrough video that opens
  // inline on request. Before Play too, so people know before they start.
  const howTo = streamSrc && !tv && (
    <>
      <p className="player__hint">
        <Download aria-hidden="true" />
        <span>
          Download: pick the <strong>Abyss</strong> server, then tap ⬇ in the player.{' '}
          <button
            type="button"
            className="player__hint-link"
            onClick={() => setHowToOpen((open) => !open)}
            aria-expanded={howToOpen}
          >
            {howToOpen ? 'Hide video' : 'Watch how'}
          </button>
        </span>
      </p>
      {howToOpen && (
        <video
          className="player__howto"
          src={HOW_TO_DOWNLOAD_VIDEO}
          poster={HOW_TO_DOWNLOAD_POSTER}
          controls
          playsInline
          preload="none"
          aria-label="How to download a movie with the Abyss server"
        />
      )}
    </>
  )

  if (
    !active ||
    (active.state.status === 'checking' && !active.keepPlayer) ||
    active.state.status === 'error' ||
    active.state.status === 'limited'
  ) {
    return (
      <section ref={sectionRef} className={sectionClass} aria-label="Watch">
        {!active && resumePrompt}
        {pickers}
        {serverSwitch}
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
        {closedAway && !active && (
          <p className="player__switched" role="status">
            The player was closed while you were away, to save this network’s streaming limit. Press Play to carry on
            where you left off.
          </p>
        )}
        {active?.state.status === 'limited' && (
          <div className="player__limit" role="alert">
            <p>{LIMIT_MESSAGE}</p>
            <div className="player__limit-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  // Another network may have its own limit: every server is tried again.
                  clearLimited()
                  const ep = active.streamSrc ? episodeOfSrc(active.streamSrc) : {}
                  void start('stream', ep.season !== undefined && ep.episode !== undefined ? { season: ep.season, episode: ep.episode } : undefined)
                }}
              >
                <RotateCcw aria-hidden="true" /> Try again
              </button>
              <WatchLaterButton item={item} />
            </div>
          </div>
        )}
        {actions}
        {howTo}
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

  // While the player is up, taps on its controls (Skip, Fullscreen, Close, servers, episodes) reach no ad script.
  return (
    <section ref={sectionRef} className={sectionClass} aria-label="Watch" {...{ [QUIET_ADS_ATTR]: '' }}>
      {active.choice === 'stream' && pickers}
      {active.choice === 'stream' && serverSwitch}
      {active.choice === 'stream' && active.autoSwitched && active.server && (
        <p className="player__switched" role="status">
          Switched to {serverLabel(servers, active.server)}
        </p>
      )}
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
        {active.state.status === 'checking' ? null : active.choice === 'stream' &&
          active.streamSrc &&
          active.server === 'embedmaster' &&
          item.tmdbId !== undefined ? (
          <iframe
            key={key}
            ref={attachFrame}
            src={embedmasterUrl(item.tmdbId, isSeries ? (episodeOfSrc(active.streamSrc) as EpisodeRef) : undefined)}
            title={titles.stream}
            // No sandbox: EmbedMaster's player breaks with one.
            allow="autoplay *; fullscreen *; picture-in-picture *; encrypted-media *"
            allowFullScreen
            onLoad={loaded}
          />
        ) : active.choice === 'stream' && active.streamSrc ? (
          <iframe
            key={key}
            ref={attachFrame}
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
        {active.limitHit && (
          <div className="player__limit player__limit--over" role="alert">
            <p>{LIMIT_MESSAGE}</p>
            <div className="player__limit-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  // On another network now: one more try.
                  clearLimited()
                  const ep = active.streamSrc ? episodeOfSrc(active.streamSrc) : {}
                  void start('stream', ep.season !== undefined && ep.episode !== undefined ? { season: ep.season, episode: ep.episode } : undefined)
                }}
              >
                <RotateCcw aria-hidden="true" /> Try again
              </button>
              <button type="button" className="btn btn--ghost" onClick={closePlayer}>
                <X aria-hidden="true" /> Close player
              </button>
            </div>
          </div>
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
        <WatchLaterButton item={item} />
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
      {active.choice === 'stream' && howTo}
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
