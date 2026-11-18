import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { fakeRedis } from '../testing/fakeRedis'
import { handleLive, type LiveEnv } from './handlers'
import { ALERT_AT, DAILY_PER_DEVICE, parsePlaying, parseTitleRequest, playPath, readRequestsEnv, type RequestsEnv } from './requests'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const DEVICE = (n: number) => `device-${String(n).padStart(12, '0')}`
const USER = '0f8fad5b-d9cb-469f-a165-70867728950e'
const USER_EMAIL = 'viewer@example.com'

/** Everything the requests talk to: Redis, Supabase, TMDB, NextStream, Telegram and Resend. */
function world({ playable = new Set<string>() } = {}) {
  const redis = fakeRedis(() => NOW)
  const telegram: string[] = []
  const emails: { to: string[]; subject: string; text: string }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/pipeline')) return redis.fetchImpl(url, init)
    if (url === 'https://db.example.com/auth/v1/user') {
      const auth = new Headers(init?.headers).get('Authorization')
      return auth === 'Bearer good-token' ? Response.json({ id: USER, email: USER_EMAIL }) : new Response('{}', { status: 401 })
    }
    if (url === `https://db.example.com/auth/v1/admin/users/${USER}`) return Response.json({ id: USER, email: USER_EMAIL })
    if (url.startsWith('https://api.themoviedb.org/3/movie/550')) return Response.json({ title: 'Fight Club' })
    if (url.startsWith('https://api.themoviedb.org/3/tv/1399')) return Response.json({ name: 'Game of Thrones' })
    if (url.startsWith('https://api.themoviedb.org/')) return new Response('{}', { status: 404 })
    if (url.startsWith('https://ns.example.com/api/')) {
      const path = new URL(url).pathname.replace('/api', '')
      return Response.json(playable.has(path) ? { success: true, sources: [{ url: 'https://x/1.m3u8' }] } : { success: false, sources: [] })
    }
    if (url.includes('api.telegram.org')) {
      telegram.push((JSON.parse(String(init?.body)) as { text: string }).text)
      return Response.json({ ok: true })
    }
    if (url === 'https://api.resend.com/emails/batch') {
      emails.push(...(JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string }[]))
      return Response.json({ data: [] })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { redis, fetchImpl, telegram, emails }
}

const REQUESTS: RequestsEnv = {
  ...readRequestsEnv({
    SUPABASE_URL: 'https://db.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    TELEGRAM_BOT_TOKEN: 'bot',
    ADMIN_TELEGRAM_CHAT_ID: '42',
    RESEND_API_KEY: 'resend',
    RESEND_FROM: 'NAIJA TR <hi@naijatr.com>',
    CRON_SECRET: 'cron-secret',
    TMDB_API_KEY: 'tmdb',
    NEXTSTREAM_API_KEY: 'k',
    NEXTSTREAM_MOVIE_URL: 'https://ns.example.com/embed/movie/{tmdbId}?apikey={apiKey}',
    NEXTSTREAM_TV_URL: 'https://ns.example.com/embed/tv/{tmdbId}/{season}/{episode}?apikey={apiKey}',
  }),
}
const ENV: LiveEnv = { redisUrl: 'https://redis.example.com', redisToken: 't', adminPassword: 'open sesame', requests: REQUESTS }

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(body?: string) {
      res.body = body ?? ''
    },
  }
  return res
}

async function call(action: string, method: string, fetchImpl: typeof fetch, { body, auth, ip = '1.2.3.4' }: { body?: unknown; auth?: string; ip?: string } = {}) {
  const req = { method, body, headers: { ...(auth ? { authorization: auth } : {}), 'x-forwarded-for': ip } } as unknown as IncomingMessage & { body?: unknown }
  const res = fakeResponse()
  await handleLive(ENV, action, req, res as unknown as ServerResponse, fetchImpl, NOW)
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> }
}

const ask = (fetchImpl: typeof fetch, device: number, extra: { item?: string; title?: string; ep?: string; auth?: string } = {}) =>
  call('request', 'POST', fetchImpl, {
    body: { item: extra.item ?? 'movie:550', title: extra.title ?? 'Fight Club', ep: extra.ep, device: DEVICE(device) },
    auth: extra.auth,
  })

