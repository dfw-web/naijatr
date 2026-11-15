import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_CHECKS_PER_MINUTE, handleAccount, readAccountEnv, resetEmailChecks, type AccountEnv } from './handlers'

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

  describe('email-status (before Create account sends anything)', () => {
    const post = (body: unknown, ip = '1.2.3.4') =>
      ({ method: 'POST', headers: { 'x-forwarded-for': ip }, body }) as unknown as IncomingMessage

    /** Supabase with these logins (and their profiles' normalized inboxes). */
    function supabase(users: { id: string; email: string; email_confirmed_at?: string | null }[], profiles: { user_id: string; email_normalized: string }[] = []) {
      const calls: string[] = []
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer service-key')
        expect(init?.method ?? 'GET').toBe('GET')
        const profile = /\/rest\/v1\/profiles\?select=user_id&email_normalized=eq\.([^&]+)/.exec(url)
        if (profile) {
          const wanted = decodeURIComponent(profile[1])
          return new Response(JSON.stringify(profiles.filter((row) => row.email_normalized === wanted).map(({ user_id }) => ({ user_id }))))
        }
        const one = /\/auth\/v1\/admin\/users\/([^?]+)$/.exec(url)
        if (one) {
          const user = users.find((u) => u.id === decodeURIComponent(one[1]))
          return user ? new Response(JSON.stringify(user)) : new Response('{}', { status: 404 })
        }
        if (url.includes('/auth/v1/admin/users?page=')) return new Response(JSON.stringify({ users }))
        throw new Error(`unexpected ${url}`)
      }) as unknown as typeof fetch
      return { fetchImpl, calls }
    }

    beforeEach(() => resetEmailChecks())

    it('says "new" for an address with no login, and never sends or creates anything', async () => {
      const { fetchImpl, calls } = supabase([{ id: 'u1', email: 'someone@else.com', email_confirmed_at: '2026-01-01T00:00:00Z' }])
      expect(await call('email-status', post({ email: 'new.person@example.com' }), fetchImpl)).toEqual({ status: 200, json: { status: 'new' } })
      expect(calls.every((line) => line.startsWith('GET '))).toBe(true)
      expect(calls.some((line) => /\/(otp|signup|invite)/.test(line))).toBe(false)
    })

    it('finds a confirmed account through its profile', async () => {
      const { fetchImpl } = supabase(
        [{ id: 'u1', email: 'Ada@Example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }],
        [{ user_id: 'u1', email_normalized: 'ada@example.com' }],
      )
      expect((await call('email-status', post({ email: ' ada@example.com ' }), fetchImpl)).json).toEqual({ status: 'confirmed', email: 'Ada@Example.com' })
    })

    it('finds an account that never confirmed its email (no profile yet)', async () => {
      const { fetchImpl } = supabase([{ id: 'u2', email: 'tolu@example.com', email_confirmed_at: null }])
      expect((await call('email-status', post({ email: 'TOLU@example.com' }), fetchImpl)).json).toEqual({ status: 'unconfirmed', email: 'tolu@example.com' })
    })

    it('treats Gmail dots and +tags as the same inbox, through profiles and the login list', async () => {
      const viaProfile = supabase(
        [{ id: 'u1', email: 'adaeze@gmail.com', email_confirmed_at: '2026-01-01T00:00:00Z' }],
        [{ user_id: 'u1', email_normalized: 'adaeze@gmail.com' }],
      )
      for (const typed of ['a.da.eze@gmail.com', 'adaeze+films@gmail.com', 'A.Daeze+x@googlemail.com']) {
        expect((await call('email-status', post({ email: typed }), viaProfile.fetchImpl)).json).toEqual({ status: 'confirmed', email: 'adaeze@gmail.com' })
      }
      const viaList = supabase([{ id: 'u3', email: 'chi.oma+old@gmail.com', email_confirmed_at: null }])
      expect((await call('email-status', post({ email: 'chioma@gmail.com' }), viaList.fetchImpl)).json).toEqual({ status: 'unconfirmed', email: 'chi.oma+old@gmail.com' })
      // Dots matter outside Gmail.
      const other = supabase([{ id: 'u4', email: 'ada@yahoo.com', email_confirmed_at: '2026-01-01T00:00:00Z' }])
      expect((await call('email-status', post({ email: 'a.da@yahoo.com' }), other.fetchImpl)).json).toEqual({ status: 'new' })
    })

    it('prefers the confirmed login when one inbox has two', async () => {
      const { fetchImpl } = supabase([
        { id: 'u5', email: 'kemi.o@gmail.com', email_confirmed_at: null },
        { id: 'u6', email: 'kemio@gmail.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
      ])
      expect((await call('email-status', post({ email: 'kemio+a@gmail.com' }), fetchImpl)).json).toEqual({ status: 'confirmed', email: 'kemio@gmail.com' })
    })

    it('answers POST only, needs a valid email and the service key, and limits each IP', async () => {
      const { fetchImpl } = supabase([])
      expect((await call('email-status', request('GET'), fetchImpl)).status).toBe(405)
      expect((await call('email-status', post({ email: 'not-an-email' }), fetchImpl)).status).toBe(400)
      expect((await call('email-status', post({}), fetchImpl)).status).toBe(400)
      expect((await call('email-status', post({ email: 'a@b.co' }), fetchImpl, { ...ENV, serviceKey: '' })).status).toBe(503)
      resetEmailChecks()
      for (let i = 0; i < EMAIL_CHECKS_PER_MINUTE; i++) expect((await call('email-status', post({ email: 'a@b.co' }, '9.9.9.9'), fetchImpl)).status).toBe(200)
      expect((await call('email-status', post({ email: 'a@b.co' }, '9.9.9.9'), fetchImpl)).json).toEqual({ error: 'rate' })
      expect((await call('email-status', post({ email: 'a@b.co' }, '8.8.8.8'), fetchImpl)).status).toBe(200)
    })
  })
})
