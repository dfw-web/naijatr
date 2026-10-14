import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import FootballApp from './FootballApp'
import type { Fixture } from './types'

const fixture = (id: number, overrides: Partial<Fixture> = {}): Fixture => ({
  fixture: { id, date: '2026-10-14T19:00:00+00:00', timestamp: 1792004400 + id, status: { long: 'Not Started', short: 'NS', elapsed: null } },
  league: { id: 2, name: 'UEFA Champions League', country: 'World', logo: '' },
  teams: { home: { id: id * 10, name: `Home ${id}`, logo: '' }, away: { id: id * 10 + 1, name: `Away ${id}`, logo: '' } },
  goals: { home: null, away: null },
  ...overrides,
})

const LIVE: Fixture = fixture(1, {
  fixture: { id: 1, date: '2026-10-14T18:00:00+00:00', timestamp: 1792000800, status: { long: 'Second Half', short: '2H', elapsed: 63 } },
  league: { id: 39, name: 'Premier League', country: 'England', logo: '' },
  teams: { home: { id: 10, name: 'Arsenal', logo: '' }, away: { id: 11, name: 'Chelsea', logo: '' } },
  goals: { home: 2, away: 1 },
})

type Routes = Record<string, { status?: number; body: unknown }>

/** Stubs fetch for /api/football/* by route name (live, fixtures, standings, match). */
function mockApi(routes: Routes) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    expect(url.startsWith('/api/football/')).toBe(true)
    const name = url.slice('/api/football/'.length).split('?')[0]
    const route = routes[name] ?? { status: 404, body: { error: 'not-found' } }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const SEASON = { year: 2026, start: '2026-08-21', end: '2027-05-30' }

beforeEach(() => {
  window.history.replaceState(null, '', '/football')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Football page', () => {
  it('shows live matches, today’s fixtures and a friendly plan message for standings', async () => {
    const fetchMock = mockApi({
      live: { body: { data: [LIVE] } },
      fixtures: { body: { data: [LIVE, fixture(2)] } },
      standings: { status: 403, body: { error: 'plan', season: SEASON } },
    })
    render(<FootballApp />)

    const live = screen.getByRole('region', { name: /Live now/ })
    expect(await within(live).findByRole('link', { name: "Arsenal 2 - 1 Chelsea, 63'" })).toHaveAttribute(
      'href',
      '/football/match/1',
    )
    const today = screen.getByRole('region', { name: /Today/ })
    expect(await within(today).findByRole('link', { name: /Home 2 vs Away 2/ })).toBeInTheDocument()
    expect(await screen.findByText("Premier League 2026/27 standings aren't available")).toBeInTheDocument()

    expect(screen.getByRole('tab', { name: 'Premier League' })).toHaveAttribute('aria-selected', 'true')
    for (const name of ['La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League', 'NPFL']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/football\/fixtures\?date=\d{4}-\d{2}-\d{2}$/), expect.anything())
  })

  it('shows empty states when nothing is on', async () => {
    mockApi({
      live: { body: { data: [] } },
      fixtures: { body: { data: [] } },
      standings: { body: { data: [], season: SEASON } },
    })
    render(<FootballApp />)
    expect(await screen.findByText('No live matches right now')).toBeInTheDocument()
    expect(await screen.findByText('No matches scheduled today')).toBeInTheDocument()
    expect(await screen.findByText('No standings yet')).toBeInTheDocument()
  })

  it('shows a friendly message, not a broken page, when rate limited', async () => {
    mockApi({
      live: { status: 429, body: { error: 'rate-limited' } },
      fixtures: { status: 429, body: { error: 'rate-limited' } },
      standings: { status: 429, body: { error: 'rate-limited' } },
    })
    render(<FootballApp />)
    expect(await screen.findAllByText('Football data is taking a breather')).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(3)
  })

  it('renders a standings table and switches league tabs', async () => {
    const row = (rank: number, name: string) => ({
      rank,
      team: { id: rank, name, logo: '' },
      points: 30 - rank,
      goalsDiff: 10 - rank,
      group: 'Premier League',
      form: 'WWDLW',
      description: null,
      all: { played: 10, win: 8, draw: 1, lose: 1 },
    })
    const fetchMock = mockApi({
      live: { body: { data: [] } },
      fixtures: { body: { data: [] } },
      standings: { body: { data: [{ league: { id: 39, name: 'Premier League', standings: [[row(1, 'Arsenal'), row(2, 'Liverpool')]] } }], season: SEASON } },
    })
    const user = userEvent.setup()
    render(<FootballApp />)

    const table = await screen.findByRole('table')
    expect(within(table).getByRole('rowheader', { name: 'Arsenal' })).toBeInTheDocument()
    expect(screen.getByText('2026/27 season')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'NPFL' }))
    expect(screen.getByRole('tab', { name: 'NPFL' })).toHaveAttribute('aria-selected', 'true')
    expect(fetchMock).toHaveBeenCalledWith('/api/football/standings?league=399', expect.anything())
  })

  it('opens match details with events, and lineups/stats fall back gracefully', async () => {
    const detailed: Fixture = {
      ...LIVE,
      events: [
        {
          time: { elapsed: 12, extra: null },
          team: { id: 10, name: 'Arsenal', logo: '' },
          player: { id: 5, name: 'B. Saka' },
          assist: { id: 6, name: 'M. Ødegaard' },
          type: 'Goal',
          detail: 'Normal Goal',
          comments: null,
        },
      ],
      lineups: [],
      statistics: [],
    }
    mockApi({
      live: { body: { data: [LIVE] } },
      fixtures: { body: { data: [] } },
      standings: { body: { data: [], season: SEASON } },
      match: { body: { data: detailed } },
    })
    const user = userEvent.setup()
    render(<FootballApp />)

    await user.click(await screen.findByRole('link', { name: "Arsenal 2 - 1 Chelsea, 63'" }))
    expect(window.location.pathname).toBe('/football/match/1')
    expect(await screen.findByRole('heading', { level: 1, name: 'Arsenal vs Chelsea' })).toBeInTheDocument()
    expect(screen.getByText('B. Saka')).toBeInTheDocument()
    expect(screen.getByText('Assist: M. Ødegaard')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Lineups' }))
    expect(screen.getByText("Lineups aren't available")).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Stats' }))
    expect(screen.getByText("Match stats aren't available")).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /All football/ }))
    expect(window.location.pathname).toBe('/football')
  })

  it('opens a match page directly from its URL', async () => {
    window.history.replaceState(null, '', '/football/match/1')
    mockApi({ match: { status: 404, body: { error: 'not-found' } } })
    render(<FootballApp />)
    expect(await screen.findByText('Match not found')).toBeInTheDocument()
  })
})

describe('Football navigation link', () => {
  it('appears in the movie app’s main navigation', () => {
    window.history.replaceState(null, '', '/')
    render(<App />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(nav).getByRole('button', { name: 'Football' })).toBeInTheDocument()
  })
})
