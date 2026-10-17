import { createHash, createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  channelMembership,
  checkTelegramLogin,
  handleGate,
  readGateToken,
  signGateToken,
  type GateEnv,
} from './telegramGate'

// A made-up bot token: the real one lives only in Vercel and .env.local.
const env: GateEnv = { botToken: '123456:TEST-token', secret: 'test-secret-that-is-long-enough' }
const NOW = 1_800_000_000

/** Signs login data the way Telegram does. */
function telegramLogin(fields: Record<string, string | number>, botToken = env.botToken) {
  const check = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n')
  const key = createHash('sha256').update(botToken).digest()
  return { ...fields, hash: createHmac('sha256', key).update(check).digest('hex') }
}

const login = (overrides: Record<string, string | number> = {}) =>
  telegramLogin({ id: 42, first_name: 'Ada', username: 'ada', auth_date: NOW - 60, ...overrides })

const memberReply = (result: object) =>
  vi.fn(async () => new Response(JSON.stringify({ ok: true, result })))

function request(method: string, url: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage
  Object.assign(req, { method, url })
  return req
}

function response() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value
    },
    end(text: string) {
      res.body = text
    },
  }
  return res as typeof res & ServerResponse
}

async function call(method: string, url: string, body?: unknown, fetchFn = memberReply({ status: 'member' })) {
  const res = response()
  await handleGate(env, request(method, url, body), res, fetchFn as unknown as typeof fetch, NOW)
  return { status: res.statusCode, json: JSON.parse(res.body), cookie: res.headers['set-cookie'], fetchFn }
}

describe('checkTelegramLogin', () => {
  it('accepts a login signed with the bot token', () => {
    expect(checkTelegramLogin(login(), env.botToken, NOW)).toBe(42)
  })

  it('rejects a changed field, another bot, or a login older than 24h', () => {
    expect(checkTelegramLogin({ ...login(), id: 43 }, env.botToken, NOW)).toBeNull()
    expect(checkTelegramLogin(telegramLogin({ id: 42, auth_date: NOW }, '999:other'), env.botToken, NOW)).toBeNull()
    expect(checkTelegramLogin(login({ auth_date: NOW - 25 * 60 * 60 }), env.botToken, NOW)).toBeNull()
    expect(checkTelegramLogin({ id: 42, auth_date: NOW }, env.botToken, NOW)).toBeNull()
  })
})

describe('gate tokens', () => {
  it('holds only the user id and the time, and checks the signature', () => {
    const token = signGateToken(42, env.secret, NOW)
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toEqual({ uid: 42, iat: NOW })
    expect(readGateToken(token, env.secret)).toEqual({ uid: 42, iat: NOW })
    expect(readGateToken(token, 'another-secret')).toBeNull()
    const forged = `${Buffer.from(JSON.stringify({ uid: 7, iat: NOW })).toString('base64url')}.${token.split('.')[1]}`
    expect(readGateToken(forged, env.secret)).toBeNull()
  })
})

describe('channelMembership', () => {
  it('counts members, admins, the creator and restricted members as joined', async () => {
    for (const status of ['member', 'administrator', 'creator']) {
      expect(await channelMembership(env.botToken, 42, memberReply({ status }))).toBe('joined')
    }
    expect(await channelMembership(env.botToken, 42, memberReply({ status: 'restricted', is_member: true }))).toBe('joined')
    expect(await channelMembership(env.botToken, 42, memberReply({ status: 'restricted', is_member: false }))).toBe('not-joined')
    expect(await channelMembership(env.botToken, 42, memberReply({ status: 'left' }))).toBe('not-joined')
    expect(await channelMembership(env.botToken, 42, memberReply({ status: 'kicked' }))).toBe('not-joined')
  })

  it('asks the Bot API about @naijatr', async () => {
    const fetchFn = memberReply({ status: 'member' })
    await channelMembership(env.botToken, 42, fetchFn)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:TEST-token/getChatMember?chat_id=%40naijatr&user_id=42',
      expect.anything(),
    )
  })

  it('is "unavailable" when Telegram fails', async () => {
    const down = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(await channelMembership(env.botToken, 42, down)).toBe('unavailable')
    const notAdmin = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot is not a member' })))
    expect(await channelMembership(env.botToken, 42, notAdmin)).toBe('unavailable')
  })
})

describe('/api/telegram', () => {
  it('verify: a member gets a signed token and a 1-year cookie', async () => {
    const { status, json, cookie } = await call('POST', '/api/telegram/verify', login())
    expect(status).toBe(200)
    expect(json.status).toBe('joined')
    expect(readGateToken(json.token, env.secret)).toEqual({ uid: 42, iat: NOW })
    expect(cookie).toBe(`naijatr_gate=${json.token}; Path=/; Max-Age=31536000; Secure; SameSite=Lax`)
    // The bot token is never sent to the browser.
    expect(JSON.stringify(json)).not.toContain('TEST-token')
  })

  it('verify: not in the channel, a bad login, or Telegram down', async () => {
    expect((await call('POST', '/api/telegram/verify', login(), memberReply({ status: 'left' }))).json).toEqual({ status: 'not-joined' })
    const bad = await call('POST', '/api/telegram/verify', { ...login(), id: 7 })
    expect(bad).toMatchObject({ status: 400, json: { status: 'invalid' } })
    expect(bad.fetchFn).not.toHaveBeenCalled()
    const down = vi.fn(async () => new Response('Bad gateway', { status: 502 }))
    expect((await call('POST', '/api/telegram/verify', login(), down)).json).toEqual({ status: 'unavailable' })
  })

  it('recheck: renews a still-valid member and clears the cookie for leavers or forged tokens', async () => {
    const token = signGateToken(42, env.secret, NOW - 40 * 24 * 60 * 60)
    const renewed = await call('POST', '/api/telegram/recheck', { token })
    expect(renewed.json.status).toBe('joined')
    expect(readGateToken(renewed.json.token, env.secret)?.iat).toBe(NOW)

    const left = await call('POST', '/api/telegram/recheck', { token }, memberReply({ status: 'left' }))
    expect(left.json).toEqual({ status: 'not-joined' })
    expect(left.cookie).toContain('Max-Age=0')

    const forged = await call('POST', '/api/telegram/recheck', { token: `${token}x` })
    expect(forged).toMatchObject({ status: 400, json: { status: 'invalid' } })
  })

  it('config: only the bot\'s public numeric id', async () => {
    expect((await call('GET', '/api/telegram/config')).json).toEqual({ botId: 123456 })
  })

  it('lets everyone through ("unavailable") when the secrets are not set', async () => {
    const res = response()
    await handleGate({ botToken: '', secret: '' }, request('POST', '/api/telegram/verify', login()), res)
    expect(JSON.parse(res.body)).toEqual({ status: 'unavailable' })
  })
})
