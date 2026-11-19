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

/** DramaBox (Ezvid's shape since November 2026; ids are slugs): two free episodes, then one paid. */
const SLUG = 'a-drama'
const DRAMABOX_EPISODES = {
  items: [
    { id: '701', title: 'Episode 1', episodeNumber: 1, extra: { seriesSlug: SLUG, locked: false, requiresVip: false } },
    { id: '702', title: 'Episode 2', episodeNumber: 2, extra: { seriesSlug: SLUG, locked: false, requiresVip: false } },
    { id: '703', title: 'Episode 3', episodeNumber: 3, extra: { seriesSlug: SLUG, locked: true, requiresVip: true } },
  ],
  total: 3,
}
const dramaboxItem = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  image: `https://media.ezvid.net/media/images/${id}.webp`,
  extra: { description: 'Story', tags: [], totalEpisodes: 3, views: 0, ...extra },
})

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
  if (url.pathname === `/api/dramabox/episodes/${SLUG}`) return ok(DRAMABOX_EPISODES)
  const source = new RegExp(`^/api/dramabox/episodes/${SLUG}/(\\d+)/source$`).exec(url.pathname)
  if (source) return ok({ items: [{ id: source[1], sources: [{ type: 'mp4', url: `https://cdn.example/${source[1]}.720p.mp4` }], extra: { locked: false } }] })
  if (url.pathname === `/api/dramabox/detail/${SLUG}`) return ok({ items: [dramaboxItem(SLUG, 'A Drama', { tags: [{ slug: 'revenge', name: 'Revenge' }] })] })
  return ok({ items: [] })
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

  it('turns DramaBox lists into shelves of dramas, asking in English', async () => {
    const long = 'the-billionaires-secret-daughter-came-back-for-revenge-on-thanksgiving'
    const { call, calls } = setup((url) =>
      url.pathname === '/api/dramabox/popular'
        ? ok({ items: [dramaboxItem(long, 'The Billionaire’s Secret Daughter', { totalEpisodes: 52, views: 2971, genre: 'Revenge' })], nextCursor: 'x' })
        : ok({ items: [dramaboxItem('love-in-lockup', 'Love In Lockup', { tags: [{ slug: 'ceo', name: 'CEO' }] })] }),
    )
    const res = await call('/api/dramas/home?provider=dramabox')
    expect(res.statusCode).toBe(200)
    const shelves = json(res).shelves as { title: string; dramas: Record<string, unknown>[] }[]
    expect(shelves.map((s) => s.title)).toEqual(['Popular', 'Latest'])
    expect(shelves[0].dramas[0]).toMatchObject({ provider: 'dramabox', id: long, title: 'The Billionaire’s Secret Daughter', episodes: 52, popularity: '3K', tags: ['Revenge'] })
    // 0 views: not known, so not shown.
    expect(shelves[1].dramas[0]).toMatchObject({ id: 'love-in-lockup', tags: ['CEO'], popularity: null, cover: 'https://media.ezvid.net/media/images/love-in-lockup.webp' })
    expect(calls.map((u) => `${u.pathname}?${u.searchParams.get('language')}`).sort()).toEqual(['/api/dramabox/home?en', '/api/dramabox/popular?en'])
  })

  it('rejects unknown providers and bad ids', async () => {
    const { call, calls } = setup()
    expect((await call('/api/dramas/home?provider=nope')).statusCode).toBe(400)
    expect((await call('/api/dramas/drama?provider=dramabox&id=../x')).statusCode).toBe(400)
    expect((await call(`/api/dramas/drama?provider=dramabox&id=${'a'.repeat(101)}`)).statusCode).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('lists episodes without video links, paid ones not playable while the switch is off', async () => {
    const { call } = setup(dramaboxUpstream)
    const res = await call(`/api/dramas/drama?provider=dramabox&id=${SLUG}`)
    const body = json(res)
    expect(res.body).not.toContain('cdn.example')
    expect(body.showLocked).toBe(false)
    expect(body.drama).toMatchObject({ id: SLUG, title: 'A Drama', tags: ['Revenge'], episodes: 3 })
    expect(body.episodes).toEqual([
      { id: '701', number: 1, title: 'Episode 1', locked: false, playable: true },
      { id: '702', number: 2, title: 'Episode 2', locked: false, playable: true },
      { id: '703', number: 3, title: 'Episode 3', locked: true, playable: false },
    ])
  })

  it('plays a free DramaBox episode from its own source call, kept for a while, and never cached on the CDN', async () => {
    const { call, calls } = setup(dramaboxUpstream)
    const res = await call(`/api/dramas/play?provider=dramabox&id=${SLUG}&ep=701`)
    expect(res.statusCode).toBe(200)
    expect(json(res).sources).toEqual([{ url: 'https://cdn.example/701.720p.mp4', type: 'mp4', quality: 'auto' }])
    expect(res.headers['cache-control']).toBe('no-store')
    await call(`/api/dramas/play?provider=dramabox&id=${SLUG}&ep=701`)
    expect(calls.filter((u) => u.pathname.endsWith('/source'))).toHaveLength(1)
  })

  it('refuses a paid episode while the switch is off, and gives no link', async () => {
    const { call } = setup(dramaboxUpstream)
    const res = await call(`/api/dramas/play?provider=dramabox&id=${SLUG}&ep=703`)
    expect(res.statusCode).toBe(403)
    expect(json(res)).toEqual({ error: 'locked' })
    expect(res.body).not.toContain('cdn.example')
  })

  it('keeps paid episodes locked when Redis cannot be read', async () => {
    const { ctx, call } = setup(dramaboxUpstream)
    ctx.redis = { redisUrl: '', redisToken: '' }
    expect((await call(`/api/dramas/play?provider=dramabox&id=${SLUG}&ep=703`)).statusCode).toBe(403)
  })

  it('plays paid episodes once the admin turns the switch on', async () => {
    const { call, store } = setup(dramaboxUpstream)
    const on = await call('/api/dramas/admin-settings', { method: 'POST', body: { showLocked: true }, authorization: `Bearer ${PASSWORD}` })
    expect(on.statusCode).toBe(200)
    expect(store.strings.get(SHOW_LOCKED_KEY)).toBe('1')
    const res = await call(`/api/dramas/play?provider=dramabox&id=${SLUG}&ep=703`)
    expect(res.statusCode).toBe(200)
    expect(json(await call(`/api/dramas/drama?provider=dramabox&id=${SLUG}`)).episodes).toContainEqual({ id: '703', number: 3, title: 'Episode 3', locked: true, playable: true })
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

  it('searches DramaBox with q, then its lists (next pages too) for what the search missed', async () => {
    const { call, calls } = setup((url) => {
      if (url.pathname === '/api/dramabox/search') return ok({ items: url.searchParams.get('q') === 'mafia' ? [dramaboxItem('mafia-kiss', 'Mafia Kiss')] : [] })
      if (url.pathname === '/api/dramabox/home') return ok({ items: [dramaboxItem('the-mafia-bosss-bride', 'The Mafia Boss’s Bride'), dramaboxItem('cinderella', 'Cinderella Returns')], nextCursor: 'page2' })
      if (url.pathname === '/api/dramabox/loadmore' && url.searchParams.get('cursor') === 'page2') return ok({ items: [dramaboxItem('rich-heiress', 'Rich Heiress', { tags: [{ slug: 'mafia', name: 'Mafia' }] })] })
      return ok({ items: [] })
    })
    const res = await call('/api/dramas/search?provider=dramabox&q=mafia')
    expect(res.statusCode).toBe(200)
    // Its own search first, then title matches before tag matches.
    expect((json(res).dramas as { id: string }[]).map((d) => d.id)).toEqual(['mafia-kiss', 'the-mafia-bosss-bride', 'rich-heiress'])
    expect((json(await call('/api/dramas/search?provider=dramabox&q=mafia bride')).dramas as { id: string }[]).map((d) => d.id)).toEqual(['the-mafia-bosss-bride'])
    expect(calls.find((u) => u.pathname === '/api/dramabox/search')?.searchParams.get('language')).toBe('en')
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

  it('does not keep an empty list: the next search asks again', async () => {
    let down = true
    let now = 0
    const { ctx, call } = setup((url) => {
      if (down || url.pathname === '/api/dramawave/search') return new Response(JSON.stringify({ ok: false, message: 'Upstream error' }), { status: 400 })
      if (url.pathname === '/api/dramawave/home') return ok({ items: [{ key: 'abc', title: 'Love in the Rain' }] })
      return ok({ items: [] })
    })
    ctx.cache = createDramaCache(() => now)
    expect(json(await call('/api/dramas/search?provider=dramawave&q=love')).dramas).toEqual([])
    down = false
    // Past the 30-second wait after a failure.
    now = DRAMA_TTL.failed + 1
    expect((json(await call('/api/dramas/search?provider=dramawave&q=love')).dramas as { id: string }[]).map((d) => d.id)).toEqual(['abc'])
  })

  it('serves the last good answer when Ezvid fails', async () => {
    let now = 0
    let failing = false
    const { ctx } = setup()
    ctx.cache = createDramaCache(() => now)
    ctx.fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/pipeline')) return new Response('[]')
      if (failing) return new Response(JSON.stringify({ ok: false, message: 'Upstream error' }), { status: 400 })
      return ok({ items: [dramaboxItem('cached', 'Cached')] })
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
