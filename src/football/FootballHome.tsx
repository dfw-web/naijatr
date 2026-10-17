import { useMemo, useState } from 'react'
import { CalendarDays, Radio, SearchX } from 'lucide-react'
import { StatusMessage } from '../components/StatusMessage'
import { describeFootballError, useFootball } from './api'
import { groupByLeague, localDate, matchesQuery, sortByImportance, type OpenMatch } from './format'
import { LeagueBlock, MatchListSkeleton, WatchBlock } from './MatchList'
import { Standings } from './Standings'
import type { Fixture } from './types'

const LIVE_REFRESH_MS = 60_000
const TODAY_REFRESH_MS = 5 * 60_000

interface FootballHomeProps {
  query: string
  onOpenMatch: OpenMatch
}

export function FootballHome({ query, onOpenMatch }: FootballHomeProps) {
  const filtering = query.trim().length > 0
  // Which live matches have a stream. Optional: if it fails, nothing is marked.
  const { data: watchable } = useFootball<number[]>('watchable', LIVE_REFRESH_MS)
  const watchIds = useMemo(() => new Set(watchable ?? []), [watchable])
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
        <LiveMatches query={query} onOpenMatch={onOpenMatch} watchIds={watchIds} />
      </section>

      <section className="fb-section" aria-labelledby="fb-today-title">
        <h2 id="fb-today-title" className="fb-section__title">
          <CalendarDays aria-hidden="true" /> Today&apos;s fixtures &amp; results
        </h2>
        <TodayMatches query={query} onOpenMatch={onOpenMatch} watchIds={watchIds} />
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

interface ListProps extends FootballHomeProps {
  /** Ids of matches that have a stream. */
  watchIds: ReadonlySet<number>
}

function LiveMatches({ query, onOpenMatch, watchIds }: ListProps) {
  const { data, stale, error, loading, retry } = useFootball<Fixture[]>('live', LIVE_REFRESH_MS)
  const streaming = useMemo(
    () => sortByImportance((data ?? []).filter((f) => watchIds.has(f.fixture.id) && matchesQuery(f, query))),
    [data, watchIds, query],
  )
  const rest = useMemo(() => (data ?? []).filter((f) => !watchIds.has(f.fixture.id)), [data, watchIds])
  const groups = useFiltered(rest, query)

  if (loading) return <MatchListSkeleton rows={3} />
  if (error) {
    return <StatusMessage icon={Radio} compact tone="error" {...describeFootballError(error)} action={{ label: 'Try again', onClick: retry }} />
  }
  if (!groups.length && !streaming.length) {
    return query.trim() && data?.length ? (
      <StatusMessage icon={SearchX} compact title="No live matches for that search" />
    ) : (
      <StatusMessage icon={Radio} compact title="No live matches right now" message="Check back at kick-off. This list updates every minute." />
    )
  }
  return (
    <>
      {stale && <StaleNote />}
      <div className="fb-groups">
        {streaming.length > 0 && <WatchBlock fixtures={streaming} onOpen={onOpenMatch} />}
        {groups.map((group) => (
          <LeagueBlock key={group.id} group={group} onOpen={onOpenMatch} />
        ))}
      </div>
    </>
  )
}

function TodayMatches({ query, onOpenMatch, watchIds }: ListProps) {
  // Fixed for the page's lifetime so the cached day stays consistent.
  const [date] = useState(() => localDate())
  const { data, stale, error, loading, retry } = useFootball<Fixture[]>(`fixtures?date=${date}`, TODAY_REFRESH_MS)
  const [showAll, setShowAll] = useState(false)
  const groups = useFiltered(data, query)

  if (loading) return <MatchListSkeleton rows={5} />
  if (error) {
    return <StatusMessage icon={CalendarDays} compact tone="error" {...describeFootballError(error)} action={{ label: 'Try again', onClick: retry }} />
  }
  if (!groups.length) {
    return query.trim() && data?.length ? (
      <StatusMessage icon={SearchX} compact title="No matches today for that search" />
    ) : (
      <StatusMessage icon={CalendarDays} compact title="No matches scheduled today" />
    )
  }

  // Searching shows every league; otherwise the featured leagues come first
  // and the rest of the world's matches sit behind a button.
  const filtering = query.trim().length > 0
  const featured = groups.filter((g) => g.featured)
  const otherCount = groups.filter((g) => !g.featured).reduce((n, g) => n + g.fixtures.length, 0)
  const canToggle = !filtering && featured.length > 0 && otherCount > 0
  const visible = showAll || !canToggle ? groups : featured

  return (
    <>
      {stale && <StaleNote />}
      {!filtering && featured.length === 0 && (
        <p className="fb-note">No matches in the featured leagues today. Here&apos;s everything else.</p>
      )}
      <div className="fb-groups">
        {visible.map((group) => (
          <LeagueBlock key={group.id} group={group} onOpen={onOpenMatch} watchIds={watchIds} />
        ))}
      </div>
      {canToggle && (
        <button type="button" className="btn btn--ghost fb-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show featured leagues only' : `Show ${otherCount} more matches from other leagues`}
        </button>
      )}
    </>
  )
}

function StaleNote() {
  return <p className="fb-note">Showing the last update we have; fresh scores will load automatically.</p>
}
