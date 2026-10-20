import type { MouseEvent } from 'react'
import { isFeaturedLeague, leagueRank } from '../../server/football/priority'
import type { Fixture, FixtureStatus, Season } from './types'

/** The Football section's pages, all under /football. */
export const FOOTBALL_PATH = '/football'

export type FootballRoute = { page: 'home' } | { page: 'match'; id: string }

const MATCH_PATH = /^\/football\/match\/([1-9]\d{0,9})\/?$/

export const isFootballPath = (pathname: string) =>
  pathname === FOOTBALL_PATH || pathname.startsWith(`${FOOTBALL_PATH}/`)

export function routeFromPath(pathname: string): FootballRoute {
  const match = MATCH_PATH.exec(pathname)
  return match ? { page: 'match', id: match[1] } : { page: 'home' }
}

/** A match page, optionally opened on one tab (`?tab=watch`). */
export const pathForMatch = (id: number | string, tab?: MatchTab) =>
  `${FOOTBALL_PATH}/match/${id}${tab ? `?tab=${tab}` : ''}`

/** Match page tabs that can be linked to directly. */
export type MatchTab = 'watch'

export type OpenMatch = (id: number, tab?: MatchTab) => void

/** Opens in-app on a plain click; still a real link for new tabs and sharing. */
export function matchLinkProps(id: number, onOpen: OpenMatch, tab?: MatchTab) {
  return {
    href: pathForMatch(id, tab),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      onOpen(id, tab)
    },
  }
}

/** Leagues with standings tabs, in tab order (ids match server/football/handlers.ts). */
export const FEATURED_LEAGUES = [
  { id: 39, name: 'Premier League' },
  { id: 140, name: 'La Liga' },
  { id: 2, name: 'Champions League' },
  { id: 3, name: 'Europa League' },
  { id: 848, name: 'Conference League' },
  { id: 307, name: 'Saudi Pro League' },
] as const

const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'])
const FINISHED = new Set(['FT', 'AET', 'PEN'])

export const isLive = (status: FixtureStatus) => LIVE.has(status.short)
export const isFinished = (status: FixtureStatus) => FINISHED.has(status.short)
export const hasStarted = (status: FixtureStatus) => isLive(status) || isFinished(status)

const OTHER_STATUS: Record<string, string> = {
  PST: 'Postponed',
  CANC: 'Cancelled',
  ABD: 'Abandoned',
  AWD: 'Awarded',
  WO: 'Walkover',
  TBD: 'TBD',
  SUSP: 'Suspended',
  INT: 'Interrupted',
}

export const kickoffTime = (fixture: Fixture) =>
  new Date(fixture.fixture.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Short status for a match row: 63', 45+2', HT, FT, a kickoff time or "Postponed". */
export function statusLabel(fixture: Fixture) {
  const { status } = fixture.fixture
  if (status.short === 'HT') return 'HT'
  if (status.short === 'BT') return 'Break'
  if (status.short === 'P') return 'Pens'
  if (isLive(status) && status.elapsed !== null) {
    return `${status.elapsed}${status.extra ? `+${status.extra}` : ''}'`
  }
  if (isLive(status)) return 'Live'
  if (isFinished(status)) return status.short
  if (OTHER_STATUS[status.short]) return OTHER_STATUS[status.short]
  return kickoffTime(fixture)
}

/** "2026/27" for seasons spanning two years, "2027" otherwise. */
export function seasonLabel(season: Season) {
  const startYear = season.start ? Number(season.start.slice(0, 4)) : season.year
  const endYear = season.end ? Number(season.end.slice(0, 4)) : startYear
  return endYear > startYear ? `${startYear}/${String(endYear).slice(-2)}` : String(startYear)
}

/**
 * The order of the "Watch live" list: Premier League, La Liga, Champions
 * League, Europa League, Conference League (see server/football/priority.ts).
 * API order is kept within a league rank.
 */
export function sortByImportance(fixtures: Fixture[]): Fixture[] {
  return [...fixtures].sort((a, b) => leagueRank(a.league) - leagueRank(b.league))
}

/** A match is about to kick off, or has but isn't listed as started yet (as on the server, server/football/handlers.ts). */
export function kickoffDue(fixtures: Fixture[], now: number): boolean {
  return fixtures.some(({ fixture }) => {
    const kickoff = Date.parse(fixture.date)
    return fixture.status.short === 'NS' && kickoff - 2 * 60_000 <= now && now <= kickoff + 20 * 60_000
  })
}

/** The viewer's local date as YYYY-MM-DD. */
export function localDate(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export interface LeagueGroup {
  id: number
  name: string
  country: string
  logo: string
  featured: boolean
  fixtures: Fixture[]
}

/** Groups fixtures by league: featured leagues first, in tab order, then any others by country. */
export function groupByLeague(fixtures: Fixture[]): LeagueGroup[] {
  const groups = new Map<number, LeagueGroup>()
  for (const item of fixtures) {
    const { league } = item
    let group = groups.get(league.id)
    if (!group) {
      group = {
        id: league.id,
        name: league.name,
        country: league.country,
        logo: league.logo,
        featured: isFeaturedLeague(league),
        fixtures: [],
      }
      groups.set(league.id, group)
    }
    group.fixtures.push(item)
  }
  for (const group of groups.values()) group.fixtures.sort((a, b) => a.fixture.timestamp - b.fixture.timestamp)
  return [...groups.values()].sort((a, b) =>
    a.featured && b.featured
      ? leagueRank(a) - leagueRank(b)
      : a.featured !== b.featured
        ? (a.featured ? -1 : 1)
        : a.country.localeCompare(b.country) || a.name.localeCompare(b.name),
  )
}

/** Case-insensitive match on team, league or country names. */
export function matchesQuery(fixture: Fixture, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [fixture.teams.home.name, fixture.teams.away.name, fixture.league.name, fixture.league.country].some(
    (name) => name.toLowerCase().includes(q),
  )
}
