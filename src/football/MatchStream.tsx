import { useState } from 'react'
import { ExternalLink, MessageSquareText, MonitorPlay, TvMinimalPlay } from 'lucide-react'
import { StatusMessage } from '../components/StatusMessage'
import { useFootball, type FootballError } from './api'
import { hasStarted, isFinished, isLive } from './format'
import type { Fixture, MatchStream as MatchStreamData, StreamSource } from './types'

const LIVE_REFRESH_MS = 60_000

/** Copy for a failed stream lookup. It only affects this tab, never the match page. */
function describeStreamError(error: FootballError) {
  switch (error.reason) {
    case 'not-configured':
      return { title: "Streams aren't set up yet", message: 'The stream provider key has not been added on the server.' }
    case 'rate-limited':
      return { title: 'Streams are taking a breather', message: "We've reached the stream provider's request limit. Try again shortly." }
    case 'offline':
      return { title: "You're offline", message: 'Connect to the internet to look for a stream.' }
    default:
      return { title: 'Streams are unavailable right now', message: "We couldn't reach the stream provider. The rest of the match page still works." }
  }
}

/** The match page's "Watch" tab: stream sources and live commentary for one match. */
export function MatchStream({ match }: { match: Fixture }) {
  const live = isLive(match.fixture.status)
  const { data, error, loading, retry } = useFootball<MatchStreamData>(
    `stream?id=${match.fixture.id}`,
    live ? LIVE_REFRESH_MS : undefined,
  )
  const [selected, setSelected] = useState(0)

  if (loading) {
    return (
      <div className="fb-stream" aria-hidden="true">
        <div className="skeleton fb-stream__player" />
      </div>
    )
  }

  if (error) {
    return (
      <StatusMessage
        icon={MonitorPlay}
        compact
        {...describeStreamError(error)}
        action={error.reason === 'not-configured' ? undefined : { label: 'Try again', onClick: retry }}
      />
    )
  }

  if (!data?.available) {
    const message = isFinished(match.fixture.status)
      ? 'This match has finished, so there is no live stream or commentary.'
      : hasStarted(match.fixture.status)
        ? "Our stream provider doesn't cover this match. Follow the score and events in the other tabs."
        : 'Check back closer to kick-off. Streams and commentary usually appear once the match is live.'
    return <StatusMessage icon={MonitorPlay} compact title="No stream for this match" message={message} />
  }

  const source = data.streams[Math.min(selected, data.streams.length - 1)]

  return (
    <div className="fb-stream">
      {source ? (
        <>
          {data.streams.length > 1 && (
            <div className="fb-tabs fb-stream__sources" role="group" aria-label="Stream sources">
              {data.streams.map((s, index) => (
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
      ) : (
        <StatusMessage
          icon={TvMinimalPlay}
          compact
          title="No video stream"
          message="Only commentary is available for this match."
        />
      )}

      <section className="fb-commentary" aria-label="Live commentary">
        <h3 className="fb-commentary__title">
          <MessageSquareText aria-hidden="true" /> Commentary
        </h3>
        {data.commentary.length ? (
          <ol className="fb-events">
            {data.commentary.map((line, index) => (
              <li key={index} className="fb-event">
                <span className="fb-event__minute">{line.minute ? `${line.minute.replace(/'$/, '')}'` : ''}</span>
                <span className="fb-event__text">
                  <span>{line.text}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="fb-stream__note">No commentary for this match yet.</p>
        )}
      </section>
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
  if (source.kind === 'hls') {
    // Native HLS (Safari, most mobile browsers); elsewhere "Open in a new tab" below.
    return (
      <div className="fb-stream__player">
        <video src={source.url} controls playsInline autoPlay muted aria-label={`${title} stream`} />
      </div>
    )
  }
  return (
    <div className="fb-stream__player fb-stream__player--link">
      <a className="btn btn--primary" href={source.url} target="_blank" rel="noopener noreferrer nofollow">
        <MonitorPlay aria-hidden="true" /> Watch {source.label}
      </a>
    </div>
  )
}
