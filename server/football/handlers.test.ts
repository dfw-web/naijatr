import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import liveFunction from '../../api/football/live'
import {
  classifyApiErrors,
  createFootballCache,
  FOOTBALL_ORIGIN,
  FOOTBALL_TTL,
  handleFootball,
  splitFootballUrl,
  type FootballContext,
} from './handlers'

const KEY = 'test-football-key'
const NOW = Date.parse('2026-10-14T12:00:00Z')

/** Minimal ServerResponse stand-in that records what a handler sent. */
function fakeResponse() {
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    body: undefined as string | undefined,
    headers,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value
    },
    end: (body?: string) => {
      res.body = body
    },
  }
  return res as typeof res & ServerResponse
}

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null') as Record<string, unknown>

const apiBody = (response: unknown, errors: unknown = []) =>
  new Response(JSON.stringify({ errors, response }), { headers: { 'Content-Type': 'application/json' } })

/** A context whose clock can be moved forward. */
function setup(fetchImpl: ReturnType<typeof vi.fn>, key = KEY) {
  let now = NOW
  const ctx: FootballContext = {
    key,
    cache: createFootballCache(() => now),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  }
  return { ctx, advance: (seconds: number) => (now += seconds * 1000) }
}

async function get(ctx: FootballContext, route: string, query = '') {
  const res = fakeResponse()
  await handleFootball(ctx, 'GET', route, new URLSearchParams(query), res)
  return res
}

const LIVE_MATCH = { fixture: { id: 1, status: { short: '2H', elapsed: 63 } }, goals: { home: 1, away: 0 } }

