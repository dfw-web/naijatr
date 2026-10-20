import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { cleanText, DAILY_MESSAGES, handleFeedback, parseFeedback, telegramText, type FeedbackEnv, type FeedbackItem } from './handlers'

const NOW = Date.parse('2026-10-20T11:41:00Z')
const DEVICE = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789'
const ENV: FeedbackEnv = {
  redisUrl: 'https://redis.example.com',
  redisToken: 'redis-token',
  adminPassword: 'open sesame',
  telegramToken: 'bot-token',
  telegramChatId: '12345',
}

/** Just enough of Upstash's REST pipeline, kept in memory, plus Telegram's sendMessage. */
function services({ telegramDown = false } = {}) {
  const strings = new Map<string, string>()
  const sets = new Map<string, Map<string, number>>()
  const telegram: { chat_id: string; text: string }[] = []
  const run = ([command, key, ...args]: string[]): unknown => {
    switch (command) {
      case 'INCR': {
        const value = Number(strings.get(key) ?? 0) + 1
        strings.set(key, String(value))
        return value
      }
      case 'EXPIRE':
        return 1
      case 'SET':
        strings.set(key, args[0])
        return 'OK'
      case 'GET':
        return strings.get(key) ?? null
      case 'MGET':
        return [key, ...args].map((k) => strings.get(k) ?? null)
      case 'DEL':
        return Number(strings.delete(key))
      case 'ZADD': {
        const set = sets.get(key) ?? new Map<string, number>()
        set.set(args[1], Number(args[0]))
        sets.set(key, set)
        return 1
      }
      case 'ZREM':
        return Number(sets.get(key)?.delete(args[0]) ?? false)
      case 'ZRANGE':
        return [...(sets.get(key) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([member]) => member)
      default:
        throw new Error(`unexpected ${command}`)
    }
  }
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.telegram.org/')) {
      if (telegramDown) throw new TypeError('offline')
      telegram.push(JSON.parse(String(init.body)))
      return new Response('{"ok":true}')
    }
    const commands = JSON.parse(String(init.body)) as string[][]
    return new Response(JSON.stringify(commands.map((c) => ({ result: run(c) }))))
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, mock: fetchImpl, telegram, strings }
}

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

const request = (method: string, body?: unknown, authorization?: string) =>
  ({ method, body, headers: authorization ? { authorization } : {} }) as unknown as IncomingMessage & { body?: unknown }

async function call(action: string, req: IncomingMessage & { body?: unknown }, fetchImpl: typeof fetch, now = NOW, env = ENV) {
  const res = fakeResponse()
  await handleFeedback(env, action, req, res as unknown as ServerResponse, fetchImpl, now)
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> }
}

const review = (extra: Record<string, unknown> = {}) => ({
  type: 'review',
  rating: 4,
  message: 'Love the site, please add more Nollywood',
  page: '/movie/123',
  device: DEVICE,
  mobile: true,
  ...extra,
})

const admin = 'Bearer open sesame'

describe('feedback: checking what is sent', () => {
  it('strips HTML and links, and keeps plain text', () => {
    expect(cleanText('<b>Great</b> site! see https://spam.example/x and www.spam.com or visit cheap-pills.xyz now', 500)).toBe(
      'Great site! see and or visit now',
    )
    expect(cleanText('x'.repeat(600), 500)).toHaveLength(500)
  })

  it('refuses empty, too long, unknown types and bad ratings', () => {
    expect(parseFeedback(review({ message: '   ' }))).toEqual({ ok: false, error: 'empty' })
    expect(parseFeedback(review({ message: '<a href="https://x.example">https://x.example</a>' }))).toEqual({ ok: false, error: 'empty' })
    expect(parseFeedback(review({ message: 'x'.repeat(501) }))).toEqual({ ok: false, error: 'too-long' })
    expect(parseFeedback(review({ type: 'praise' }))).toEqual({ ok: false, error: 'bad-request' })
    expect(parseFeedback(review({ rating: 6 }))).toEqual({ ok: false, error: 'bad-request' })
    expect(parseFeedback(review({ device: 'x' }))).toEqual({ ok: false, error: 'bad-request' })
    // A "Rate this" needs stars and a title, not a message.
    expect(parseFeedback({ type: 'rating', rating: 5, title: 'Fight Club', page: '/', device: DEVICE })).toMatchObject({ ok: true, spam: false })
    expect(parseFeedback({ type: 'rating', title: 'Fight Club', device: DEVICE })).toEqual({ ok: false, error: 'bad-request' })
  })

  it('keeps only what the form asks for', () => {
    const parsed = parseFeedback(review({ name: '@naija_fan', ip: '1.2.3.4', email: 'x@y.z' }))
    expect(parsed).toEqual({
      ok: true,
      spam: false,
      deviceId: DEVICE,
      item: { type: 'review', rating: 4, message: 'Love the site, please add more Nollywood', name: '@naija_fan', page: '/movie/123', title: '', device: 'mobile' },
    })
  })
})

