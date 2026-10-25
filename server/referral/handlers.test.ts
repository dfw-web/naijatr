import { createHash, createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { fakeRedis } from '../testing/fakeRedis'
import { contestPhase, parseLagosTime, readContest } from './contest'
import { handleReferral, IP_DAILY_CAP, readReferralEnv, suspicionFlags, type ReferralRecord } from './handlers'
import { createSession, decrypt, encrypt, readSession, verifyTelegramLogin } from './security'

const BOT = '123456:TEST-token'
const HOUR = 3_600_000
const START = parseLagosTime('2026-10-23 18:00')
const END = parseLagosTime('2026-10-25 23:59') + 59_999
const DURING = START + HOUR
const AFTER = END + HOUR
const BOARD_TIME = DURING

const device = (n: number | string) => `device-${String(n).padStart(12, '0')}`

/** What the Telegram Login Widget hands the page, signed for BOT. */
function widget(id: number, username: string, at = DURING) {
  const data: Record<string, string | number> = { id, first_name: username, username, auth_date: Math.floor(at / 1000) }
  const check = Object.keys(data)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('\n')
  const hash = createHmac('sha256', createHash('sha256').update(BOT).digest()).update(check).digest('hex')
  return { ...data, hash }
}

function setup(envOverrides: Record<string, string> = {}) {
  let clock = DURING
  const store = fakeRedis(() => clock)
  const telegram: { chat_id: string | number; text: string }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      telegram.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true })
    }
    return store.fetchImpl(url, init)
  }) as typeof fetch
  const env = readReferralEnv({
    KV_REST_API_URL: 'https://redis.example',
    KV_REST_API_TOKEN: 't',
    TELEGRAM_BOT_TOKEN: BOT,
    ADMIN_TELEGRAM_CHAT_ID: '999',
    ADMIN_PASSWORD: 'admin-pass',
    NAIJATR_GATE_SECRET: 'session-secret',
    CLAIM_ENCRYPTION_KEY: 'claim-key',
    CONTEST_ACTIVE: 'true',
    CONTEST_START: '2026-10-23 18:00',
    CONTEST_END: '2026-10-25 23:59',
    ...envOverrides,
  })

  async function call(
    action: string,
    { body, token, ip = '1.1.1.1', method = body ? 'POST' : 'GET', query = '' }: { body?: unknown; token?: string; ip?: string; method?: string; query?: string } = {},
  ) {
    const req = {
      method,
      url: `/api/referral/${action}${query}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': ip, 'user-agent': `agent-${ip}` },
      body,
    } as unknown as IncomingMessage
    let raw = ''
    const res = { statusCode: 200, setHeader() {}, end: (text: string) => (raw = text) } as unknown as ServerResponse
    await handleReferral(env, action, req, res, fetchImpl, clock)
    return { status: res.statusCode, body: JSON.parse(raw) as Record<string, unknown> & { [key: string]: never } }
  }

  async function join(id: number, name: string, onDevice = device(`own-${id}`)) {
    const { body } = await call('login', { body: { auth: widget(id, name, clock), device: onDevice } })
    return { token: body.token as string, code: (body.user as { code: string }).code }
  }

  /** A friend opens the link on a new device, then plays. */
  async function refer(code: string, friend: string | number, { ip = `10.0.0.${friend}`, newDevice = true, token }: { ip?: string; newDevice?: boolean; token?: string } = {}) {
    await call('arrive', { body: { code, device: device(friend), newDevice }, ip })
    const { body } = await call('count', { body: { device: device(friend) }, ip, token })
    return body.outcome
  }

  const admin = (action: string, body?: unknown) => call(action, { body, token: 'admin-pass' })
  const setClock = (at: number) => (clock = at)
  return { env, store, telegram, call, join, refer, admin, setClock }
}

describe('contest settings', () => {
  it('reads Lagos times and runs only between start and end', () => {
    expect(new Date(START).toISOString()).toBe('2026-10-23T17:00:00.000Z')
    const contest = readContest({ CONTEST_ACTIVE: 'true', CONTEST_START: '2026-10-23 18:00', CONTEST_END: '2026-10-25 23:59' })!
    expect(contest.prizes).toEqual([30000, 20000, 10000])
    expect(contestPhase(contest, START - 1)).toBe('upcoming')
    expect(contestPhase(contest, START)).toBe('live')
    expect(contestPhase(contest, parseLagosTime('2026-10-25 23:59') + 30_000)).toBe('live')
    expect(contestPhase(contest, END + 1)).toBe('ended')
    expect(contestPhase({ ...contest, active: false }, DURING)).toBe('off')
    expect(readContest({ CONTEST_START: 'soon', CONTEST_END: '2026-10-25 23:59' })).toBeNull()
  })

  it('shows prizes only while the contest runs', async () => {
    const t = setup()
    expect((await t.call('contest')).body).toMatchObject({ phase: 'live', prizes: [30000, 20000, 10000], end: END })
    t.setClock(AFTER)
    expect((await t.call('contest')).body).toMatchObject({ phase: 'ended', prizes: null, winners: null })
  })
})

describe('scoring window', () => {
  it('counts referrals only between start and end, then freezes', async () => {
    const t = setup()
    t.setClock(START - HOUR)
    const { token, code } = await t.join(1, 'bruno')
    expect(await t.refer(code, 1)).toBe('counted')
    t.setClock(DURING)
    expect(await t.refer(code, 2)).toBe('counted')
    t.setClock(AFTER)
    expect(await t.refer(code, 3)).toBe('counted')
    // All three are referrals; only the one in the window scored.
    expect((await t.call('me', { token })).body).toMatchObject({ total: 3, points: 1, rank: 1 })
  })
})

describe('anti-cheat', () => {
  it('needs a new device that arrived by a link', async () => {
    const t = setup()
    const { code } = await t.join(1, 'bruno')
    expect(await t.refer(code, 1, { newDevice: false })).toBe('not-new')
    expect((await t.call('count', { body: { device: device(2) } })).body.outcome).toBe('no-invite')
    expect(await t.refer('NOPE99', 3)).toBe('unknown-code')
  })

  it('refuses self-referrals by device and by Telegram id', async () => {
    const t = setup()
    const { token, code } = await t.join(1, 'bruno', device('mine'))
    expect(await t.refer(code, 'mine')).toBe('self')
    expect(await t.refer(code, 5, { token })).toBe('self')
  })

  it('counts each device once, ever', async () => {
    const t = setup()
    const a = await t.join(1, 'bruno')
    const b = await t.join(2, 'ada')
    expect(await t.refer(a.code, 7)).toBe('counted')
    expect(await t.refer(a.code, 7)).toBe('already')
    expect(await t.refer(b.code, 7)).toBe('already')
  })

  it('caps counted referrals per network per day, by a salted hash only', async () => {
    const t = setup()
    const { code } = await t.join(1, 'bruno')
    for (let i = 0; i < IP_DAILY_CAP; i += 1) expect(await t.refer(code, 20 + i, { ip: '5.5.5.5' })).toBe('counted')
    expect(await t.refer(code, 30, { ip: '5.5.5.5' })).toBe('ip-cap')
    t.setClock(DURING + 24 * HOUR)
    expect(await t.refer(code, 30, { ip: '5.5.5.5' })).toBe('counted')
    // Raw IPs are never stored.
    const everything = JSON.stringify([...t.store.strings, ...t.store.lists])
    expect(everything).not.toContain('5.5.5.5')
  })

  it('flags many referrals from one network and very fast plays', () => {
    const ref = (ip: string, delay: number, ua = 'u'): ReferralRecord => ({ at: 0, ip, ua, delay, contest: true })
    expect(suspicionFlags([ref('a', 60), ref('b', 60), ref('c', 60)])).toEqual([])
    expect(suspicionFlags([ref('a', 2), ref('a', 3), ref('a', 4)])).toEqual(['3 referrals from one network', '3 played within 15 seconds of opening the link'])
    expect(suspicionFlags(['a', 'b', 'c', 'd', 'e'].map((ip) => ref(ip, 60)))).toEqual(['5 from the same phone and browser type'])
  })

  it('refuses forged or stale Telegram sign-ins and forged sessions', () => {
    const good = widget(1, 'bruno')
    expect(verifyTelegramLogin(good, BOT, DURING)?.id).toBe(1)
    expect(verifyTelegramLogin({ ...good, id: 2 }, BOT, DURING)).toBeNull()
    expect(verifyTelegramLogin(good, 'other:token', DURING)).toBeNull()
    expect(verifyTelegramLogin(good, BOT, DURING + 25 * HOUR)).toBeNull()
    const session = createSession('s', 1, DURING)
    expect(readSession('s', session, DURING)).toBe(1)
    expect(readSession('s', session.replace(/^1\./, '2.'), DURING)).toBeNull()
    expect(readSession('other', session, DURING)).toBeNull()
  })
})

describe('leaderboard', () => {
  it('breaks ties by who got there first', async () => {
    const t = setup()
    const a = await t.join(1, 'bruno')
    const b = await t.join(2, 'ada')
    t.setClock(DURING)
    await t.refer(b.code, 1)
    t.setClock(DURING + 1000)
    await t.refer(a.code, 2)
    t.setClock(DURING + 2000)
    await t.refer(a.code, 3)
    t.setClock(DURING + 3000)
    await t.refer(b.code, 4)
    // Both on 2 points: bruno reached 2 first (ada only at the last referral).
    t.setClock(BOARD_TIME)
    const { body } = await t.call('leaderboard')
    expect(body.top).toEqual([
      { rank: 1, points: 2, name: '@bruno', me: false },
      { rank: 2, points: 2, name: '@ada', me: false },
    ])
  })

  it('hides names on request and shows your own rank', async () => {
    const t = setup()
    const a = await t.join(1, 'bruno')
    await t.refer(a.code, 1)
    await t.call('profile', { body: { hidden: true }, token: a.token })
    t.setClock(BOARD_TIME)
    const { body } = await t.call('leaderboard', { token: a.token })
    expect(body.top).toEqual([{ rank: 1, points: 1, name: 'Hidden player', me: true }])
    expect(body.me).toEqual({ rank: 1, points: 1, toTop3: 0 })
  })
})

describe('live leaderboard', () => {
  it('shows the ranking at any time of day while the contest runs, and after it', async () => {
    const t = setup()
    const a = await t.join(1, 'bruno')
    await t.join(2, 'ada')
    t.setClock(DURING)
    await t.refer(a.code, 1)
    await t.refer(a.code, 2)
    for (const time of ['2026-10-24 09:00', '2026-10-24 15:30', '2026-10-24 23:45']) {
      t.setClock(parseLagosTime(time))
      const { body } = await t.call('leaderboard', { token: a.token })
      expect(body).toEqual({ top: [{ rank: 1, points: 2, name: '@bruno', me: true }], me: { rank: 1, points: 2, toTop3: 0 } })
      expect((await t.call('me', { token: a.token })).body).toMatchObject({ points: 2, rank: 1 })
    }
    expect((await t.call('leaderboard')).body).toMatchObject({ top: [{ rank: 1, points: 2 }], me: null })
    // After the end: the final standings.
    t.setClock(AFTER)
    expect((await t.call('leaderboard')).body).toMatchObject({ top: [{ rank: 1, points: 2 }] })
  })

  it('never hides anything from the admin page', async () => {
    const t = setup()
    const a = await t.join(1, 'bruno')
    t.setClock(DURING)
    await t.refer(a.code, 1)
    const { body } = await t.admin('admin')
    expect(body.top).toMatchObject([{ rank: 1, points: 1, nickname: '@bruno' }])
  })
})

describe('points to the top 3', () => {
  it('tells each player how many more friends get them into the top 3', async () => {
    const t = setup()
    const players = [await t.join(1, 'bruno'), await t.join(2, 'ada'), await t.join(3, 'emeka'), await t.join(4, 'tunde')]
    let friend = 0
    for (const [i, n] of [5, 3, 2, 1].entries()) for (let j = 0; j < n; j += 1) await t.refer(players[i].code, (friend += 1))
    const gap = async (token: string) => ((await t.call('me', { token })).body as { toTop3: number }).toTop3
    expect(await gap(players[0].token)).toBe(0)
    expect(await gap(players[2].token)).toBe(0)
    // 3rd has 2: tunde (1) needs 2 more to pass, since a tie goes to whoever got there first.
    expect(await gap(players[3].token)).toBe(2)
    const newcomer = await t.join(5, 'kemi')
    expect(await gap(newcomer.token)).toBe(3)
    expect((await t.call('leaderboard', { token: players[3].token })).body.me).toEqual({ rank: 4, points: 1, toTop3: 2 })
  })

  it('needs just one point while fewer than 3 have any', async () => {
    const t = setup()
    const a = await t.join(1, 'bruno')
    const b = await t.join(2, 'ada')
    await t.refer(a.code, 1)
    expect((await t.call('me', { token: b.token })).body).toMatchObject({ toTop3: 1 })
    expect((await t.call('me', { token: a.token })).body).toMatchObject({ toTop3: 0 })
  })
})

describe('Telegram reminders', () => {
  const NIGHT = parseLagosTime('2026-10-23 23:40')
  const push = (t: ReturnType<typeof setup>, kind: string, token = 'cron-secret') => t.call('push', { token, query: `?kind=${kind}` })

  async function players() {
    const t = setup({ CRON_SECRET: 'cron-secret' })
    const a = await t.join(1, 'bruno')
    await t.join(2, 'ada')
    await t.join(3, 'cheat')
    await t.refer(a.code, 1)
    await t.refer(a.code, 2)
    await t.admin('admin-dq', { id: 3 })
    t.telegram.length = 0
    return t
  }

  it('sends the nightly "leaderboard is open" message with each player’s points and gap, once a night', async () => {
    const t = await players()
    t.setClock(NIGHT)
    expect((await push(t, 'night')).body).toEqual({ sent: 2, failed: 0 })
    const [bruno, ada] = [1, 2].map((id) => t.telegram.find((m) => m.chat_id === id)!.text)
    expect(bruno).toContain('🔴 The NAIJA TR leaderboard is live: see where you stand!')
    expect(bruno).toContain("🔥 You have 2 pts and you're in the top 3 right now.")
    expect(ada).toContain("You don't have any points yet: 1 friend watching with your link puts you in the 🥉 top 3.")
    expect(ada).toMatch(/⏳ 2d 0h left · 🥇₦30,000 🥈₦20,000 🥉₦10,000/)
    expect(ada).toContain('Leaderboard: https://www.naijatr.com/challenge')
    expect(ada).toMatch(/Your link: https:\/\/www\.naijatr\.com\/r\/ADA\d+/)
    // Disqualified players get nothing; a cron retry doesn't send again.
    expect(t.telegram.some((m) => m.chat_id === 3)).toBe(false)
    expect((await push(t, 'night')).body).toEqual({ sent: 0, skipped: 'already-sent' })
  })

  it('calls the last one the final night', async () => {
    const t = await players()
    t.setClock(parseLagosTime('2026-10-25 23:40'))
    await push(t, 'night')
    expect(t.telegram.at(-1)!.text).toContain('🏁 Final night! Check the live leaderboard: the challenge ends at 11:59 PM.')
  })

  it('sends the "final hours" message only on the last day', async () => {
    const t = await players()
    t.setClock(parseLagosTime('2026-10-24 18:00'))
    expect((await push(t, 'final')).body).toEqual({ sent: 0, skipped: 'not-now' })
    t.setClock(parseLagosTime('2026-10-25 18:00'))
    expect((await push(t, 'final')).body).toEqual({ sent: 2, failed: 0 })
    expect(t.telegram[0].text).toContain('⏳ Only 5h 59m left in the NAIJA TR Invite Challenge, and the race for the top 3 is tight!')
  })

  it('sends nothing outside the contest, and only for the cron or the admin', async () => {
    const t = await players()
    t.setClock(AFTER)
    expect((await push(t, 'night')).body).toEqual({ sent: 0, skipped: 'not-now' })
    t.setClock(NIGHT)
    expect((await push(t, 'night', 'wrong')).status).toBe(401)
    expect((await t.call('push', { query: '?kind=night' })).status).toBe(401)
    expect((await push(t, 'night', 'admin-pass')).body).toEqual({ sent: 2, failed: 0 })
    expect((await push(t, 'nope')).status).toBe(400)
  })
})

describe('ending and winners', () => {
  async function finished() {
    const t = setup()
    const players = []
    for (const [i, name] of ['first', 'second', 'third', 'fourth'].entries()) {
      const player = await t.join(i + 1, name)
      players.push(player)
      for (let n = 0; n < 4 - i; n += 1) await t.refer(player.code, `${i}-${n}`, { ip: `10.${i}.0.${n}` })
    }
    t.setClock(AFTER)
    return { t, players }
  }

  it('waits for the end, then confirms in order, messages winners and the admin', async () => {
    const { t } = await finished()
    t.setClock(DURING)
    expect((await t.admin('admin-confirm', { place: 1 })).status).toBe(409)
    t.setClock(AFTER)
    expect((await t.admin('admin-confirm', { place: 2 })).body).toEqual({ error: 'confirm-in-order' })
    for (const place of [1, 2, 3]) expect((await t.admin('admin-confirm', { place })).status).toBe(200)
    expect(t.telegram.map((m) => m.chat_id)).toEqual([1, 2, 3, '999'])
    expect(t.telegram[0].text).toMatch(/^🎉 Congrats! You placed 1st and won ₦30,000 .* Claim within 48h: https:\/\/www\.naijatr\.com\/challenge\/claim\?t=/)
    expect(t.telegram[3].text).toContain('🥉 @third: ₦10,000')
    expect((await t.call('contest')).body.winners).toEqual(['@first', '@second', '@third'])
    t.setClock(AFTER + 4 * 24 * HOUR)
    expect((await t.call('contest')).body.winners).toBeNull()
  })

  it('disqualifying moves the next person up', async () => {
    const { t } = await finished()
    expect((await t.admin('admin-dq', { id: 1 })).status).toBe(200)
    await t.admin('admin-confirm', { place: 1 })
    expect(t.telegram[0]).toMatchObject({ chat_id: 2 })
    // A confirmed winner can't be disqualified afterwards.
    expect((await t.admin('admin-dq', { id: 2 })).body).toEqual({ error: 'already-confirmed' })
    const { body } = await t.call('leaderboard')
    expect((body.top as { name: string }[]).map((r) => r.name)).toEqual(['@second', '@third', '@fourth'])
  })

  it('sends one player a Telegram message from the admin page', async () => {
    const t = setup()
    await t.join(1, 'bruno')
    expect((await t.admin('admin-message', { id: 1, text: ' You can do this! ' })).body).toEqual({ sent: true })
    expect(t.telegram).toEqual([expect.objectContaining({ chat_id: 1, text: 'You can do this!' })])
    expect((await t.admin('admin-message', { id: 9, text: 'Hi' })).status).toBe(404)
    expect((await t.admin('admin-message', { id: 1, text: '' })).status).toBe(400)
    expect((await t.call('admin-message', { body: { id: 1, text: 'Hi' }, token: 'wrong' })).status).toBe(401)
  })

  it('keeps the admin page behind the password', async () => {
    const { t } = await finished()
    expect((await t.call('admin')).status).toBe(401)
    expect((await t.call('admin', { token: 'wrong' })).status).toBe(401)
    expect((await t.admin('admin')).status).toBe(200)
  })
})

describe('claims', () => {
  async function won() {
    const t = setup()
    const winner = await t.join(1, 'winner')
    const other = await t.join(2, 'other')
    await t.refer(winner.code, 1)
    t.setClock(AFTER)
    await t.admin('admin-confirm', { place: 1 })
    const link = t.telegram[0].text.match(/t=([A-Za-z0-9_-]+)/)![1]
    return { t, winner, other, link }
  }
  const details = { accountName: 'Bruno Ade', provider: 'GTBank', accountNumber: '0123456789', phone: '+234 801 234 5678' }

  it('opens only for the winner it was made for, while signed in', async () => {
    const { t, winner, other, link } = await won()
    expect((await t.call('claim', { query: `?t=${link}` })).status).toBe(401)
    expect((await t.call('claim', { query: `?t=${link}`, token: other.token })).status).toBe(404)
    expect((await t.call('claim', { body: { t: link, ...details }, token: other.token })).status).toBe(404)
    expect((await t.call('claim', { query: `?t=${link}`, token: winner.token })).body).toEqual({ place: '1st', amount: 30000 })
  })

  it('expires after 48 hours', async () => {
    const { t, winner, link } = await won()
    t.setClock(AFTER + 49 * HOUR)
    expect((await t.call('claim', { query: `?t=${link}`, token: winner.token })).status).toBe(404)
  })

  it('stores the details encrypted, works once, and Mark as paid deletes them', async () => {
    const { t, winner, link } = await won()
    expect((await t.call('claim', { body: { t: link, ...details, accountNumber: '12ab' }, token: winner.token })).status).toBe(400)
    expect((await t.call('claim', { body: { t: link, ...details }, token: winner.token })).status).toBe(200)
    // One time only.
    expect((await t.call('claim', { body: { t: link, ...details }, token: winner.token })).status).toBe(404)
    const stored = JSON.stringify([...t.store.strings])
    expect(stored).not.toContain('0123456789')
    expect(stored).not.toContain('GTBank')
    // Never sent over Telegram.
    expect(JSON.stringify(t.telegram)).not.toContain('0123456789')
    const view = (await t.admin('admin')).body as { confirmed: { claim: { accountNumber: string } | null; paid: boolean }[] }
    expect(view.confirmed[0].claim?.accountNumber).toBe('0123456789')
    expect((await t.admin('admin-paid', { id: 1 })).status).toBe(200)
    const after = (await t.admin('admin')).body as typeof view
    expect(after.confirmed[0]).toMatchObject({ claim: null, paid: true })
    expect([...t.store.strings.keys()].some((key) => key.includes(':claim:'))).toBe(false)
  })

  it('cannot be read without the key', () => {
    const sealed = encrypt('right', 'secret')
    expect(decrypt('right', sealed)).toBe('secret')
    expect(decrypt('wrong', sealed)).toBeNull()
  })
})
