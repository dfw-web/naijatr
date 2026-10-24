import { MonitorPlay } from 'lucide-react'
import { hasStarted, isLive, matchLinkProps, statusLabel, type LeagueGroup, type OpenMatch } from './format'
import type { Fixture } from './types'

interface MatchRowProps {
  fixture: Fixture
  onOpen: OpenMatch
  /** The match has a stream: show the Watch badge and open it on the Watch tab. */
  watchable?: boolean
}

export function TeamLogo({ src, size = 24 }: { src: string; size?: number }) {
  // Matches from the stream provider have no league logos.
  if (!src) return <span className="fb-logo" style={{ width: size, height: size }} aria-hidden="true" />
  return (
    <img
      className="fb-logo"
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={(event) => {
        event.currentTarget.style.visibility = 'hidden'
      }}
    />
  )
}

export function MatchRow({ fixture, onOpen, watchable: hasStream = false }: MatchRowProps) {
  const { home, away } = fixture.teams
  const live = isLive(fixture.fixture.status)
  // Every live match gets Watch now; the Watch tab says when no stream is up yet.
  const watchable = hasStream || live
  const started = hasStarted(fixture.fixture.status)
  const score = (value: number | null) => (started && value !== null ? value : '')

  return (
    <li>
      <a
        className={`fb-match ${live ? 'fb-match--live' : ''}`}
        {...matchLinkProps(fixture.fixture.id, onOpen, watchable ? 'watch' : undefined)}
        aria-label={`${home.name} ${started ? `${fixture.goals.home ?? 0} - ${fixture.goals.away ?? 0}` : 'vs'} ${away.name}, ${statusLabel(fixture)}${watchable ? ', watch live' : ''}`}
      >
        <span className="fb-match__status">
          {live && <span className="fb-pulse" aria-hidden="true" />}
          {statusLabel(fixture)}
          {watchable && (
            <span className="fb-match__badges" aria-hidden="true">
              <span className="fb-badge fb-badge--watch">
                <MonitorPlay /> Watch now
              </span>
            </span>
          )}
        </span>
        <span className="fb-match__teams">
          {[home, away].map((team, index) => (
            <span
              key={team.id}
              className={`fb-match__team ${started && team.winner === false ? 'fb-match__team--lost' : ''}`}
            >
              <TeamLogo src={team.logo} size={20} />
              <span className="fb-match__name">{team.name}</span>
              <span className="fb-match__score">{score(index === 0 ? fixture.goals.home : fixture.goals.away)}</span>
            </span>
          ))}
        </span>
      </a>
    </li>
  )
}

interface LeagueBlockProps {
  group: LeagueGroup
  onOpen: OpenMatch
  /** Ids of matches that have a stream. */
  watchIds?: ReadonlySet<number>
}

export function LeagueBlock({ group, onOpen, watchIds }: LeagueBlockProps) {
  return (
    <section className="fb-league" aria-label={`${group.name}, ${group.country}`}>
      <h3 className="fb-league__title">
        <TeamLogo src={group.logo} size={18} />
        <span>{group.name}</span>
        <span className="fb-league__country">{group.country}</span>
      </h3>
      <ul className="fb-league__list">
        {group.fixtures.map((fixture) => (
          <MatchRow
            key={fixture.fixture.id}
            fixture={fixture}
            onOpen={onOpen}
            watchable={watchIds?.has(fixture.fixture.id)}
          />
        ))}
      </ul>
    </section>
  )
}

/** Live matches with a stream, listed first under "Live now". */
export function WatchBlock({ fixtures, onOpen }: { fixtures: Fixture[]; onOpen: OpenMatch }) {
  return (
    <section className="fb-league fb-league--watch" aria-label="Watch live">
      <h3 className="fb-league__title">
        <MonitorPlay aria-hidden="true" className="fb-league__icon" />
        <span>Watch live</span>
        <span className="fb-league__country">
          {fixtures.length} {fixtures.length === 1 ? 'match' : 'matches'} live now
        </span>
      </h3>
      <ul className="fb-league__list">
        {fixtures.map((fixture) => (
          <MatchRow key={fixture.fixture.id} fixture={fixture} onOpen={onOpen} watchable />
        ))}
      </ul>
    </section>
  )
}

export function MatchListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="fb-league" aria-hidden="true">
      <div className="skeleton skeleton--text fb-skeleton-title" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="fb-skeleton-row">
          <div className="skeleton skeleton--text" style={{ width: '2.5rem' }} />
          <div className="fb-skeleton-row__teams">
            <div className="skeleton skeleton--text" style={{ width: `${55 + ((i * 13) % 30)}%` }} />
            <div className="skeleton skeleton--text" style={{ width: `${45 + ((i * 17) % 35)}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