describe('football API: configuration and auth', () => {
  it('answers 503 without calling upstream when the key is missing', async () => {
    const fetchImpl = vi.fn()
    const { ctx } = setup(fetchImpl, '')
    const res = await get(ctx, 'live')
    expect(res.statusCode).toBe(503)
    expect(json(res)).toEqual({ error: 'not-configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends the key upstream in x-apisports-key and never back to the browser', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(apiBody([LIVE_MATCH]))
    const { ctx } = setup(fetchImpl)
    const res = await get(ctx, 'live')

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${FOOTBALL_ORIGIN}/fixtures?live=all`)
    expect(url).not.toContain(KEY)
    expect((init.headers as Record<string, string>)['x-apisports-key']).toBe(KEY)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ data: [LIVE_MATCH] })
    expect(res.body).not.toContain(KEY)
    expect(JSON.stringify(res.headers)).not.toContain(KEY)
  })

  it('reports a rejected key as auth without leaking upstream text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(apiBody([], { token: 'Error/Missing application key.' }))
    const { ctx } = setup(fetchImpl)
    const res = await get(ctx, 'live')
    expect(res.statusCode).toBe(502)
    expect(json(res)).toEqual({ error: 'auth' })
  })

  it('rejects unknown routes and other methods', async () => {
    const { ctx } = setup(vi.fn())
    expect((await get(ctx, 'odds')).statusCode).toBe(404)
    const res = fakeResponse()
    await handleFootball(ctx, 'POST', 'live', new URLSearchParams(), res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe('GET, HEAD')
  })
})

describe('football API: upstream errors and rate limits', () => {
  it('turns an HTTP error into 502 upstream-error', async () => {
    const { ctx } = setup(vi.fn().mockResolvedValue(new Response('oops', { status: 500 })))
    const res = await get(ctx, 'live')
    expect(res.statusCode).toBe(502)
    expect(json(res)).toEqual({ error: 'upstream-error' })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('turns a network failure into 502 unreachable', async () => {
    const { ctx } = setup(vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const res = await get(ctx, 'live')
    expect(res.statusCode).toBe(502)
    expect(json(res)).toEqual({ error: 'unreachable' })
  })

  it('treats a non-JSON body as an upstream error', async () => {
    const { ctx } = setup(vi.fn().mockResolvedValue(new Response('<html>')))
    expect(json(await get(ctx, 'live'))).toEqual({ error: 'upstream-error' })
  })

  it.each([
    ['HTTP 429', () => new Response('', { status: 429 })],
    ['per-minute limit', () => apiBody([], { rateLimit: 'Too many requests.' })],
    ['daily limit', () => apiBody([], { requests: 'You have reached the request limit for the day' })],
  ])('answers 429 with Retry-After for a %s', async (_, response) => {
    const fetchImpl = vi.fn().mockImplementation(async () => response())
    const { ctx } = setup(fetchImpl)
    const res = await get(ctx, 'live')
    expect(res.statusCode).toBe(429)
    expect(json(res)).toEqual({ error: 'rate-limited' })
    expect(res.headers['retry-after']).toBe(String(FOOTBALL_TTL.rateLimited))
  })

  it('does not call upstream again while rate limited', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('', { status: 429 }))
    const { ctx, advance } = setup(fetchImpl)
    await get(ctx, 'live')
    advance(30)
    expect((await get(ctx, 'live')).statusCode).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('classifies API-Football error objects', () => {
    expect(classifyApiErrors({ requests: 'limit' })).toBe('rate-limited')
    expect(classifyApiErrors({ rateLimit: 'slow down' })).toBe('rate-limited')
    expect(classifyApiErrors({ plan: 'Free plans do not have access' })).toBe('plan')
    expect(classifyApiErrors({ token: 'bad' })).toBe('auth')
    expect(classifyApiErrors({ something: 'else' })).toBe('upstream-error')
    expect(classifyApiErrors(['odd'])).toBe('upstream-error')
  })
})

describe('football API: caching', () => {
  it('caches live scores for 60 seconds, in memory and on the CDN', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => apiBody([LIVE_MATCH]))
    const { ctx, advance } = setup(fetchImpl)

    const first = await get(ctx, 'live')
    expect(first.headers['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60')
    advance(45)
    const second = await get(ctx, 'live')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second.headers['cache-control']).toContain('s-maxage=15')
    advance(16)
    await get(ctx, 'live')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("caches a day's fixtures for 5 minutes", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => apiBody([]))
    const { ctx, advance } = setup(fetchImpl)
    await get(ctx, 'fixtures', 'date=2026-10-14')
    advance(299)
    await get(ctx, 'fixtures', 'date=2026-10-14')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    advance(2)
    await get(ctx, 'fixtures', 'date=2026-10-14')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${FOOTBALL_ORIGIN}/fixtures?date=2026-10-14`)
  })

  it('serves the last good answer, marked stale, when a refresh fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiBody([LIVE_MATCH]))
      .mockResolvedValueOnce(apiBody([], { requests: 'daily limit reached' }))
    const { ctx, advance } = setup(fetchImpl)
    await get(ctx, 'live')
    advance(61)
    const res = await get(ctx, 'live')
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ data: [LIVE_MATCH], stale: true })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('does not cache upstream errors (other than rate limits and plan limits)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(apiBody([LIVE_MATCH]))
    const { ctx } = setup(fetchImpl)
    expect((await get(ctx, 'live')).statusCode).toBe(502)
    expect((await get(ctx, 'live')).statusCode).toBe(200)
  })
})

