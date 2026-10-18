import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { countLive, handleLive, isAdmin, parseHeartbeat, readLiveEnv, recordHeartbeat, WINDOW_MS, type LiveEnv } from './handlers'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const SID = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789'
const ENV: LiveEnv = { redisUrl: 'https://redis.example.com', redisToken: 'redis-token', adminPassword: 'open sesame' }

/** A stand-in for Upstash's REST pipeline: records the commands, answers with `results`. */
function upstash(results: unknown[] = []) {
  const calls: string[][][] = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as string[][])
    return new Response(JSON.stringify(results.map((result) => ({ result }))))
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, mock: fetchImpl }
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value
    },
    end(body?: string) {
      res.body = body ?? ''
    },
  }
  return res
}

const request = (method: string, body?: unknown, authorization?: string) =>
  ({ method, body, headers: authorization ? { authorization } : {} }) as unknown as IncomingMessage & { body?: unknown }

async function call(action: string, req: IncomingMessage & { body?: unknown }, fetchImpl: typeof fetch, env = ENV) {
  const res = fakeResponse()
  await handleLive(env, action, req, res as unknown as ServerResponse, fetchImpl, NOW)
  return { ...res, json: JSON.parse(res.body) as Record<string, unknown> }
}

describe('heartbeats', () => {
  it('accepts an anonymous id plus what is being watched, and nothing else', () => {
    expect(parseHeartbeat({ sid: SID, state: 'watch', item: 'movie:550' })).toEqual({ sid: SID, state: 'watch', item: 'movie:550' })
    expect(parseHeartbeat({ sid: SID, state: 'browse' })).toEqual({ sid: SID, state: 'browse', item: null })
    expect(parseHeartbeat({ sid: SID, state: 'browse', item: 'match:9338247101' })).toMatchObject({ item: 'match:9338247101' })
    expect(parseHeartbeat({ sid: SID, state: 'watch' })).toBeNull()
    expect(parseHeartbeat({ sid: 'short', state: 'browse' })).toBeNull()
    expect(parseHeartbeat({ sid: SID, state: 'browse', item: 'movie:550|x' })).toBeNull()
    expect(parseHeartbeat({ sid: SID, state: 'browse', item: 'person:1' })).toBeNull()
    expect(parseHeartbeat({ sid: `${SID}|tv:1`, state: 'browse' })).toBeNull()
    expect(parseHeartbeat(null)).toBeNull()
  })

  it('stores a film heartbeat with one Redis command', async () => {
    const { fetchImpl, calls, mock } = upstash([1])
    expect(await recordHeartbeat(ENV, { sid: SID, state: 'watch', item: 'movie:550' }, NOW, fetchImpl, () => 0.5)).toEqual({})
    expect(calls).toEqual([[['ZADD', 'live:now', String(NOW), `watch|movie:550|${SID}`]]])
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('https://redis.example.com/pipeline')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer redis-token')
  })

  it('clears old heartbeats now and then', async () => {
    const { fetchImpl, calls } = upstash([1, 0])
    await recordHeartbeat(ENV, { sid: SID, state: 'browse', item: null }, NOW, fetchImpl, () => 0.01)
    expect(calls[0][1]).toEqual(['ZREMRANGEBYSCORE', 'live:now', '-inf', `(${NOW - WINDOW_MS}`])
  })

  it('tracks who is watching a match and answers how many are', async () => {
    const { fetchImpl, calls } = upstash([1, 1, 1, 4])
    const answer = await recordHeartbeat(ENV, { sid: SID, state: 'watch', item: 'match:123' }, NOW, fetchImpl, () => 0.5)
    expect(answer).toEqual({ watching: 4 })
    expect(calls[0]).toEqual([
      ['ZADD', 'live:now', String(NOW), `watch|match:123|${SID}`],
      ['ZADD', 'live:m:123', String(NOW), SID],
      ['EXPIRE', 'live:m:123', '300'],
      ['ZCOUNT', 'live:m:123', String(NOW - WINDOW_MS), '+inf'],
    ])
  })

  it('only counts someone on a match page who is not watching, without adding them', async () => {
    const { fetchImpl, calls } = upstash([1, 7])
    expect(await recordHeartbeat(ENV, { sid: SID, state: 'browse', item: 'match:123' }, NOW, fetchImpl, () => 0.5)).toEqual({ watching: 7 })
    expect(calls[0].map((command) => command[0])).toEqual(['ZADD', 'ZCOUNT'])
  })

  it('answers quietly when the store is missing or down', async () => {
    const down = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    expect(await recordHeartbeat(ENV, { sid: SID, state: 'watch', item: 'match:1' }, NOW, down)).toEqual({})
    const none = vi.fn() as unknown as typeof fetch
    const { json, statusCode } = await call('heartbeat', request('POST', { sid: SID, state: 'browse' }), none, { ...ENV, redisUrl: '', redisToken: '' })
    expect(statusCode).toBe(200)
    expect(json).toEqual({})
    expect(none).not.toHaveBeenCalled()
  })

  it('rejects bad heartbeats and other methods', async () => {
    const { fetchImpl } = upstash()
    expect((await call('heartbeat', request('POST', { sid: SID, state: 'watch' }), fetchImpl)).statusCode).toBe(400)
    expect((await call('heartbeat', request('POST', '{oops'), fetchImpl)).statusCode).toBe(400)
    expect((await call('heartbeat', request('GET'), fetchImpl)).statusCode).toBe(405)
    expect((await call('nope', request('GET'), fetchImpl)).statusCode).toBe(404)
  })
})

