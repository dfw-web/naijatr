import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Radio, SearchX } from 'lucide-react'
import { StatusMessage } from '../components/StatusMessage'
import { describeFootballError, useFootball } from './api'
import { groupByLeague, kickoffDue, localDate, matchesQuery, sortByImportance, type OpenMatch } from './format'
import { LeagueBlock, MatchListSkeleton, WatchBlock } from './MatchList'
import { Standings } from './Standings'
import type { Fixture } from './types'

/** Scores and streams change slowly enough that every few minutes is plenty (see useFootball). */
const LIVE_REFRESH_MS = 5 * 60_000
const TODAY_REFRESH_MS = 10 * 60_000
/** Around a kick-off, every minute, so the match moves to "Live now" soon after it starts. */
const KICKOFF_REFRESH_MS = 60_000

/** The time, updated once a minute (to notice a kick-off coming up). */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

interface FootballHomeProps {
  query: string
  onOpenMatch: OpenMatch
}

export function FootballHome({ query, onOpenMatch }: FootballHomeProps) {
  const filtering = query.trim().length > 0
  // Fixed for the page's lifetime so the cached day stays consistent.
  const [date] = useState(() => localDate())
  const now = useMinuteClock()
  const [todayRefresh, setTodayRefresh] = useState(TODAY_REFRESH_MS)
  const today = useFootball<Fixture[]>(`fixtures?date=${date}`, todayRefresh)
  const due = kickoffDue(today.data ?? [], now)
  if ((due ? KICKOFF_REFRESH_MS : TODAY_REFRESH_MS) !== todayRefresh) setTodayRefresh(due ? KICKOFF_REFRESH_MS : TODAY_REFRESH_MS)
  const liveRefresh = due ? KICKOFF_REFRESH_MS : LIVE_REFRESH_MS
  // Which live matches have a stream. Optional: if it fails, nothing is marked.
  const { data: watchable } = useFootball<number[]>('watchable', liveRefresh)
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
        <LiveMatches query={query} onOpenMatch={onOpenMatch} watchIds={watchIds} refreshMs={liveRefresh} />
      </section>

      <section className="fb-section" aria-labelledby="fb-today-title">
        <h2 id="fb-today-title" className="fb-section__title">
          <CalendarDays aria-hidden="true" /> Today&apos;s fixtures &amp; results
        </h2>
        <TodayMatches query={query} onOpenMatch={onOpenMatch} watchIds={watchIds} today={today} />
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

function LiveMatches({ query, onOpenMatch, watchIds, refreshMs }: ListProps & { refreshMs: number }) {
  const { data, stale, error, loading, retry } = useFootball<Fixture[]>('live', refreshMs)
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
      <StatusMessage icon={Radio} compact title="No live matches right now" message="Premier League, La Liga, Champions League, Europa League and Conference League matches show here at kick-off." />
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

function TodayMatches({ query, onOpenMatch, watchIds, today }: ListProps & { today: ReturnType<typeof useFootball<Fixture[]>> }) {
  const { data, stale, error, loading, retry } = today
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
          <LeagueBlock key={group.id} group={group} onOpen={onOpenMatch} watchIds={watchIds} />
        ))}
      </div>
    </>
  )
}

function StaleNote() {
  return <p className="fb-note">Showing the last update we have; fresh scores will load automatically.</p>
}
