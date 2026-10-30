import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  buildSearchIndex,
  createMemoryIndexStore,
  handleSearchIndex,
  INDEX_FRESH_MS,
  INDEX_LISTS,
  MIN_ROWS,
  type IndexRow,
  type SearchIndexSnapshot,
} from './searchIndex'

const credentials = { readToken: 'token', apiKey: '' }

/** TMDB: every list page answers with `perPage` titles, ids unique per list and page. */
function tmdb(perPage = 2) {
  return vi.fn(async (url: string) => {
    const u = new URL(url)
    const page = Number(u.searchParams.get('page'))
    const base = (INDEX_LISTS.findIndex((l) => u.pathname.endsWith(l.path)) + 1) * 1000 + page * 10
    const tv = u.pathname.includes('/tv')
    const results = Array.from({ length: perPage }, (_, i) => ({
      id: base + i,
      ...(tv ? { name: `Show ${base + i}`, first_air_date: '2020-05-01' } : { title: `Film ${base + i}`, release_date: '2019-01-01' }),
      poster_path: '/p.jpg',
      popularity: i + 1,
      vote_average: 7.4,
    }))
    return new Response(JSON.stringify({ results }))
  }) as unknown as typeof fetch
}

function fakeRes() {
  const res = { statusCode: 0, headers: {} as Record<string, string>, body: '' }
  return Object.assign(res, {
    setHeader: (k: string, v: string) => void (res.headers[k] = v),
    end: (b?: string) => void (res.body = b ?? ''),
  }) as unknown as ServerResponse & typeof res
}

const snapshot = (builtAt: number, count = MIN_ROWS): SearchIndexSnapshot => ({
  builtAt,
  rows: Array.from({ length: count }, (_, i): IndexRow => [i + 1, 'm', `Old ${i}`, '', 2000, '', 1, 70]),
})

describe('buildSearchIndex', () => {
  it('asks every list page, with the credentials, and keeps compact rows', async () => {
    const fetchImpl = tmdb()
    const rows = await buildSearchIndex(credentials, fetchImpl)
    const pages = INDEX_LISTS.reduce((sum, l) => sum + l.pages, 0)
    expect(fetchImpl).toHaveBeenCalledTimes(pages)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(url)).toMatch(/^https:\/\/api\.themoviedb\.org\/3\//)
    expect(init.headers.Authorization).toBe('Bearer token')
    const film = rows.find((r) => r[1] === 'm')!
    expect(film).toEqual([expect.any(Number), 'm', expect.stringMatching(/^Film /), '', 2019, '/p.jpg', expect.any(Number), 74])
    expect(rows.some((r) => r[1] === 's' && r[4] === 2020)).toBe(true)
  })

  it('keeps one row per title (the most popular copy), most popular first', async () => {
    const same = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ id: 7, title: 'Seven', popularity: Math.random() * 100 }, { id: 8, title: 'Eight', popularity: 1 }] })),
    ) as unknown as typeof fetch
    const rows = await buildSearchIndex(credentials, same)
    const sevens = rows.filter((r) => r[0] === 7 && r[1] === 'm')
    expect(sevens).toHaveLength(1)
    expect(rows[0][6]).toBeGreaterThanOrEqual(rows[rows.length - 1][6])
  })

  it('skips adult titles, untitled ones and pages that fail', async () => {
    const mixed = vi.fn(async (url: string) =>
      url.includes('top_rated')
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ results: [{ id: 1, title: 'Fine' }, { id: 2, title: 'X', adult: true }, { id: 3 }] })),
    ) as unknown as typeof fetch
    const rows = await buildSearchIndex(credentials, mixed)
    expect(rows.map((r) => r[2])).toEqual(expect.arrayContaining(['Fine']))
    expect(rows.some((r) => r[2] === 'X' || r[0] === 3)).toBe(false)
  })
})

describe('handleSearchIndex', () => {
  const now = 1_800_000_000_000

  it('serves a fresh stored copy without asking TMDB, cached at the CDN', async () => {
    const store = createMemoryIndexStore()
    await store.set(snapshot(now - 1000))
    const fetchImpl = tmdb()
    const res = fakeRes()
    await handleSearchIndex(credentials, store, res, fetchImpl, now)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).rows).toHaveLength(MIN_ROWS)
    expect(res.headers['Cache-Control']).toContain('s-maxage')
  })

  it('rebuilds once a day and stores the new copy', async () => {
    const store = createMemoryIndexStore()
    await store.set(snapshot(now - INDEX_FRESH_MS - 1))
    const res = fakeRes()
    await handleSearchIndex(credentials, store, res, tmdb(), now)
    const body = JSON.parse(res.body) as SearchIndexSnapshot
    expect(body.builtAt).toBe(now)
    expect(body.rows[0][2]).toMatch(/^(Film|Show) /)
    expect((await store.get())!.builtAt).toBe(now)
  })

  it('serves the old copy when TMDB fails', async () => {
    const store = createMemoryIndexStore()
    await store.set(snapshot(now - INDEX_FRESH_MS - 1))
    const down = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    const res = fakeRes()
    await handleSearchIndex(credentials, store, res, down, now)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).rows[0][2]).toBe('Old 0')
  })

  it('serves the old copy while another instance rebuilds', async () => {
    const store = { ...createMemoryIndexStore(), lock: async () => false }
    await store.set(snapshot(now - INDEX_FRESH_MS - 1))
    const fetchImpl = tmdb()
    const res = fakeRes()
    await handleSearchIndex(credentials, store, res, fetchImpl, now)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(JSON.parse(res.body).rows[0][2]).toBe('Old 0')
  })

  it('answers 503 with nothing stored and nothing built', async () => {
    const res = fakeRes()
    await handleSearchIndex(credentials, createMemoryIndexStore(), res, tmdb(0), now)
    expect(res.statusCode).toBe(503)
    expect(res.headers['Cache-Control']).toBe('no-store')
  })

  it('answers 503 when TMDB is not configured', async () => {
    const res = fakeRes()
    await handleSearchIndex({ readToken: '', apiKey: '' }, createMemoryIndexStore(), res, tmdb(), now)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).reason).toBe('not-configured')
  })
})
