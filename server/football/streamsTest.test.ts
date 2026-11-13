import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFootballCache, handleFootball } from './handlers'
import {
  CACHE_S,
  directServers,
  lagosDate,
  loadTestListing,
  parseTestMatch,
  readTags,
  readTestQuery,
  requestsToday,
  resetStreamsTestMemory,
  saveTag,
  summarizeTags,
  type TestDeps,
} from './streamsTest'

const NOW = Date.UTC(2026, 10, 13, 15, 0)

const apiMatch = (home: string, extra: Record<string, unknown> = {}) => ({
  match_time: String(NOW / 1000),
  match_status: 'live',
  home_team_name: home,
  home_team_logo: 'https://cdn.example/h.webp',
  homeTeamScore: '1',
  away_team_name: 'Malawi',
  away_team_logo: 'https://cdn.example/nologoo.png',
  awayTeamScore: '0',
  league_name: 'CAF Africa Cup of Nations',
  league_logo: 'https://cdn.example/l.png',
  servers: [
    { name: 'Server 1', url: 'https://hls.example/live/a/index.m3u8', type: 'direct', header: { 'user-agent': 'x' } },
    { name: 'Server 2', url: 'https://flv.example/live/a.flv', type: 'direct' },
    { name: 'Server 3', url: 'https://pull.example/r.m3u8', type: 'referer', header: { referer: 'https://x/' } },
    { name: 'Server 4', url: 'https://drm.example/a.mpd', type: 'drm' },
    { name: 'beIN EN', url: 'https://hls.example/live/hd-en-1.m3u8', type: 'direct' },
    { name: 'Server 6', url: 'http://plain.example/a.m3u8', type: 'direct' },
  ],
  ...extra,
})

const page = (matches: unknown[], hasNext = false) =>
  new Response(JSON.stringify({ matches, pagination: { hasNext } }), { headers: { 'Content-Type': 'application/json' } })

const deps = (fetchImpl: typeof fetch, extra: Partial<TestDeps> = {}): TestDeps => ({
  key: 'k',
  redis: { redisUrl: '', redisToken: '' },
  now: () => NOW,
  cap: 50,
  fetchImpl,
  ...extra,
})

const query = { status: 'live' as const, date: '13112026', league: '' }

afterEach(() => resetStreamsTestMemory())

describe('parsing', () => {
  it('keeps only direct https streams, with their format and an English hint', () => {
    const servers = directServers(apiMatch('Egypt').servers)
    expect(servers.map((s) => [s.name, s.format, s.englishHint])).toEqual([
      ['Server 1', 'hls', false],
      ['Server 2', 'flv', false],
      ['beIN EN', 'hls', true],
    ])
  })

  it('reads teams, logos, score, status, league and time', () => {
    expect(parseTestMatch(apiMatch('Egypt'))).toMatchObject({
      home: 'Egypt',
      away: 'Malawi',
      homeLogo: 'https://cdn.example/h.webp',
      awayLogo: null,
      score: '1 - 0',
      status: 'live',
      league: 'CAF Africa Cup of Nations',
      time: NOW,
    })
  })

  it('takes status, a DDMMYYYY date (today in Lagos by default) and a league', () => {
    expect(lagosDate(Date.UTC(2026, 10, 13, 23, 30))).toBe('14112026')
    expect(readTestQuery(new URLSearchParams(''), NOW)).toEqual({ status: 'live', date: '13112026', league: '' })
    expect(readTestQuery(new URLSearchParams('status=vs&date=14112026&league=Premier League'), NOW)).toEqual({ status: 'vs', date: '14112026', league: 'Premier League' })
    expect(readTestQuery(new URLSearchParams('status=done'), NOW)).toBeNull()
    expect(readTestQuery(new URLSearchParams('date=2026-11-13'), NOW)).toBeNull()
  })
})

describe('requests', () => {
  it('asks for type=direct with the RapidAPI headers, caches for 180 s and counts requests', async () => {
    let now = NOW
    const fetchImpl = vi.fn(async () => page([apiMatch('Egypt')])) as unknown as typeof fetch
    const d = deps(fetchImpl, { now: () => now })
    const first = await loadTestListing(d, query)
    expect(first).toMatchObject({ cached: false, stale: false, error: null })
    expect(first.matches).toHaveLength(1)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://football-live-streaming-api.p.rapidapi.com/matches?status=live&date=13112026&type=direct')
    expect(init.headers).toMatchObject({ 'X-RapidAPI-Key': 'k', 'X-RapidAPI-Host': 'football-live-streaming-api.p.rapidapi.com' })
    expect((await loadTestListing(d, query)).cached).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += CACHE_S * 1000 + 1
    await loadTestListing(d, query)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(await requestsToday(d)).toBe(2)
  })

  it('reads the next pages, at most 3', async () => {
    const fetchImpl = vi.fn(async (url: string) => page([apiMatch(`Team ${url.length}-${Math.random()}`)], true)) as unknown as typeof fetch
    const result = await loadTestListing(deps(fetchImpl), query)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(result.truncated).toBe(true)
    expect(vi.mocked(fetchImpl).mock.calls[1][0]).toContain('&page=2')
  })

  it('stops at the daily cap and serves the last answer', async () => {
    let now = NOW
    const fetchImpl = vi.fn(async () => page([apiMatch('Egypt')])) as unknown as typeof fetch
    const d = deps(fetchImpl, { cap: 1, now: () => now })
    await loadTestListing(d, query)
    now += CACHE_S * 1000 + 1
    const capped = await loadTestListing(d, query)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(capped).toMatchObject({ stale: true, error: 'daily-cap' })
    expect(capped.matches).toHaveLength(1)
  })

  it('reports a rate limit without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 429 })) as unknown as typeof fetch
    expect(await loadTestListing(deps(fetchImpl), query)).toMatchObject({ stale: true, error: 'rate-limited', matches: [] })
  })
})

