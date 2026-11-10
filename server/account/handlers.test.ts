import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleAccount, readAccountEnv, type AccountEnv } from './handlers'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const ENV: AccountEnv = { url: 'https://proj.supabase.co', serviceKey: 'service-key', adminPassword: 'open sesame', promo: null }

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

const request = (method: string, authorization?: string) =>
  ({ method, headers: authorization ? { authorization } : {} }) as unknown as IncomingMessage

async function call(action: string, req: IncomingMessage, fetchImpl: typeof fetch, env = ENV) {
  const res = fakeResponse()
  await handleAccount(env, action, req, res as unknown as ServerResponse, fetchImpl, NOW)
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> }
}

describe('/api/account', () => {
  it('reads the project URL from either name, and the service key from the server only', () => {
    expect(readAccountEnv({ VITE_SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: ' k ' })).toEqual({
      url: 'https://x.supabase.co',
      serviceKey: 'k',
      adminPassword: '',
      promo: null,
    })
  })

  it('deletes the login of the token’s own user', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/v1/user')) {
        expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer user-token')
        return new Response(JSON.stringify({ id: 'user-1' }))
      }
      expect(url).toBe('https://proj.supabase.co/auth/v1/admin/users/user-1')
      expect(init?.method).toBe('DELETE')
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer service-key')
      return new Response('{}')
    }) as unknown as typeof fetch
    expect(await call('delete', request('POST', 'Bearer user-token'), fetchImpl)).toEqual({ status: 200, json: { deleted: true } })
  })

  it('refuses a missing or invalid token, and says when the service key is missing', async () => {
    const invalid = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    expect((await call('delete', request('POST'), invalid)).status).toBe(401)
    expect((await call('delete', request('POST', 'Bearer nope'), invalid)).status).toBe(401)
    expect(await call('delete', request('POST', 'Bearer t'), invalid, { ...ENV, serviceKey: '' })).toEqual({
      status: 503,
      json: { error: 'not-configured' },
    })
  })

  it('counts users and today’s sign-ups (Lagos time) for the admin', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          users: [{ created_at: '2026-11-01T08:00:00Z' }, { created_at: '2026-10-31T23:30:00Z' }, { created_at: '2026-10-31T22:30:00Z' }],
        }),
      ),
    ) as unknown as typeof fetch
    // 23:30 UTC on the 31st is already the 1st in Lagos.
    expect(await call('stats', request('GET', 'Bearer open sesame'), fetchImpl)).toEqual({ status: 200, json: { users: 3, today: 2, promo: null } })
    expect((await call('stats', request('GET', 'Bearer wrong'), fetchImpl)).status).toBe(401)
  })

  it('shows the Free Ad-Free Week state and the sign-ups since it started', async () => {
    const env = readAccountEnv({
      SUPABASE_URL: ENV.url,
      SUPABASE_SERVICE_ROLE_KEY: ENV.serviceKey,
      ADMIN_PASSWORD: ENV.adminPassword,
      PROMO_START: '2026-10-30T00:00:00+01:00',
      PROMO_END: '2026-11-05T23:59:59+01:00',
    })
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          users: [
            { created_at: '2026-11-01T08:00:00Z' },
            { created_at: '2026-10-30T10:00:00Z' },
            // 23:30 UTC on the 29th is already the 30th in Lagos: counted.
            { created_at: '2026-10-29T23:30:00Z' },
            { created_at: '2026-10-29T22:30:00Z' },
          ],
        }),
      ),
    ) as unknown as typeof fetch
    expect((await call('stats', request('GET', 'Bearer open sesame'), fetchImpl, env)).json).toEqual({
      users: 4,
      today: 1,
      promo: { state: 'active', start: '2026-10-29T23:00:00.000Z', end: '2026-11-05T22:59:59.000Z', signups: 3 },
    })
  })
})
