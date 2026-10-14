import { MonitorPlay } from 'lucide-react'
import { hasStarted, isLive, matchLinkProps, statusLabel, type LeagueGroup } from './format'
import type { Fixture } from './types'

interface MatchRowProps {
  fixture: Fixture
  onOpen: (id: number) => void
}

export function TeamLogo({ src, size = 24 }: { src: string; size?: number }) {
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

export function MatchRow({ fixture, onOpen }: MatchRowProps) {
  const { home, away } = fixture.teams
  const live = isLive(fixture.fixture.status)
  const started = hasStarted(fixture.fixture.status)
  const score = (value: number | null) => (started && value !== null ? value : '')

  return (
    <li>
      <a
        className={`fb-match ${live ? 'fb-match--live' : ''}`}
        {...matchLinkProps(fixture.fixture.id, onOpen)}
        aria-label={`${home.name} ${started ? `${fixture.goals.home ?? 0} - ${fixture.goals.away ?? 0}` : 'vs'} ${away.name}, ${statusLabel(fixture)}`}
      >
        <span className="fb-match__status">
          {live && <span className="fb-pulse" aria-hidden="true" />}
          {statusLabel(fixture)}
          {live && (
            <span className="fb-match__watch">
              <MonitorPlay aria-hidden="true" /> Watch
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

export function LeagueBlock({ group, onOpen }: { group: LeagueGroup; onOpen: (id: number) => void }) {
  return (
    <section className="fb-league" aria-label={`${group.name}, ${group.country}`}>
      <h3 className="fb-league__title">
        <TeamLogo src={group.logo} size={18} />
        <span>{group.name}</span>
        <span className="fb-league__country">{group.country}</span>
      </h3>
      <ul className="fb-league__list">
        {group.fixtures.map((fixture) => (
          <MatchRow key={fixture.fixture.id} fixture={fixture} onOpen={onOpen} />
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