describe('tags', () => {
  it('saves, replaces and clears a tag per match and stream name', async () => {
    const d = deps(vi.fn() as unknown as typeof fetch)
    await saveTag(d, { match: 'm1', name: 'Server 1', tag: 'arabic', url: 'https://a.example/x.m3u8', title: 'A vs B' })
    await saveTag(d, { match: 'm1', name: 'Server 1', tag: 'english', url: 'https://a.example/x.m3u8', title: 'A vs B' })
    await saveTag(d, { match: 'm1', name: 'Server 2', tag: 'french', url: 'https://b.example/y.m3u8', title: 'A vs B' })
    expect((await readTags(d)).map((t) => [t.name, t.tag, t.host])).toEqual([
      ['Server 1', 'english', 'a.example'],
      ['Server 2', 'french', 'b.example'],
    ])
    await saveTag(d, { match: 'm1', name: 'Server 2', tag: null, url: '', title: '' })
    expect(await readTags(d)).toHaveLength(1)
  })

  it('finds the names and hosts that keep turning out English', () => {
    const tag = (match: string, name: string, host: string, t: 'english' | 'arabic' | 'broken') => ({ match, name, host, tag: t, url: '', title: '', at: 0 })
    const summary = summarizeTags([
      tag('a', 'Server 1', 'en.example', 'english'),
      tag('b', 'Server 1', 'en.example', 'english'),
      tag('c', 'Server 1', 'en.example', 'english'),
      tag('a', 'Server 2', 'ar.example', 'arabic'),
      tag('b', 'Server 2', 'ar.example', 'broken'),
    ])
    expect(summary.byName[0]).toEqual({ value: 'Server 1', tagged: 3, english: 3, consistent: true })
    // Broken streams say nothing about the language.
    expect(summary.byHost.find((g) => g.value === 'ar.example')).toEqual({ value: 'ar.example', tagged: 1, english: 0, consistent: false })
  })
})

describe('routes', () => {
  const response = () => {
    const res = { statusCode: 200, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v }, end(b?: string) { this.body = b ?? '' } }
    return res as typeof res & ServerResponse
  }
  const ctx = (authorization?: string) => ({
    key: '',
    rapidKey: 'k',
    cache: createFootballCache(() => NOW),
    fetchImpl: vi.fn(async () => page([apiMatch('Egypt')])) as unknown as typeof fetch,
    streaming: { key: 'k', store: undefined as never, now: () => NOW },
    admin: { password: 'secret', authorization },
  })

  it('needs the admin password', async () => {
    const res = response()
    await handleFootball(ctx(), 'GET', 'livestreams', new URLSearchParams(), res)
    expect(res.statusCode).toBe(401)
  })

  it('lists the matches with usage and tags, and saves a tag by POST', async () => {
    const c = ctx('Bearer secret')
    const res = response()
    await handleFootball(c, 'GET', 'livestreams', new URLSearchParams('status=live'), res)
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(body.matches[0].servers).toHaveLength(3)
    expect(body.usage).toEqual({ today: 1, cap: 50 })
    expect(JSON.stringify(body)).not.toContain('"k"')

    const tagRes = response()
    await handleFootball(c, 'POST', 'livestreams-tag', new URLSearchParams({ match: body.matches[0].key, name: 'Server 1', tag: 'english', url: 'https://hls.example/x.m3u8', title: 'Egypt vs Malawi' }), tagRes)
    expect(JSON.parse(tagRes.body).tags).toHaveLength(1)
    const bad = response()
    await handleFootball(c, 'POST', 'livestreams-tag', new URLSearchParams({ match: 'm', name: 'Server 1', tag: 'klingon' }), bad)
    expect(bad.statusCode).toBe(400)
    const wrongMethod = response()
    await handleFootball(c, 'GET', 'livestreams-tag', new URLSearchParams(), wrongMethod)
    expect(wrongMethod.statusCode).toBe(405)
  })
})