describe('football API: fixtures', () => {
  it('only accepts yesterday, today or tomorrow', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => apiBody([]))
    const { ctx } = setup(fetchImpl)
    for (const date of ['2026-10-13', '2026-10-14', '2026-10-15']) {
      expect((await get(ctx, 'fixtures', `date=${date}`)).statusCode).toBe(200)
    }
    for (const query of ['date=2026-10-20', 'date=2026-1-1', 'date=nope', '']) {
      expect((await get(ctx, 'fixtures', query)).statusCode).toBe(400)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})

describe('football API: standings', () => {
  const season = (year: number) =>
    apiBody([{ league: { id: 39 }, seasons: [{ year, start: `${year}-08-21`, end: `${year + 1}-05-30`, current: true }] }])

  it('detects the current season from the API, then caches it', async () => {
    const table = [{ league: { id: 39, standings: [[{ rank: 1 }]] } }]
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      url.includes('/leagues?') ? season(2031) : apiBody(table),
    )
    const { ctx, advance } = setup(fetchImpl)

    const res = await get(ctx, 'standings', 'league=39')
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      `${FOOTBALL_ORIGIN}/leagues?id=39&current=true`,
      `${FOOTBALL_ORIGIN}/standings?league=39&season=2031`,
    ])
    expect(json(res)).toEqual({ season: { year: 2031, start: '2031-08-21', end: '2032-05-30' }, data: table })
    expect(res.headers['cache-control']).toContain('s-maxage=3600')

    advance(FOOTBALL_TTL.standings + 1)
    await get(ctx, 'standings', 'league=39')
    expect(fetchImpl).toHaveBeenCalledTimes(3) // the season lookup is still cached
  })

  it('reports a plan restriction with the season, and caches it for an hour', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      url.includes('/leagues?')
        ? season(2026)
        : apiBody([], { plan: 'Free plans do not have access to this season, try from 2022 to 2024.' }),
    )
    const { ctx, advance } = setup(fetchImpl)
    const res = await get(ctx, 'standings', 'league=39')
    expect(res.statusCode).toBe(403)
    expect(json(res)).toEqual({ error: 'plan', season: { year: 2026, start: '2026-08-21', end: '2027-05-30' } })
    advance(60)
    await get(ctx, 'standings', 'league=39')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('only serves the leagues that have tabs', async () => {
    const fetchImpl = vi.fn()
    const { ctx } = setup(fetchImpl)
    for (const query of ['league=1', 'league=abc', '']) {
      expect((await get(ctx, 'standings', query)).statusCode).toBe(400)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('football API: match details', () => {
  it('returns the single fixture and caches finished matches for an hour', async () => {
    const finished = { fixture: { id: 7, status: { short: 'FT' } }, events: [], lineups: [], statistics: [] }
    const fetchImpl = vi.fn().mockImplementation(async () => apiBody([finished]))
    const { ctx } = setup(fetchImpl)
    const res = await get(ctx, 'match', 'id=7')
    expect(fetchImpl.mock.calls[0][0]).toBe(`${FOOTBALL_ORIGIN}/fixtures?id=7`)
    expect(json(res)).toEqual({ data: finished })
    expect(res.headers['cache-control']).toContain('s-maxage=3600')
  })

  it('caches a live match for 60 seconds', async () => {
    const { ctx } = setup(vi.fn().mockImplementation(async () => apiBody([LIVE_MATCH])))
    expect((await get(ctx, 'match', 'id=1')).headers['cache-control']).toContain('s-maxage=60,')
  })

  it('answers 404 for an unknown match and 400 for a bad id', async () => {
    const { ctx } = setup(vi.fn().mockImplementation(async () => apiBody([])))
    expect((await get(ctx, 'match', 'id=99')).statusCode).toBe(404)
    expect((await get(ctx, 'match', 'id=0')).statusCode).toBe(400)
    expect((await get(ctx, 'match', 'id=1;drop')).statusCode).toBe(400)
  })
})

describe('football API: hosts', () => {
  it('splits mounted and full URLs', () => {
    expect(splitFootballUrl('/live').route).toBe('live')
    const { route, params } = splitFootballUrl('/api/football/fixtures?date=2026-10-14')
    expect(route).toBe('fixtures')
    expect(params.get('date')).toBe('2026-10-14')
  })

  it('the Vercel function answers 503 when API_FOOTBALL_KEY is not set', async () => {
    const saved = process.env.API_FOOTBALL_KEY
    delete process.env.API_FOOTBALL_KEY
    try {
      const res = fakeResponse()
      await liveFunction({ url: '/api/football/live', method: 'GET' } as never, res)
      expect(res.statusCode).toBe(503)
    } finally {
      if (saved !== undefined) process.env.API_FOOTBALL_KEY = saved
    }
  })
})