describe('feedback: sending', () => {
  it('saves it and forwards it to Telegram', async () => {
    const { fetchImpl, telegram } = services()
    expect(await call('send', request('POST', review()), fetchImpl)).toEqual({ status: 200, json: { ok: true } })
    expect(telegram).toEqual([
      { chat_id: '12345', text: '⭐ 4/5 · Review · mobile\n"Love the site, please add more Nollywood"\nPage: /movie/123 · 12:41', disable_web_page_preview: true },
    ])
    const list = await call('list', request('GET', undefined, admin), fetchImpl)
    expect(list.json).toMatchObject({ total: 1, averageRating: 4, items: [{ type: 'review', rating: 4, done: false }] })
  })

  it('still saves it when Telegram is down', async () => {
    const { fetchImpl } = services({ telegramDown: true })
    expect((await call('send', request('POST', review()), fetchImpl)).status).toBe(200)
    expect((await call('list', request('GET', undefined, admin), fetchImpl)).json).toMatchObject({ total: 1 })
  })

  it('quietly drops bots that fill in the hidden field', async () => {
    const { fetchImpl, mock } = services()
    expect(await call('send', request('POST', review({ website: 'http://spam' })), fetchImpl)).toEqual({ status: 200, json: { ok: true } })
    expect(mock).not.toHaveBeenCalled()
  })

  it('takes 3 messages a day from a device, then again the next day', async () => {
    const { fetchImpl } = services()
    for (let i = 0; i < DAILY_MESSAGES; i += 1) expect((await call('send', request('POST', review()), fetchImpl)).status).toBe(200)
    expect(await call('send', request('POST', review()), fetchImpl)).toEqual({ status: 429, json: { error: 'limit' } })
    // Ratings have their own allowance.
    expect((await call('send', request('POST', { type: 'rating', rating: 5, title: 'Sintel', page: '/', device: DEVICE }), fetchImpl)).status).toBe(200)
    expect((await call('send', request('POST', review()), fetchImpl, NOW + 24 * 60 * 60_000)).status).toBe(200)
  })

  it('answers not-configured without Redis', async () => {
    const { fetchImpl } = services()
    expect((await call('send', request('POST', review()), fetchImpl, NOW, { ...ENV, redisUrl: '' })).status).toBe(503)
  })
})

describe('feedback: the admin', () => {
  it('needs the password', async () => {
    const { fetchImpl } = services()
    expect((await call('list', request('GET'), fetchImpl)).status).toBe(401)
    expect((await call('list', request('GET', undefined, 'Bearer nope'), fetchImpl)).status).toBe(401)
    expect((await call('update', request('POST', { id: 'abcdefgh1', action: 'delete' }), fetchImpl)).status).toBe(401)
  })

  it('averages ratings and counts the most requested titles', async () => {
    const { fetchImpl } = services()
    const send = (body: Record<string, unknown>, device: string) => call('send', request('POST', { page: '/', ...body, device }), fetchImpl)
    await send({ type: 'request', message: 'Please add Squid Game season 3' }, `${DEVICE}1`)
    await send({ type: 'request', message: 'squid game 3 pls', rating: 5 }, `${DEVICE}2`)
    await send({ type: 'request', message: 'Add Black Panther' }, `${DEVICE}3`)
    await send({ type: 'rating', rating: 2, title: 'Sintel' }, `${DEVICE}4`)
    const { json } = await call('list', request('GET', undefined, admin), fetchImpl)
    expect(json).toMatchObject({ total: 4, averageRating: 3.5, ratings: 2, telegram: true })
    expect(json.topRequests).toEqual([
      { text: 'Please add Squid Game season 3', count: 2 },
      { text: 'Add Black Panther', count: 1 },
    ])
  })

  it('marks items done and deletes them', async () => {
    const { fetchImpl } = services()
    await call('send', request('POST', review()), fetchImpl)
    const list = async () => (await call('list', request('GET', undefined, admin), fetchImpl)).json.items as FeedbackItem[]
    const [{ id }] = await list()
    expect((await call('update', request('POST', { id, action: 'done' }, admin), fetchImpl)).status).toBe(200)
    expect((await list())[0].done).toBe(true)
    expect((await call('update', request('POST', { id, action: 'delete' }, admin), fetchImpl)).status).toBe(200)
    expect(await list()).toEqual([])
  })

  it('formats the Telegram message with the title for ratings', () => {
    const item: FeedbackItem = { id: 'x', type: 'rating', rating: 5, message: '', name: '', page: '/movie/550', title: 'Fight Club', device: 'desktop', at: NOW, done: false }
    expect(telegramText(item)).toBe('⭐ 5/5 · Rating · desktop\n🎬 Fight Club\nPage: /movie/550 · 12:41')
  })
})
