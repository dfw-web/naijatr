import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRedis } from '../testing/fakeRedis'
import { createDramaCache, DRAMA_TTL, handleDramas, resetDramaSetting, SHOW_LOCKED_KEY, splitDramaUrl, type DramaContext } from './handlers'
import { EZVID_ORIGIN } from './providers'

const KEY = 'test-ezvid-key'
const PASSWORD = 'admin-pass'

function fakeResponse() {
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    body: undefined as string | undefined,
    headers,
    setHeader: (name: string, value: string) => void (headers[name.toLowerCase()] = value),
    end: (body?: string) => void (res.body = body),
  }
  return res as typeof res & ServerResponse
}

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null') as Record<string, unknown>
const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { headers: { 'Content-Type': 'application/json' } })

/** DramaBox: two free episodes, then one paid. */
const DRAMABOX_EPISODES = [
  { chapterId: '701', chapterIndex: 0, chapterName: 'EP 1', isCharge: 0, isLocked: false, videoUrl720: 'https://cdn.example/1.720.mp4', videoUrl1080: 'https://cdn.example/1.1080.mp4' },
  { chapterId: '702', chapterIndex: 1, chapterName: 'EP 2', isCharge: 0, isLocked: false, videoUrl720: 'https://cdn.example/2.720.mp4' },
  { chapterId: '703', chapterIndex: 2, chapterName: 'EP 3', isCharge: 1, isLocked: true, videoUrl720: 'https://cdn.example/3.720.mp4' },
]

function setup(upstream: (url: URL) => Response | Promise<Response> = () => ok([])) {
  const store = fakeRedis()
  const calls: URL[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/pipeline')) return store.fetchImpl(input as string, init)
    calls.push(url)
    return upstream(url)
  }) as unknown as typeof fetch
  const ctx: DramaContext = {
    key: KEY,
    cache: createDramaCache(),
    redis: { redisUrl: 'https://redis.example', redisToken: 'token' },
    adminPassword: PASSWORD,
    fetchImpl,
  }
  const call = async (path: string, init: { method?: string; body?: unknown; authorization?: string } = {}) => {
    const { route, params } = splitDramaUrl(path)
    const res = fakeResponse()
    const req = { method: init.method ?? 'GET', body: init.body } as IncomingMessage & { body?: unknown }
    await handleDramas({ ...ctx, authorization: init.authorization }, req, route, params, res)
    return res
  }
  return { ctx, store, calls, call }
}

const dramaboxUpstream = (url: URL) => {
  if (url.pathname === '/api/dramabox/allepisode') return ok(DRAMABOX_EPISODES)
  if (url.pathname === '/api/dramabox/detail') return ok({ bookId: '42', bookName: 'A Drama', coverWap: 'https://img.example/42.jpg', chapterCount: 3, introduction: 'Story', tags: ['Revenge'] })
  return ok([])
}

beforeEach(() => resetDramaSetting())

