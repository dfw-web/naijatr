import { useState } from 'react'
import { ArrowLeftRight, BarChart3, ChevronLeft, Goal, ShieldAlert, Tv, Users } from 'lucide-react'
import { StatusMessage } from '../components/StatusMessage'
import { AdBreak } from '../ads/AdBreak'
import { TelegramCard } from '../components/Telegram'
import { useAdTwice } from '../hooks/useAdTwice'
import { playAfterGate } from '../gate/gateStore'
import { playAfterAdBreak } from '../tv/tvAdBreakStore'
import { describeFootballError, useFootball } from './api'
import { FOOTBALL_PATH, hasStarted, isFinished, isLive, statusLabel } from './format'
import { TeamLogo } from './MatchList'
import { MatchStream } from './MatchStream'
import type { Fixture, FixtureEvent, Lineup, TeamStatistics } from './types'

const LIVE_REFRESH_MS = 60_000

type Tab = 'events' | 'watch' | 'lineups' | 'stats'

const TABS: { id: Tab; label: string }[] = [
  { id: 'events', label: 'Events' },
  { id: 'watch', label: 'Watch' },
  { id: 'lineups', label: 'Lineups' },
  { id: 'stats', label: 'Stats' },
]

interface MatchDetailsProps {
  id: string
  onBack: () => void
}

