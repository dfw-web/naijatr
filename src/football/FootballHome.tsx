import { useMemo, useState } from 'react'
import { CalendarDays, Radio, SearchX } from 'lucide-react'
import { StatusMessage } from '../components/StatusMessage'
import { describeFootballError, useFootball } from './api'
import { groupByLeague, localDate, matchesQuery, type OpenMatch } from './format'
import { LeagueBlock, MatchListSkeleton } from './MatchList'
import { Standings } from './Standings'
import type { Fixture } from './types'

/** Scores and streams change slowly enough that every few minutes is plenty (see useFootball). */
const LIVE_REFRESH_MS = 5 * 60_000
const TODAY_REFRESH_MS = 10 * 60_000

interface FootballHomeProps {
  query: string
  onOpenMatch: OpenMatch
}

export function FootballHome({ query, onOpenMatch }: FootballHomeProps) {
  const filtering = query.trim().length > 0
  return (
    <div className="fb-page">
      <header className="fb-header">
        <h1 className="fb-header__title">Football</h1>
        <p className="fb-header__subtitle">Live scores, live streams, today&apos;s fixtures and league tables.</p>
        {filtering && <p className="fb-header__filter">Showing matches for &ldquo;{query.trim()}&rdquo;</p>}
      </header>

      <section className="fb-section" aria-labelledby="fb-live-title">
        <h2 id="fb-live-title" className="fb-section__title">
          <span className="fb-pulse" aria-hidden="true" /> Live now
        </h2>
        <LiveMatches query={query} onOpenMatch={onOpenMatch} />
      </section>

      <section className="fb-section" aria-labelledby="fb-today-title">
        <h2 id="fb-today-title" className="fb-section__title">
          <CalendarDays aria-hidden="true" /> Today&apos;s fixtures &amp; results
        </h2>
        <TodayMatches query={query} onOpenMatch={onOpenMatch} />
      </section>

      <section className="fb-section" aria-labelledby="fb-standings-title">
        <h2 id="fb-standings-title" className="fb-section__title">Standings</h2>
        <Standings />
      </section>

      <p className="fb-credit">
        Football data by{' '}
        <a href="https://www.api-football.com" target="_blank" rel="noreferrer">
          API-Football
        </a>
        . Times are shown in your local time zone.
      </p>
    </div>
  )
}

function useFiltered(data: Fixture[] | undefined, query: string) {
  return useMemo(() => groupByLeague((data ?? []).filter((f) => matchesQuery(f, query))), [data, query])
}

/**
 * Every live match, by league (most important first). Open one and tap Watch
 * to see if it's streaming: streams are only looked up for the matches people
 * open, to spare the stream provider's request quota.
 */
function LiveMatches({ query, onOpenMatch }: FootballHomeProps) {
  const { data, stale, error, loading, retry } = useFootball<Fixture[]>('live', LIVE_REFRESH_MS)
  const groups = useFiltered(data, query)

  if (loading) return <MatchListSkeleton rows={3} />
  if (error) {
    return <StatusMessage icon={Radio} compact tone="error" {...describeFootballError(error)} action={{ label: 'Try again', onClick: retry }} />
  }
  if (!groups.length) {
    return query.trim() && data?.length ? (
      <StatusMessage icon={SearchX} compact title="No live matches for that search" />
    ) : (
      <StatusMessage icon={Radio} compact title="No live matches right now" message="Premier League, La Liga, Champions League, Europa League and Conference League matches show here at kick-off." />
    )
  }
  return (
    <>
      {stale && <StaleNote />}
      <div className="fb-groups">
        {groups.map((group) => (
          <LeagueBlock key={group.id} group={group} onOpen={onOpenMatch} />
        ))}
      </div>
    </>
  )
}

function TodayMatches({ query, onOpenMatch }: FootballHomeProps) {
  // Fixed for the page's lifetime so the cached day stays consistent.
  const [date] = useState(() => localDate())
  const { data, stale, error, loading, retry } = useFootball<Fixture[]>(`fixtures?date=${date}`, TODAY_REFRESH_MS)
  const groups = useFiltered(data, query)

  if (loading) return <MatchListSkeleton rows={5} />
  if (error) {
    return <StatusMessage icon={CalendarDays} compact tone="error" {...describeFootballError(error)} action={{ label: 'Try again', onClick: retry }} />
  }
  if (!groups.length) {
    return query.trim() && data?.length ? (
      <StatusMessage icon={SearchX} compact title="No matches today for that search" />
    ) : (
      <StatusMessage icon={CalendarDays} compact title="No matches scheduled today" message="Only Premier League, La Liga, Champions League, Europa League and Conference League matches are shown." />
    )
  }

  return (
    <>
      {stale && <StaleNote />}
      <div className="fb-groups">
        {groups.map((group) => (
          <LeagueBlock key={group.id} group={group} onOpen={onOpenMatch} />
        ))}
      </div>
    </>
  )
}

function StaleNote() {
  return <p className="fb-note">Showing the last update we have; fresh scores will load automatically.</p>
}