describe('title requests', () => {
  it('accepts a title, its episode and a device, and cleans the name', () => {
    expect(parseTitleRequest({ item: 'tv:1399', title: 'GoT <b>x</b> www.spam.com', ep: 's1e3', device: DEVICE(1) })).toEqual({
      item: 'tv:1399',
      title: 'GoT x',
      ep: 's1e3',
      device: DEVICE(1),
    })
    // A film has no episode.
    expect(parseTitleRequest({ item: 'movie:550', title: 'x', ep: 's1e3', device: DEVICE(1) })?.ep).toBeNull()
    expect(parseTitleRequest({ item: 'person:1', device: DEVICE(1) })).toBeNull()
    expect(parseTitleRequest({ item: 'movie:550', device: 'short' })).toBeNull()
    expect(playPath('tv:1399', 's2e5')).toBe('/tv/1399/2/5')
    expect(playPath('tv:1399', null)).toBe('/tv/1399/1/1')
    expect(playPath('movie:550', null)).toBe('/movie/550')
  })

  it('counts one request per person per title: per device, and per account when signed in', async () => {
    const w = world()
    expect((await ask(w.fetchImpl, 1)).json).toEqual({ ok: true, count: 1, already: false })
    // The same phone again: not counted twice.
    expect((await ask(w.fetchImpl, 1)).json).toMatchObject({ count: 1, already: true })
    // Signed in on a second phone: counted.
    expect((await ask(w.fetchImpl, 2, { auth: 'Bearer good-token' })).json).toEqual({ ok: true, count: 2, already: false })
    // The same account on a third phone: still one.
    expect((await ask(w.fetchImpl, 3, { auth: 'Bearer good-token' })).json).toMatchObject({ count: 2, already: true })
    // A token Supabase refuses: just a device.
    expect((await ask(w.fetchImpl, 4, { auth: 'Bearer forged' })).json).toMatchObject({ count: 3 })
    // Nobody is emailed: no list of requesters is kept.
    expect(w.redis.sets.has('requests:users:movie:550')).toBe(false)
    expect(w.redis.hashes.get('requests:meta:movie:550')?.get('title')).toBe('Fight Club')
  })

  it(`tells the admin on Telegram once, when a title reaches ${ALERT_AT} requests`, async () => {
    const w = world()
    for (let n = 1; n < ALERT_AT; n++) await ask(w.fetchImpl, n, { item: 'tv:1399', title: 'GoT', ep: 's1e3' })
    expect(w.telegram).toEqual([])
    await ask(w.fetchImpl, ALERT_AT, { item: 'tv:1399', title: 'GoT', ep: 's1e3' })
    expect(w.telegram).toHaveLength(1)
    // TMDB's name, not the requester's.
    expect(w.telegram[0]).toContain('5 requests: "Game of Thrones" (series 1399 S1E3)')
    await ask(w.fetchImpl, ALERT_AT + 1, { item: 'tv:1399' })
    expect(w.telegram).toHaveLength(1)
  })

  it(`holds a device to ${DAILY_PER_DEVICE} requests a day`, async () => {
    const w = world()
    for (let n = 0; n < DAILY_PER_DEVICE; n++) expect((await ask(w.fetchImpl, 1, { item: `movie:${n + 1}` })).status).toBe(200)
    expect((await ask(w.fetchImpl, 1, { item: 'movie:999' })).status).toBe(429)
    expect((await call('request', 'POST', w.fetchImpl, { body: { item: 'nope' } })).status).toBe(400)
  })

  it('lists the most requested titles for the admin only', async () => {
    const w = world()
    await ask(w.fetchImpl, 1, { item: 'tv:1399', title: 'GoT' })
    await ask(w.fetchImpl, 1)
    await ask(w.fetchImpl, 2, { auth: 'Bearer good-token' })
    expect((await call('requests', 'GET', w.fetchImpl)).status).toBe(401)
    const list = await call('requests', 'GET', w.fetchImpl, { auth: 'Bearer open sesame' })
    expect(list.json.total).toBe(2)
    expect(list.json.titles).toMatchObject([
      { item: 'movie:550', count: 2, title: 'Fight Club', availableAt: null, seenPlaying: 0 },
      { item: 'tv:1399', count: 1, title: 'GoT' },
    ])
  })

  it('checks waiting titles each day with NextStream, emails nobody, and tells the admin', async () => {
    const playable = new Set<string>()
    const w = world({ playable })
    await ask(w.fetchImpl, 1, { auth: 'Bearer good-token' })
    await ask(w.fetchImpl, 2, { item: 'tv:1399', title: 'GoT', ep: 's2e5' })

    // Only the cron (CRON_SECRET) or the admin may run it.
    expect((await call('requests-check', 'GET', w.fetchImpl)).status).toBe(401)
    expect((await call('requests-check', 'GET', w.fetchImpl, { auth: 'Bearer cron-secret' })).json).toMatchObject({ checked: 2, nowPlaying: [], stillMissing: 2 })

    // Fight Club starts playing.
    playable.add('/movie/550')
    const check = await call('requests-check', 'GET', w.fetchImpl, { auth: 'Bearer cron-secret' })
    expect(check.json).toMatchObject({ checked: 2, nowPlaying: [{ item: 'movie:550', title: 'Fight Club', via: 'nextstream' }], stillMissing: 1 })
    expect(w.emails).toEqual([])
    expect(w.telegram.at(-1)).toContain('✅ Fight Club: playing now')

    // The next day: not checked again; the series is checked on the episode that failed.
    const again = await call('requests-check', 'POST', w.fetchImpl, { auth: 'Bearer open sesame' })
    expect(again.json).toMatchObject({ checked: 1, nowPlaying: [], stillMissing: 1 })
    playable.add('/tv/1399/2/5')
    expect((await call('requests-check', 'GET', w.fetchImpl, { auth: 'Bearer cron-secret' })).json).toMatchObject({ nowPlaying: [{ item: 'tv:1399', title: 'Game of Thrones' }] })

    // Asked for again after it played: missing again, so it's checked again.
    await ask(w.fetchImpl, 5)
    expect(w.redis.hashes.get('requests:meta:movie:550')?.has('availableAt')).toBe(false)
    const list = await call('requests', 'GET', w.fetchImpl, { auth: 'Bearer open sesame' })
    expect(list.json.titles).toContainEqual(expect.objectContaining({ item: 'tv:1399', availableAt: NOW, foundBy: 'nextstream' }))
    expect(w.emails).toEqual([])
  })

  it('counts a title as playing once viewers on 2 networks saw it play (EmbedMaster included), with no key call', async () => {
    const w = world()
    const play = (body: unknown, ip: string) => call('playing', 'POST', w.fetchImpl, { body, ip })
    expect(parsePlaying({ item: 'movie:550', server: 'other' })).toBeNull()
    // Nobody asked for it yet: not kept.
    expect((await play({ item: 'movie:550', server: 'embedmaster' }, '1.1.1.1')).status).toBe(200)
    expect(w.redis.zsets.has('requests:played:movie:550')).toBe(false)

    await ask(w.fetchImpl, 1)
    await ask(w.fetchImpl, 2, { item: 'tv:1399', title: 'GoT', ep: 's2e5' })
    await play({ item: 'movie:550', server: 'embedmaster' }, '1.1.1.1')
    // The same network twice is one.
    await play({ item: 'movie:550', server: 'embedmaster' }, '1.1.1.1')
    // Another episode of the series proves nothing about S2 E5.
    await play({ item: 'tv:1399', ep: 's1e1', server: 'embedmaster' }, '2.2.2.2')
    await play({ item: 'tv:1399', ep: 's1e1', server: 'embedmaster' }, '3.3.3.3')
    let list = await call('requests', 'GET', w.fetchImpl, { auth: 'Bearer open sesame' })
    expect(list.json.titles).toContainEqual(expect.objectContaining({ item: 'movie:550', seenPlaying: 1 }))
    expect(list.json.titles).toContainEqual(expect.objectContaining({ item: 'tv:1399', seenPlaying: 0 }))

    await play({ item: 'movie:550', server: 'nextstream' }, '4.4.4.4')
    const env: LiveEnv = { ...ENV, requests: { ...REQUESTS, nextstream: { ...REQUESTS.nextstream, movieTemplate: '', tvTemplate: '' } } }
    const res = fakeResponse()
    const req = { method: 'GET', headers: { authorization: 'Bearer cron-secret' } } as unknown as IncomingMessage
    // Even with NextStream off: what viewers saw is enough.
    await handleLive(env, 'requests-check', req, res as unknown as ServerResponse, w.fetchImpl, NOW)
    expect(JSON.parse(res.body)).toMatchObject({ nowPlaying: [{ item: 'movie:550', title: 'Fight Club', via: 'viewers' }] })
    expect(w.telegram.at(-1)).toContain('✅ Fight Club: playing now (seen playing by viewers)')
    expect(w.emails).toEqual([])
    list = await call('requests', 'GET', w.fetchImpl, { auth: 'Bearer open sesame' })
    expect(list.json.titles).toContainEqual(expect.objectContaining({ item: 'movie:550', foundBy: 'viewers', availableAt: NOW }))
  })

  it('says so when NextStream isn’t set up, and checks nothing', async () => {
    const w = world()
    await ask(w.fetchImpl, 1)
    const res = fakeResponse()
    const env: LiveEnv = { ...ENV, requests: { ...REQUESTS, nextstream: { ...REQUESTS.nextstream, movieTemplate: '', tvTemplate: '' } } }
    const req = { method: 'GET', headers: { authorization: 'Bearer cron-secret' } } as unknown as IncomingMessage
    await handleLive(env, 'requests-check', req, res as unknown as ServerResponse, w.fetchImpl, NOW)
    expect(JSON.parse(res.body)).toMatchObject({ checked: 0, error: expect.stringContaining('NextStream') })
  })
})