export function MatchDetails({ id, onBack }: MatchDetailsProps) {
  const [refreshMs, setRefreshMs] = useState<number | undefined>(LIVE_REFRESH_MS)
  const { data: match, error, loading, retry } = useFootball<Fixture>(`match?id=${id}`, refreshMs)
  const [tab, setTab] = useState<Tab>('events')
  const onTabClickCapture = useAdTwice(`match:${id}`)

  // Keep refreshing only while the match can still change.
  const shouldRefresh = !match || !isFinished(match.fixture.status) ? LIVE_REFRESH_MS : undefined
  if (shouldRefresh !== refreshMs) setRefreshMs(shouldRefresh)

  return (
    <div className="fb-page">
      <a
        className="fb-back"
        href={FOOTBALL_PATH}
        // The TV remote's Back key follows this link (see src/tv/remote.ts).
        data-tv-back
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
          event.preventDefault()
          onBack()
        }}
      >
        <ChevronLeft aria-hidden="true" /> All football
      </a>

      {loading ? (
        <HeaderSkeleton />
      ) : error ? (
        <StatusMessage
          icon={ShieldAlert}
          tone="error"
          {...describeFootballError(error)}
          action={error.reason === 'not-found' ? { label: 'Back to football', onClick: onBack } : { label: 'Try again', onClick: retry }}
        />
      ) : match ? (
        <>
          <MatchHeader match={match} />
          <div className="fb-tabs" role="tablist" aria-label="Match details" onClickCapture={onTabClickCapture}>
            {TABS.map((t) => (
              <button
                key={t.id}
                id={`fb-match-tab-${t.id}`}
                type="button"
                role="tab"
                className="fb-tab"
                aria-selected={tab === t.id}
                aria-controls="fb-match-panel"
                // The first Watch asks to join the Telegram channel (phones, tablets, TVs); on a TV, the ad break follows.
                onClick={() =>
                  t.id === 'watch'
                    ? playAfterGate(() => playAfterAdBreak(`match:${id}`, () => setTab('watch')))
                    : setTab(t.id)
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <div id="fb-match-panel" role="tabpanel" aria-labelledby={`fb-match-tab-${tab}`} className="fb-panel">
            {tab === 'events' && <Events match={match} />}
            {tab === 'watch' && <MatchStream match={match} />}
            {tab === 'lineups' && <Lineups lineups={match.lineups ?? []} />}
            {tab === 'stats' && <Stats stats={match.statistics ?? []} />}
          </div>
          <TelegramCard from="match" />
        </>
      ) : null}
      <AdBreak adKey={`match:${id}`} />
    </div>
  )
}

function MatchHeader({ match }: { match: Fixture }) {
  const { fixture, league, teams, goals, score } = match
  const started = hasStarted(fixture.status)
  const live = isLive(fixture.status)
  const kickoff = new Date(fixture.date).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const halftime = score?.halftime
  const penalties = score?.penalty

  return (
    <header className="fb-scoreboard">
      <h1 className="fb-sr-only">
        {teams.home.name} vs {teams.away.name}
      </h1>
      <p className="fb-scoreboard__league">
        <TeamLogo src={league.logo} size={18} /> {league.name}
        {league.round && <span> · {league.round}</span>}
      </p>
      <div className="fb-scoreboard__main">
        <div className="fb-scoreboard__team">
          <TeamLogo src={teams.home.logo} size={56} />
          <p className="fb-scoreboard__name">{teams.home.name}</p>
        </div>
        <div className="fb-scoreboard__centre">
          <p className="fb-scoreboard__score" aria-label={started ? `Score ${goals.home ?? 0} - ${goals.away ?? 0}` : 'Not started'}>
            {started ? `${goals.home ?? 0} - ${goals.away ?? 0}` : 'vs'}
          </p>
          <p className={`fb-scoreboard__status ${live ? 'fb-scoreboard__status--live' : ''}`}>
            {live && <span className="fb-pulse" aria-hidden="true" />}
            {started ? (live ? statusLabel(match) : fixture.status.long) : statusLabel(match)}
          </p>
          {penalties?.home != null && penalties.away != null && (
            <p className="fb-scoreboard__extra">Penalties {penalties.home} - {penalties.away}</p>
          )}
          {started && halftime?.home != null && halftime.away != null && (
            <p className="fb-scoreboard__extra">HT {halftime.home} - {halftime.away}</p>
          )}
        </div>
        <div className="fb-scoreboard__team">
          <TeamLogo src={teams.away.logo} size={56} />
          <p className="fb-scoreboard__name">{teams.away.name}</p>
        </div>
      </div>
      <p className="fb-scoreboard__meta">
        {kickoff}
        {fixture.venue?.name && ` · ${fixture.venue.name}${fixture.venue.city ? `, ${fixture.venue.city}` : ''}`}
        {fixture.referee && ` · Referee: ${fixture.referee}`}
      </p>
    </header>
  )
}

const NOT_AVAILABLE = 'API-Football may not cover this for every competition, and lineups usually appear shortly before kick-off.'

function eventIcon(event: FixtureEvent) {
  if (event.type === 'Goal') return <Goal className="fb-event__icon fb-event__icon--goal" aria-hidden="true" />
  if (event.type === 'Card') {
    return (
      <span
        className={`fb-card ${event.detail.toLowerCase().includes('red') ? 'fb-card--red' : 'fb-card--yellow'}`}
        aria-hidden="true"
      />
    )
  }
  if (event.type === 'subst') return <ArrowLeftRight className="fb-event__icon" aria-hidden="true" />
  return <Tv className="fb-event__icon" aria-hidden="true" />
}

function eventText(event: FixtureEvent) {
  if (event.type === 'subst') {
    // API-Football lists the player coming off as `player` and the one coming on as `assist`.
    return { main: event.assist.name ?? 'Substitution', sub: event.player.name ? `Off: ${event.player.name}` : null }
  }
  const sub = event.type === 'Goal' && event.assist.name ? `Assist: ${event.assist.name}` : event.detail
  return { main: event.player.name ?? event.detail, sub }
}

function Events({ match }: { match: Fixture }) {
  const events = [...(match.events ?? [])].sort(
    (a, b) => a.time.elapsed - b.time.elapsed || (a.time.extra ?? 0) - (b.time.extra ?? 0),
  )
  if (!events.length) {
    return (
      <StatusMessage
        icon={Goal}
        compact
        title={hasStarted(match.fixture.status) ? 'No events recorded' : 'No events yet'}
        message={hasStarted(match.fixture.status) ? NOT_AVAILABLE : 'Goals, cards and substitutions will appear here once the match starts.'}
      />
    )
  }
  return (
    <ol className="fb-events">
      {events.map((event, index) => {
        const home = event.team.id === match.teams.home.id
        const { main, sub } = eventText(event)
        return (
          <li key={index} className={`fb-event ${home ? 'fb-event--home' : 'fb-event--away'}`}>
            <span className="fb-event__minute">
              {event.time.elapsed}
              {event.time.extra ? `+${event.time.extra}` : ''}&apos;
            </span>
            {eventIcon(event)}
            <span className="fb-event__text">
              <span className="fb-event__main">{main}</span>
              {sub && <span className="fb-event__sub">{sub}</span>}
            </span>
            <span className="fb-sr-only">{event.team.name}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Lineups({ lineups }: { lineups: Lineup[] }) {
  if (!lineups.length) {
    return <StatusMessage icon={Users} compact title="Lineups aren't available" message={NOT_AVAILABLE} />
  }
  return (
    <div className="fb-lineups">
      {lineups.map((lineup) => (
        <section key={lineup.team.id} className="fb-lineup" aria-label={`${lineup.team.name} lineup`}>
          <h3 className="fb-lineup__team">
            <TeamLogo src={lineup.team.logo} size={22} /> {lineup.team.name}
            {lineup.formation && <span className="chip">{lineup.formation}</span>}
          </h3>
          <PlayerList title="Starting XI" players={lineup.startXI} />
          <PlayerList title="Substitutes" players={lineup.substitutes} />
          {lineup.coach?.name && <p className="fb-lineup__coach">Coach: {lineup.coach.name}</p>}
        </section>
      ))}
    </div>
  )
}

function PlayerList({ title, players }: { title: string; players: Lineup['startXI'] }) {
  if (!players.length) return null
  return (
    <>
      <h4 className="fb-lineup__heading">{title}</h4>
      <ul className="fb-lineup__players">
        {players.map(({ player }) => (
          <li key={`${player.id}-${player.name}`}>
            <span className="fb-lineup__number">{player.number ?? ''}</span>
            <span className="fb-lineup__name">{player.name}</span>
            {player.pos && <span className="fb-lineup__pos">{player.pos}</span>}
          </li>
        ))}
      </ul>
    </>
  )
}

const numeric = (value: number | string | null) => (value === null ? 0 : Number.parseFloat(String(value)) || 0)

function Stats({ stats }: { stats: TeamStatistics[] }) {
  const [home, away] = stats
  if (!home || !away || !home.statistics.length) {
    return <StatusMessage icon={BarChart3} compact title="Match stats aren't available" message={NOT_AVAILABLE} />
  }
  return (
    <ul className="fb-stats">
      {home.statistics.map((stat) => {
        const awayValue = away.statistics.find((s) => s.type === stat.type)?.value ?? null
        const h = numeric(stat.value)
        const a = numeric(awayValue)
        const share = h + a > 0 ? (h / (h + a)) * 100 : 50
        return (
          <li key={stat.type} className="fb-stat">
            <div className="fb-stat__values">
              <span>{stat.value ?? 0}</span>
              <span className="fb-stat__label">{stat.type}</span>
              <span>{awayValue ?? 0}</span>
            </div>
            <div className="fb-stat__bar" aria-hidden="true">
              <span className="fb-stat__home" style={{ width: `${share}%` }} />
              <span className="fb-stat__away" style={{ width: `${100 - share}%` }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function HeaderSkeleton() {
  return (
    <div className="fb-scoreboard" aria-hidden="true">
      <div className="skeleton skeleton--text" style={{ width: '40%', margin: '0 auto' }} />
      <div className="fb-scoreboard__main">
        <div className="fb-scoreboard__team">
          <div className="skeleton fb-skeleton-logo" />
          <div className="skeleton skeleton--text" style={{ width: '70%' }} />
        </div>
        <div className="skeleton fb-skeleton-score" />
        <div className="fb-scoreboard__team">
          <div className="skeleton fb-skeleton-logo" />
          <div className="skeleton skeleton--text" style={{ width: '70%' }} />
        </div>
      </div>
    </div>
  )
}
