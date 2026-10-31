import { describe, expect, it, vi } from 'vitest'
import { parseStreamingMatch, STREAMING_ORIGIN } from './streaming'
import {
  createMemoryStore,
  createRedisStore,
  findStreamingMatch,
  loadStreaming,
  MANUAL_REFRESH_EVERY_MS,
  refreshStreamingMatch,
  STREAMING_MISSING_MS,
  STREAMING_TTL_MS,
  streamingAdmin,
  streamsForMatch,
  type StreamingDeps,
} from './streamingStore'

const KICKOFF_S = 1792434600

const listed = (home: string, away: string, servers: unknown[] = [{ type: 'direct', url: `https://cdn.example/${home}.m3u8` }]) => ({
  match_time: String(KICKOFF_S),
  match_status: 'live',
  home_team_name: home,
  away_team_name: away,
  homeTeamScore: '1',
  awayTeamScore: '0',
  league_name: 'English Premier League',
  servers,
})

function api(matches: unknown[] = [listed('Tottenham Hotspur', 'Coventry City')], remaining = 19_000) {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ matches, pagination: { page: 1, hasNext: false } }), {
      headers: { 'x-ratelimit-requests-limit': '20000', 'x-ratelimit-requests-remaining': String(remaining) },
    }),
  )
}

function setup(fetchImpl = api()) {
  let now = KICKOFF_S * 1000 + 30 * 60_000
  const store = createMemoryStore(() => now)
  const deps: StreamingDeps = { key: 'rapid-key', store, now: () => now, fetchImpl, sleep: async () => {} }
  return { deps, store, fetchImpl, advance: (ms: number) => (now += ms) }
}