describe('the count', () => {
  const at = (seconds: number) => String(NOW - seconds * 1000)

  it('counts each visitor once, by their latest heartbeat, and lists the top titles', async () => {
    const { fetchImpl, calls } = upstash([
      0,
      [
        'watch|movie:550|aaaaaaaaaaaaaaaa', at(90),
        'browse||aaaaaaaaaaaaaaaa', at(10), // stopped watching: now browsing
        'watch|tv:1399|bbbbbbbbbbbbbbbb', at(30),
        'watch|tv:1399|cccccccccccccccc', at(20),
        'watch|match:123|dddddddddddddddd', at(5),
        'browse|match:123|eeeeeeeeeeeeeeee', at(50),
        'browse||ffffffffffffffff', at(100),
      ],
    ])
    expect(await countLive(ENV, NOW, fetchImpl)).toEqual({
      watching: 3,
      browsing: 3,
      top: [
        { item: 'tv:1399', viewers: 2 },
        { item: 'match:123', viewers: 1 },
      ],
    })
    expect(calls[0]).toEqual([
      ['ZREMRANGEBYSCORE', 'live:now', '-inf', `(${NOW - WINDOW_MS}`],
      ['ZRANGE', 'live:now', String(NOW - WINDOW_MS), '+inf', 'BYSCORE', 'WITHSCORES'],
    ])
  })

  it('keeps the top five', async () => {
    const flat = Array.from({ length: 7 }, (_, i) => [`watch|movie:${i + 1}|sid${String(i).padStart(14, '0')}`, at(i)]).flat()
    const { fetchImpl } = upstash([0, flat])
    expect((await countLive(ENV, NOW, fetchImpl))?.top).toHaveLength(5)
  })

  it('is only for the admin', async () => {
    const { fetchImpl } = upstash([0, []])
    expect((await call('count', request('GET'), fetchImpl)).statusCode).toBe(401)
    expect((await call('count', request('GET', undefined, 'Bearer wrong'), fetchImpl)).statusCode).toBe(401)
    const ok = await call('count', request('GET', undefined, 'Bearer open sesame'), fetchImpl)
    expect(ok.statusCode).toBe(200)
    expect(ok.json).toEqual({ watching: 0, browsing: 0, top: [] })
    expect(ok.headers['cache-control']).toBe('no-store')
  })

  it('stays locked while ADMIN_PASSWORD is unset, and says when the store is missing', async () => {
    const { fetchImpl } = upstash([0, []])
    expect(isAdmin({ ...ENV, adminPassword: '' }, 'Bearer ')).toBe(false)
    expect((await call('count', request('GET', undefined, 'Bearer '), fetchImpl, { ...ENV, adminPassword: '' })).json).toEqual({ error: 'not-configured' })
    const noStore = await call('count', request('GET', undefined, 'Bearer open sesame'), fetchImpl, { ...ENV, redisUrl: '' })
    expect(noStore.statusCode).toBe(503)
    expect(noStore.json).toEqual({ error: 'no-store' })
  })

  it('reads the Vercel Marketplace or Upstash variable names', () => {
    expect(readLiveEnv({ KV_REST_API_URL: 'https://a.upstash.io/', KV_REST_API_TOKEN: 't', ADMIN_PASSWORD: 'p' })).toEqual({
      redisUrl: 'https://a.upstash.io',
      redisToken: 't',
      adminPassword: 'p',
    })
    expect(readLiveEnv({ UPSTASH_REDIS_REST_URL: 'https://b.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'u' })).toMatchObject({
      redisUrl: 'https://b.upstash.io',
      redisToken: 'u',
    })
  })
})