describe('/api/dramas', () => {
  it('sends the key to Ezvid in the X-API-Key header only', async () => {
    const seen: Headers[] = []
    const { ctx, call } = setup()
    ctx.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/pipeline')) return new Response('[]')
      seen.push(new Headers(init?.headers))
      expect(String(input)).not.toContain(KEY)
      return ok([])
    }) as typeof fetch
    await handleDramas(ctx, { method: 'GET' } as IncomingMessage, 'home', new URLSearchParams('provider=dramabox'), fakeResponse())
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0].get('x-api-key')).toBe(KEY)
    void call
  })

  it('turns DramaBox lists into shelves of dramas', async () => {
    const book = { bookId: '42', bookName: 'A Drama', coverWap: 'https://img.example/42.jpg', chapterCount: 52, introduction: 'Story', tags: ['Revenge', 'CEO'], rankVo: { hotCode: '3.1M' } }
    const { call } = setup(() => ok([book]))
    const res = await call('/api/dramas/home?provider=dramabox')
    expect(res.statusCode).toBe(200)
    const shelves = json(res).shelves as { title: string; dramas: { id: string; title: string; episodes: number; popularity: string }[] }[]
    expect(shelves.map((s) => s.title)).toEqual(['Trending', 'Latest'])
    expect(shelves[0].dramas[0]).toMatchObject({ provider: 'dramabox', id: '42', title: 'A Drama', episodes: 52, popularity: '3.1M' })
  })

  it('rejects unknown providers and bad ids', async () => {
    const { call, calls } = setup()
    expect((await call('/api/dramas/home?provider=nope')).statusCode).toBe(400)
    expect((await call('/api/dramas/drama?provider=dramabox&id=../x')).statusCode).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('lists episodes without video links, paid ones not playable while the switch is off', async () => {
    const { call } = setup(dramaboxUpstream)
    const res = await call('/api/dramas/drama?provider=dramabox&id=42')
    const body = json(res)
    expect(res.body).not.toContain('cdn.example')
    expect(body.showLocked).toBe(false)
    expect(body.episodes).toEqual([
      { id: '701', number: 1, title: 'EP 1', locked: false, playable: true },
      { id: '702', number: 2, title: 'EP 2', locked: false, playable: true },
      { id: '703', number: 3, title: 'EP 3', locked: true, playable: false },
    ])
  })

  it('plays a free episode, best quality first, and never caches the links on the CDN', async () => {
    const { call } = setup(dramaboxUpstream)
    const res = await call('/api/dramas/play?provider=dramabox&id=42&ep=701')
    expect(res.statusCode).toBe(200)
    expect(json(res).sources).toEqual([
      { url: 'https://cdn.example/1.1080.mp4', type: 'mp4', quality: '1080p' },
      { url: 'https://cdn.example/1.720.mp4', type: 'mp4', quality: '720p' },
    ])
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('refuses a paid episode while the switch is off, and gives no link', async () => {
    const { call } = setup(dramaboxUpstream)
    const res = await call('/api/dramas/play?provider=dramabox&id=42&ep=703')
    expect(res.statusCode).toBe(403)
    expect(json(res)).toEqual({ error: 'locked' })
    expect(res.body).not.toContain('cdn.example')
  })

  it('keeps paid episodes locked when Redis cannot be read', async () => {
    const { ctx, call } = setup(dramaboxUpstream)
    ctx.redis = { redisUrl: '', redisToken: '' }
    expect((await call('/api/dramas/play?provider=dramabox&id=42&ep=703')).statusCode).toBe(403)
  })

  it('plays paid episodes once the admin turns the switch on', async () => {
    const { call, store } = setup(dramaboxUpstream)
    const on = await call('/api/dramas/admin-settings', { method: 'POST', body: { showLocked: true }, authorization: `Bearer ${PASSWORD}` })
    expect(on.statusCode).toBe(200)
    expect(store.strings.get(SHOW_LOCKED_KEY)).toBe('1')
    const res = await call('/api/dramas/play?provider=dramabox&id=42&ep=703')
    expect(res.statusCode).toBe(200)
    expect(json(await call('/api/dramas/drama?provider=dramabox&id=42')).episodes).toContainEqual({ id: '703', number: 3, title: 'EP 3', locked: true, playable: true })
  })

  it('only lets the admin read or change the switch', async () => {
    const { call, store } = setup()
    expect((await call('/api/dramas/admin-settings', { method: 'POST', body: { showLocked: true } })).statusCode).toBe(401)
    expect((await call('/api/dramas/admin-settings', { method: 'POST', body: { showLocked: true }, authorization: 'Bearer wrong' })).statusCode).toBe(401)
    expect((await call('/api/dramas/admin-settings', { method: 'POST', body: { showLocked: 'yes' }, authorization: `Bearer ${PASSWORD}` })).statusCode).toBe(400)
    expect(store.strings.has(SHOW_LOCKED_KEY)).toBe(false)
    const read = await call('/api/dramas/admin-settings', { authorization: `Bearer ${PASSWORD}` })
    expect(json(read)).toEqual({ showLocked: false, configured: true })
  })

  it('asks NetShort for a source per episode, with the episode id', async () => {
    const { call, calls } = setup((url) => {
      if (url.pathname === '/api/netshort/episodes/9') {
        return ok({ items: [{ id: '91', episodeNumber: 1, extra: { isLocked: false } }, { id: '92', episodeNumber: 2, extra: { isLocked: true } }] })
      }
      if (url.pathname === '/api/netshort/episodes/9/91/source') {
        return ok({ episodePlayList: [{ playVoucher: 'https://ns.example/a.mp4', playClarity: '540p' }, { playVoucher: 'https://ns.example/b.mp4', playClarity: '1080p' }] })
      }
      return new Response('{}', { status: 500 })
    })
    const res = await call('/api/dramas/play?provider=netshort&id=9&ep=91')
    expect(json(res).sources).toEqual([
      { url: 'https://ns.example/b.mp4', type: 'mp4', quality: '1080p', codec: 'hevc' },
      { url: 'https://ns.example/a.mp4', type: 'mp4', quality: '540p', codec: 'hevc' },
    ])
    expect((await call('/api/dramas/play?provider=netshort&id=9&ep=92')).statusCode).toBe(403)
    expect(calls.filter((u) => u.pathname.endsWith('/source'))).toHaveLength(1)
  })

  it('marks DramaWave "charge" episodes as paid and reads its HLS links', async () => {
    const { call } = setup((url) =>
      url.pathname === '/api/dramawave/episodes/abc'
        ? ok({ items: [
            { id: 'e1', episodeNumber: 1, sources: [{ type: 'm3u8', url: 'https://dw.example/1.m3u8', quality: 'h264' }], extra: { isLocked: false, videoType: 'free' } },
            { id: 'e2', episodeNumber: 2, sources: [{ type: 'm3u8', url: 'https://dw.example/2.m3u8', quality: 'h264' }], extra: { isLocked: false, videoType: 'charge' } },
          ] })
        : ok({ items: [] }),
    )
    const episodes = json(await call('/api/dramas/drama?provider=dramawave&id=abc')).episodes as { locked: boolean }[]
    expect(episodes.map((e) => e.locked)).toEqual([false, true])
    expect(json(await call('/api/dramas/play?provider=dramawave&id=abc&ep=e1')).sources).toEqual([{ url: 'https://dw.example/1.m3u8', type: 'hls', quality: 'h264' }])
    expect((await call('/api/dramas/play?provider=dramawave&id=abc&ep=e2')).statusCode).toBe(403)
  })

  it('finds DramaBox dramas from its lists when its own search returns nothing', async () => {
    const book = (bookId: string, bookName: string, tags: string[] = []) => ({ bookId, bookName, tags, introduction: '' })
    const { call } = setup((url) => {
      if (url.pathname === '/api/dramabox/search') return ok([])
      if (url.pathname === '/api/dramabox/latest') return ok([book('1', 'The Mafia Boss’s Bride'), book('2', 'Cinderella Returns')])
      if (url.pathname === '/api/dramabox/browse') return ok({ items: url.searchParams.get('page') === '1' ? [book('3', 'Rich Heiress', ['Mafia'])] : [] })
      return ok([])
    })
    const res = await call('/api/dramas/search?provider=dramabox&q=mafia')
    expect(res.statusCode).toBe(200)
    // Title matches before tag matches.
    expect((json(res).dramas as { id: string }[]).map((d) => d.id)).toEqual(['1', '3'])
    expect((json(await call('/api/dramas/search?provider=dramabox&q=mafia bride')).dramas as { id: string }[]).map((d) => d.id)).toEqual(['1'])
  })

  it('still searches DramaWave’s lists when its search fails', async () => {
    const { call } = setup((url) => {
      if (url.pathname === '/api/dramawave/search') return new Response(JSON.stringify({ ok: false, message: 'Upstream error' }), { status: 400 })
      if (url.pathname === '/api/dramawave/home') return ok({ items: [{ key: 'abc', title: 'Love in the Rain' }] })
      if (url.pathname === '/api/dramawave/search/hot-list') return ok({ items: [{ id: 'def', title: 'Lovely Liar' }] })
      return ok({ items: [] })
    })
    const res = await call('/api/dramas/search?provider=dramawave&q=love')
    expect(res.statusCode).toBe(200)
    expect((json(res).dramas as { id: string }[]).map((d) => d.id).sort()).toEqual(['abc', 'def'])
  })

  it('serves the last good answer when Ezvid fails', async () => {
    let now = 0
    let failing = false
    const { ctx } = setup()
    ctx.cache = createDramaCache(() => now)
    ctx.fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/pipeline')) return new Response('[]')
      if (failing) return new Response(JSON.stringify({ ok: false, message: 'Upstream error' }), { status: 400 })
      return ok([{ bookId: '1', bookName: 'Cached' }])
    }) as typeof fetch
    const get = async () => {
      const res = fakeResponse()
      await handleDramas(ctx, { method: 'GET' } as IncomingMessage, 'home', new URLSearchParams('provider=dramabox'), res)
      return res
    }
    await get()
    now = DRAMA_TTL.home + 1
    failing = true
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(json(res).stale).toBe(true)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('says when Ezvid is down and nothing is cached', async () => {
    const { call } = setup(() => new Response(JSON.stringify({ ok: false, message: 'Upstream error: timeout' }), { status: 400 }))
    const res = await call('/api/dramas/home?provider=dramawave')
    expect(res.statusCode).toBe(502)
    expect(json(res)).toEqual({ error: 'upstream-error' })
  })

  it('says it is not set up without EZVID_API_KEY', async () => {
    const { ctx } = setup()
    const res = fakeResponse()
    await handleDramas({ ...ctx, key: '' }, { method: 'GET' } as IncomingMessage, 'home', new URLSearchParams('provider=dramabox'), res)
    expect(res.statusCode).toBe(503)
  })

  it('reads the route from the path or from Vercel’s __path', () => {
    expect(splitDramaUrl('/api/dramas/home?provider=dramabox').route).toBe('home')
    expect(splitDramaUrl('/play?provider=netshort').route).toBe('play')
    expect(EZVID_ORIGIN).toBe('https://api.ezvid.net')
  })
})