describe('Football Live Streaming API: the listing', () => {
  it('keeps only direct HLS servers, numbered in order', () => {
    const match = parseStreamingMatch(
      listed('Tottenham Hotspur', 'Coventry City', [
        { name: 'Server 1', type: 'direct', url: 'https://a.example/live/x.m3u8' },
        { name: 'Server 2', type: 'direct', url: 'https://a.example/live/x.flv' },
        { name: 'Server 3', type: 'referer', url: 'https://b.example/y.m3u8', header: { referer: 'https://b.example/' } },
        { name: 'Server 4', type: 'drm', url: 'https://c.example/z.mpd' },
        { name: 'Server 5', type: 'direct', url: 'http://d.example/insecure.m3u8' },
        { name: 'Server 6', type: 'direct', url: 'https://e.example/live/w.m3u8?token=1' },
      ]),
    )
    expect(match).toMatchObject({ home: 'Tottenham Hotspur', away: 'Coventry City', live: true, score: '1 - 0', kickoff: KICKOFF_S * 1000 })
    expect(match?.streams).toEqual([
      { label: 'Server 1', url: 'https://a.example/live/x.m3u8', kind: 'hls' },
      { label: 'Server 2', url: 'https://e.example/live/w.m3u8?token=1', kind: 'hls' },
    ])
  })

  it('puts feeds tagged English first, named so', () => {
    const match = parseStreamingMatch(
      listed('FC Barcelona', 'Real Madrid', [
        { name: 'Server 1', type: 'direct', url: 'https://a.example/live/stream-1_lsd.m3u8' },
        { name: 'Server 2', type: 'direct', url: 'https://b.example/live/sd-6Mwea.m3u8' },
        { name: 'Server 3', type: 'direct', url: 'https://b.example/live/hd-en-6Mwea.m3u8' },
        { name: 'Server 4', type: 'direct', url: 'https://c.example/live/benfica-tv.m3u8' },
      ]),
    )
    expect(match?.streams.map((s) => s.label + ' ' + s.url)).toEqual([
      'Server 1 (English) https://b.example/live/hd-en-6Mwea.m3u8',
      'Server 2 https://a.example/live/stream-1_lsd.m3u8',
      'Server 3 https://b.example/live/sd-6Mwea.m3u8',
      'Server 4 https://c.example/live/benfica-tv.m3u8',
    ])
  })

  it('asks only for live matches, with the key in headers only', async () => {
    const { deps, fetchImpl } = setup()
    await loadStreaming(deps)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${STREAMING_ORIGIN}/matches?status=live`)
    expect(new Headers(init?.headers).get('x-rapidapi-key')).toBe('rapid-key')
    expect(new Headers(init?.headers).get('x-rapidapi-host')).toBe('football-live-streaming-api.p.rapidapi.com')
  })

  it('pairs our match by team names and kick-off', async () => {
    const { deps } = setup()
    const { snapshot } = await loadStreaming(deps)
    expect(findStreamingMatch(snapshot, 'Tottenham', 'Coventry', KICKOFF_S * 1000)?.streams).toHaveLength(1)
    // The same teams a day later are another match.
    expect(findStreamingMatch(snapshot, 'Tottenham', 'Coventry', (KICKOFF_S + 86_400) * 1000)).toBeNull()
    expect(findStreamingMatch(snapshot, 'Arsenal', 'Chelsea', KICKOFF_S * 1000)).toBeNull()
  })

  it('offers every listing of a match listed twice, the fullest first (Man City v Brighton, 31 Oct 2026)', () => {
    const kickoff = 1_793_458_800_000
    const hls = (url: string, label = '') => ({ label, url, kind: 'hls' as const })
    const entry = (home: string, away: string, streams: ReturnType<typeof hls>[]) => ({
      key: `Premier League|${home}|${away}|${kickoff}`,
      home,
      away,
      league: 'Premier League',
      kickoff,
      live: true,
      score: '0 - 0',
      streams,
    })
    const snapshot = {
      fetchedAt: kickoff,
      matches: [
        // Listed first, with names in Vietnamese and two servers that refuse to play.
        entry('thành phố Manchester', 'Brighton & Hove Albion FC', [
          hls('https://live.cds78y11d.org/live/hd-en-x.m3u8'),
          hls('https://live.cds78y11d.org/live/sd-x.m3u8'),
        ]),
        entry('Manchester City', 'Brighton Hove Albion', [
          hls('https://hls.lauthaitv.cc/live/mnc-bha-prem/index.m3u8'),
          hls('https://live05.miekgo.app/live/14830711.m3u8'),
          hls('https://live05.miekgo.app/live/08552895.m3u8'),
          hls('https://playback.livetl002.com/live/6a9a.m3u8'),
        ]),
      ],
    }
    // Our fixture can carry either set of names.
    for (const [home, away] of [['thành phố Manchester', 'Brighton & Hove Albion FC'], ['Manchester City', 'Brighton & Hove Albion']]) {
      const match = findStreamingMatch(snapshot, home, away, kickoff)!
      expect(match.home).toBe('Manchester City')
      expect(match.streams.map((s) => new URL(s.url).host)).toEqual([
        'hls.lauthaitv.cc',
        'live05.miekgo.app',
        'live05.miekgo.app',
        'playback.livetl002.com',
        'live.cds78y11d.org',
        'live.cds78y11d.org',
      ])
      expect(match.streams.map((s) => s.label)).toEqual(['Server 1', 'Server 2', 'Server 3', 'Server 4', 'Server 5 (English)', 'Server 6'])
    }
  })
})

describe('Football Live Streaming API: requests', () => {
  it('asks once for everyone, then not again for 5 minutes', async () => {
    const { deps, fetchImpl, advance } = setup()
    await Promise.all([loadStreaming(deps), loadStreaming(deps), loadStreaming(deps)])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    advance(STREAMING_TTL_MS - 1000)
    await loadStreaming(deps)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    advance(2000)
    await loadStreaming(deps)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('looks again after a minute for a live match it does not list yet', async () => {
    const { deps, fetchImpl, advance } = setup()
    await streamsForMatch(deps, 'Arsenal', 'Chelsea', KICKOFF_S * 1000, true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    advance(STREAMING_MISSING_MS / 2)
    await streamsForMatch(deps, 'Arsenal', 'Chelsea', KICKOFF_S * 1000, true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    advance(STREAMING_MISSING_MS)
    await streamsForMatch(deps, 'Arsenal', 'Chelsea', KICKOFF_S * 1000, true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // A match that isn't live doesn't make it look again.
    advance(STREAMING_MISSING_MS * 2)
    await streamsForMatch(deps, 'Arsenal', 'Chelsea', KICKOFF_S * 1000, false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops at 95% of the limit and serves the cached list', async () => {
    const { deps, fetchImpl, advance } = setup(api(undefined, 900))
    expect((await loadStreaming(deps)).snapshot?.matches).toHaveLength(1)
    advance(STREAMING_TTL_MS + 1)
    const load = await loadStreaming(deps)
    expect(load).toMatchObject({ limited: true, snapshot: { matches: [{ home: 'Tottenham Hotspur' }] } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps the last list when the API fails, and logs every call', async () => {
    const fetchImpl = api()
    const { deps, advance } = setup(fetchImpl)
    await loadStreaming(deps)
    fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    advance(STREAMING_TTL_MS + 1)
    expect((await loadStreaming(deps)).snapshot?.matches).toHaveLength(1)
    const { calls, quota } = await streamingAdmin(deps)
    expect(calls.map((c) => c.ok)).toEqual([false, true])
    expect(quota).toMatchObject({ limit: 20000, remaining: 19000 })
  })

  it('lets a match be refreshed by hand at most every 10 minutes', async () => {
    const { deps, fetchImpl, advance } = setup()
    expect(await refreshStreamingMatch(deps, 'm1')).toMatchObject({ ok: true })
    expect(await refreshStreamingMatch(deps, 'm1')).toMatchObject({ ok: false, retryInMs: MANUAL_REFRESH_EVERY_MS })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    advance(MANUAL_REFRESH_EVERY_MS + 1)
    expect(await refreshStreamingMatch(deps, 'm1')).toMatchObject({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('locks in Redis with SET NX, so instances share one request', async () => {
    const commands: string[][][] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const batch = JSON.parse(String(init?.body)) as string[][]
      commands.push(batch)
      return new Response(JSON.stringify(batch.map(() => ({ result: null }))))
    })
    const store = createRedisStore({ redisUrl: 'https://redis.example', redisToken: 't' }, fetchImpl)
    // Someone else holds the lock (SET NX answered null).
    expect(await store.lock('fb:sl:lock', 15000)).toBe(false)
    expect(commands[0]).toEqual([['SET', 'fb:sl:lock', '1', 'NX', 'PX', '15000']])
  })
})
