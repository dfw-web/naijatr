import { useState } from 'react'
import { ExternalLink, MessageSquareText } from 'lucide-react'
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
        Watch {source.label}
      </a>
    </div>
  )
}
