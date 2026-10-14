import { useEffect, useRef, useState } from 'react'
import { ExternalLink, MessageSquareText, MonitorPlay } from 'lucide-react'
import { StatusMessage } from '../components/StatusMessage'
import { useFootball } from './api'
import { hasStarted, isFinished, isLive } from './format'
import type { CommentaryLine, Fixture, FixtureEvent, MatchStream as MatchStreamData, StreamSource } from './types'

const LIVE_REFRESH_MS = 60_000

const minuteOf = (event: FixtureEvent) => `${event.time.elapsed}${event.time.extra ? `+${event.time.extra}` : ''}`

/** One commentary line per API-Football event: goals, cards, substitutions and VAR. */
function describeEvent(event: FixtureEvent): string {
  const team = event.team.name
  const player = event.player.name
  const assist = event.assist.name
  if (event.type === 'Goal') {
    if (event.detail === 'Own Goal') return `Own goal by ${player ?? 'a defender'}. It counts for ${team}.`
    if (event.detail === 'Missed Penalty') return `Penalty missed! ${player ?? 'The taker'} fails to score for ${team}.`
    const how = event.detail === 'Penalty' ? ' from the penalty spot' : ''
    return `GOAL! ${player ?? team} scores for ${team}${how}${assist ? `, set up by ${assist}` : ''}.`
  }
  if (event.type === 'Card') {
    const red = event.detail.toLowerCase().includes('red')
    return `${red ? 'Red card' : 'Yellow card'} for ${player ?? 'a player'} (${team})${event.comments ? `: ${event.comments}` : ''}.`
  }
  if (event.type === 'subst') {
    // API-Football lists the player coming off as `player` and the one coming on as `assist`.
    return `Substitution for ${team}: ${assist ?? 'a substitute'} comes on${player ? ` for ${player}` : ''}.`
  }
  if (event.type === 'Var') return `VAR check for ${team}: ${event.detail}${player ? ` (${player})` : ''}.`
  return `${event.detail}${player ? ` (${player})` : ''}, ${team}.`
}

/** Newest first, with kick-off, half-time and full-time markers. */
function buildCommentary(match: Fixture): CommentaryLine[] {
  const { status } = match.fixture
  const { home, away } = match.teams
  const lines: CommentaryLine[] = []
  if (hasStarted(status)) lines.push({ minute: '1', text: `Kick-off! ${home.name} vs ${away.name} is under way.` })
  const events = [...(match.events ?? [])].sort(
    (a, b) => a.time.elapsed - b.time.elapsed || (a.time.extra ?? 0) - (b.time.extra ?? 0),
  )
  const ht = match.score?.halftime
  let halfTimeAdded = false
  const addHalfTime = () => {
    if (halfTimeAdded || ht?.home == null || ht.away == null) return
    lines.push({ minute: '45', text: `Half-time: ${home.name} ${ht.home} - ${ht.away} ${away.name}.` })
    halfTimeAdded = true
  }
  for (const event of events) {
    if (event.time.elapsed > 45) addHalfTime()
    lines.push({ minute: minuteOf(event), text: describeEvent(event) })
  }
  if (status.short !== '1H') addHalfTime()
  if (isFinished(status)) {
    lines.push({ minute: null, text: `Full-time: ${home.name} ${match.goals.home ?? 0} - ${match.goals.away ?? 0} ${away.name}.` })
  }
  return lines.reverse()
}

/**
 * The match page's "Commentary" tab. Commentary is written from the match's
 * events (already loaded with the match), so it works for every match. The
 * Football Live Stream API (RapidAPI) adds its live status and, if it ever
 * returns one, a stream; any failure there only hides those extras.
 */
