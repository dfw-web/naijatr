import { useEffect, useRef, useState } from 'react'
import { errorMessage, fetchSources, type Episode, type VideoSource } from './api'
import type { DramaProvider } from './format'

interface DramaPlayerProps {
  provider: DramaProvider
  dramaId: string
  title: string
  episode: Episode
  /** The next playable episode, for "Next" and autoplay at the end. */
  next: Episode | null
  previous: Episode | null
  onEpisode: (episode: Episode) => void
  onClose: () => void
}

/**
 * The vertical (9:16) player for one episode. MP4 links play in the <video>
 * element; HLS links use the browser's own player where there is one (Safari),
 * otherwise hls.js, downloaded only when needed. When an episode ends, the
 * next one starts.
 */
export function DramaPlayer({ provider, dramaId, title, episode, next, previous, onEpisode, onClose }: DramaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [sources, setSources] = useState<VideoSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The episode's links, asked for when it's opened (they're signed and expire).
  // The page gives each episode its own player (key), so this starts empty.
  useEffect(() => {
    const controller = new AbortController()
    fetchSources(provider, dramaId, episode.id, controller.signal).then(setSources, (err: Error) => {
      if (err.name !== 'AbortError') setError(errorMessage(err))
    })
    return () => controller.abort()
  }, [provider, dramaId, episode.id])

  useEffect(() => {
    const video = videoRef.current
    const source = sources?.[0]
    if (!video || !source) return
    let destroy: (() => void) | undefined
    let cancelled = false
    const play = () => void video.play().catch(() => {})
    const failed = () =>
      setError(
        source.type === 'hls'
          ? 'This video won’t play in this browser. Try Safari, or another drama.'
          : 'This video won’t load right now. Try again in a minute.',
      )

    // H.265 (NetShort): most phones, Chrome and Safari play it; some browsers (e.g. Edge without the HEVC add-on) can't.
    if (source.codec === 'hevc' && !video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"')) {
      setError('This app’s videos don’t play in this browser. Try Chrome, Safari, or your phone.')
      return
    }
    if (source.type === 'mp4' || video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source.url
      play()
    } else {
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return
        if (!Hls.isSupported()) return failed()
        const hls = new Hls({ maxBufferLength: 20 })
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) failed()
        })
        hls.loadSource(source.url)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, play)
        destroy = () => hls.destroy()
      }, failed)
    }
    video.addEventListener('error', failed)
    return () => {
      cancelled = true
      video.removeEventListener('error', failed)
      destroy?.()
      video.removeAttribute('src')
      video.load()
    }
  }, [sources])

  // Escape closes; the arrow keys change episode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' && next) onEpisode(next)
      else if (event.key === 'ArrowLeft' && previous) onEpisode(previous)
    }
    window.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [next, previous, onEpisode, onClose])

  return (
    <div className="dr-player" role="dialog" aria-modal="true" aria-label={`${title}, episode ${episode.number}`}>
      <div className="dr-player__bar">
        <button type="button" className="dr-player__close" onClick={onClose} aria-label="Close player">
          ✕
        </button>
        <p className="dr-player__title">
          {title} <span>· Episode {episode.number}</span>
        </p>
      </div>
      <div className="dr-player__stage">
        {error ? (
          <p className="dr-player__message" role="alert">
            {error}
          </p>
        ) : (
          <>
            {!sources && <p className="dr-player__message">Loading…</p>}
            <video
              ref={videoRef}
              className="dr-player__video"
              controls
              playsInline
              preload="auto"
              hidden={!sources}
              onEnded={() => next && onEpisode(next)}
            />
          </>
        )}
      </div>
      <div className="dr-player__nav">
        <button type="button" disabled={!previous} onClick={() => previous && onEpisode(previous)}>
          ‹ Previous
        </button>
        <button type="button" disabled={!next} onClick={() => next && onEpisode(next)}>
          Next ›
        </button>
      </div>
    </div>
  )
}