export function MatchStream({ match }: { match: Fixture }) {
  const live = isLive(match.fixture.status)
  const { data } = useFootball<MatchStreamData>(`stream?id=${match.fixture.id}`, live ? LIVE_REFRESH_MS : undefined)
  const [selected, setSelected] = useState(0)

  const commentary = [...(data?.commentary ?? []), ...buildCommentary(match)]
  const streams = data?.streams ?? []
  const source = streams[Math.min(selected, streams.length - 1)]
  const providerStatus = data?.status
  const started = hasStarted(match.fixture.status)

  return (
    <div className="fb-stream">
      {source && (
        <>
          {streams.length > 1 && (
            <div className="fb-tabs fb-stream__sources" role="group" aria-label="Stream sources">
              {streams.map((s, index) => (
                <button
                  key={s.url}
                  type="button"
                  className="fb-tab"
                  aria-pressed={index === selected}
                  onClick={() => setSelected(index)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <StreamPlayer key={source.url} source={source} title={`${match.teams.home.name} vs ${match.teams.away.name}`} />
          <p className="fb-stream__note">
            Streams come from a third-party provider and may not always load.{' '}
            <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">
              Open in a new tab <ExternalLink aria-hidden="true" />
            </a>
          </p>
        </>
      )}

      <section className="fb-commentary" aria-label="Live commentary">
        <h3 className="fb-commentary__title">
          <MessageSquareText aria-hidden="true" /> {live ? 'Live commentary' : 'Commentary'}
          {live && <span className="fb-pulse" aria-hidden="true" />}
        </h3>
        {live && providerStatus && (providerStatus.score || providerStatus.minute) && (
          <p className="fb-stream__note">
            {[providerStatus.status, providerStatus.minute && `${providerStatus.minute.replace(/'$/, '')}'`, providerStatus.score]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {commentary.length ? (
          <ol className="fb-events">
            {commentary.map((line, index) => (
              <li key={index} className="fb-event">
                <span className="fb-event__minute">{line.minute ? `${line.minute.replace(/'$/, '')}'` : 'FT'}</span>
                <span className="fb-event__text">
                  <span>{line.text}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <StatusMessage
            icon={MessageSquareText}
            compact
            title={started ? 'No commentary yet' : 'Commentary starts at kick-off'}
            message={
              started
                ? 'Goals, cards and substitutions will be described here as they happen.'
                : 'Come back when the match is live for minute-by-minute updates.'
            }
          />
        )}
      </section>
    </div>
  )
}

/**
 * The provider's links wrap the real playlist in its own proxy
 * (https://football-live-stream.online/?url=<playlist>). The source server
 * allows browser requests and answers faster, so play from it directly.
 */
function directUrl(url: string) {
  try {
    const inner = new URL(url).searchParams.get('url')
    return inner && new URL(inner).protocol === 'https:' ? inner : null
  } catch {
    return null
  }
}

const START_AHEAD_S = 15
const RESUME_AHEAD_S = 10
const MAX_GAP_S = 6
/** Play anyway after this long if some video is ready but the target isn't reached. */
const MAX_HOLD_MS = 8000

/**
 * Starts playback only with a few seconds of video ready, and after a stall
 * waits for some again, so a slow feed pauses briefly now and then instead of
 * stuttering constantly. Small holes in the stream are skipped. A pause by
 * the viewer is left alone.
 */
function gatePlayback(video: HTMLVideoElement) {
  let started = false
  let holding = true
  let holdSince = performance.now()
  let pausedByUs = false
  video.autoplay = false

  /** Seconds buffered from the current position; jumps a small hole first. */
  const ahead = () => {
    const t = video.currentTime
    const { buffered } = video
    for (let i = 0; i < buffered.length; i += 1) {
      if (buffered.start(i) <= t + 0.25 && buffered.end(i) > t) return buffered.end(i) - t
      if (buffered.start(i) > t && buffered.start(i) - t <= MAX_GAP_S) {
        video.currentTime = buffered.start(i) + 0.05
        return buffered.end(i) - video.currentTime
      }
    }
    return 0
  }

  const check = () => {
    if (!holding) return
    const ready = ahead()
    const waitedLong = ready > 0.5 && performance.now() - holdSince > MAX_HOLD_MS
    if (ready < (started ? RESUME_AHEAD_S : START_AHEAD_S) && !waitedLong) return
    holding = false
    started = true
    pausedByUs = false
    void video.play().catch(() => undefined)
  }

  const onWaiting = () => {
    if (video.paused || holding) return
    holding = true
    holdSince = performance.now()
    pausedByUs = true
    video.pause()
    check()
  }
  // The viewer paused (not us): stop managing until they press play.
  const onPause = () => {
    if (!pausedByUs) holding = false
  }
  const onPlay = () => {
    if (!pausedByUs) holding = false
  }

  video.addEventListener('waiting', onWaiting)
  video.addEventListener('pause', onPause)
  video.addEventListener('play', onPlay)
  const timer = window.setInterval(check, 1000)
  return {
    check,
    remove() {
      window.clearInterval(timer)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
    },
  }
}

/**
 * Plays an HLS (.m3u8) stream: natively where the browser can (Safari, iOS),
 * otherwise with hls.js, which is only downloaded when a stream is played.
 */
function HlsPlayer({ url, title }: { url: string; title: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // The source server first (faster), then the provider's proxy link as given.
    const candidates = [directUrl(url), url].filter((u, i, all): u is string => Boolean(u) && all.indexOf(u) === i)

    let destroyed = false
    let removeNative: (() => void) | undefined
    let removeGate: ReturnType<typeof gatePlayback> | undefined
    // The browser's own HLS player, only where hls.js can't run (iPhone Safari).
    // Chrome now has one too, but it stalls on these feeds; hls.js copes better.
    const playNatively = () => {
      if (!video.canPlayType('application/vnd.apple.mpegurl')) return setFailed(true)
      let index = 0
      const onError = () => {
        index += 1
        if (index < candidates.length) video.src = candidates[index]
        else setFailed(true)
      }
      video.addEventListener('error', onError)
      video.src = candidates[0]
      removeNative = () => {
        video.removeEventListener('error', onError)
        video.removeAttribute('src')
      }
    }

    let hls: { destroy: () => void } | undefined
    let prefetcher: { destroy: () => void } | undefined
    // Open the connection to the stream server while hls.js downloads.
    const preconnect = document.createElement('link')
    preconnect.rel = 'preconnect'
    preconnect.href = new URL(candidates[0]).origin
    preconnect.crossOrigin = 'anonymous'
    document.head.append(preconnect)
    Promise.all([import('hls.js'), import('./hlsPrefetch')]).then(
      ([{ default: Hls, FetchLoader }, { attachPrefetcher }]) => {
        if (destroyed) return
        if (!Hls.isSupported()) return playNatively()
        const prefetch = attachPrefetcher(Hls, FetchLoader)
        prefetcher = prefetch
        let index = 0
        let mediaRecoveries = 0
        let networkRetries = 0
        const player = new Hls({
          // These feeds are only just faster than real time, so stay well
          // behind live (the playlists ask for 20-24 s) with a deep buffer.
          ...prefetch.config,
          lowLatencyMode: false,
          // Start at the oldest part of the playlist (they hold 24-28 s), so
          // the whole window can be buffered before playback starts.
          liveSyncDuration: 24,
          liveMaxLatencyDuration: 60,
          maxBufferLength: 40,
          backBufferLength: 30,
          fragLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: 10_000,
              maxLoadTimeMs: 20_000,
              timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
              errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
            },
          },
        })
        hls = player
        prefetch.follow(player)
        player.on(Hls.Events.FRAG_LOADED, () => {
          networkRetries = 0
        })
        removeGate = gatePlayback(video)
        player.on(Hls.Events.FRAG_BUFFERED, () => removeGate?.check())
        player.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 3) {
            mediaRecoveries += 1
            return player.recoverMediaError()
          }
          // A playlist that won't load at all: go straight to the next address.
          const playlistFailed = /^(manifest|level)(Load|Parsing)/.test(data.details)
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !playlistFailed && networkRetries < 3) {
            networkRetries += 1
            return player.startLoad()
          }
          // Still failing: try the next address for the stream, if any.
          index += 1
          if (index < candidates.length) {
            networkRetries = 0
            return player.loadSource(candidates[index])
          }
          setFailed(true)
        })
        player.loadSource(candidates[0])
        player.attachMedia(video)
      },
      () => {
        if (!destroyed) playNatively()
      },
    )
    return () => {
      destroyed = true
      removeNative?.()
      removeGate?.remove()
      hls?.destroy()
      prefetcher?.destroy()
      preconnect.remove()
    }
  }, [url])

  return (
    <div className="fb-stream__player">
      {failed ? (
        <div className="fb-stream__player--link">
          <StatusMessage
            icon={MonitorPlay}
            compact
            title="This stream isn't playing right now"
            message="The provider's feed may be offline. Try another source or open it in a new tab."
          />
        </div>
      ) : (
        <video ref={videoRef} controls playsInline autoPlay muted aria-label={`${title} stream`} />
      )}
    </div>
  )
}

function StreamPlayer({ source, title }: { source: StreamSource; title: string }) {
  if (source.kind === 'embed') {
    return (
      <div className="fb-stream__player">
        <iframe
          src={source.url}
          title={`${title} stream`}
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          allowFullScreen
          referrerPolicy="no-referrer"
          // No popups or top-level navigation from third-party players.
          sandbox="allow-scripts allow-same-origin allow-presentation"
        />
      </div>
    )
  }
  if (source.kind === 'hls') return <HlsPlayer url={source.url} title={title} />
  return (
    <div className="fb-stream__player fb-stream__player--link">
      <a className="btn btn--primary" href={source.url} target="_blank" rel="noopener noreferrer nofollow">
        Watch {source.label}
      </a>
    </div>
  )
}
