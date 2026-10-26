import { describe, expect, it, vi } from 'vitest'
import {
  createMovieboxDownloads,
  looseTitle,
  matchSubject,
  normalizeTitle,
  parseDownloads,
  subjectToEntry,
  type IndexEntry,
  type KeyValueStore,
  type WantedTitle,
} from './moviebox'

const entry = (id: string, title: string, year: number | null, type: IndexEntry['type'] = 'movie', extra: Partial<IndexEntry> = {}): IndexEntry => ({
  id,
  title,
  year,
  type,
  runtime: null,
  country: '',
  ...extra,
})

const want = (title: string, year: number | null, type: WantedTitle['type'] = 'movie', extra: Partial<WantedTitle> = {}): WantedTitle => ({
  title,
  originalTitle: '',
  year,
  type,
  runtime: null,
  countries: [],
  ...extra,
})

const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, get: async (key) => data.get(key) ?? null, set: async (key, value) => void data.set(key, value) }
}

const fakeResponse = () => {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: () => undefined,
    end: (body: string) => void (res.body = body),
  }
  return res
}

describe('MovieBox titles', () => {
  it('normalizes punctuation, apostrophes, accents and spaces', () => {
    expect(normalizeTitle('  Ocean’s   Eleven! ')).toBe('oceans eleven')
    expect(normalizeTitle("Amélie: Le Fabuleux")).toBe('amelie le fabuleux')
    expect(normalizeTitle('Fast & Furious')).toBe('fast and furious')
    expect(looseTitle('Squid Game S2 [Hindi]')).toBe('squid game')
    expect(looseTitle('Dune (2021)')).toBe('dune')
  })

  it('reads a subject from the Worker', () => {
    expect(
      subjectToEntry({ subjectId: '123', subjectType: 1, title: 'Dune', releaseDate: '2021-09-15', runtime: 9300, country: 'United States' }),
    ).toEqual({ id: '123', title: 'Dune', year: 2021, type: 'movie', runtime: 155, country: 'United States' })
    expect(subjectToEntry({ subjectId: '9', subjectType: 2, title: 'Dark' })?.type).toBe('series')
  })
})

describe('matchSubject', () => {
  const index = [
    entry('a', 'Dune', 2021),
    entry('b', 'Dune', 1984),
    entry('c', 'Dune: Part Two', 2024),
    entry('d', 'Dark', 2017, 'series'),
    entry('e', 'Dark', 2017, 'movie'),
  ]

  it('prefers the exact title, year and type', () => {
    expect(matchSubject(want('Dune', 2021), index)).toEqual({ id: 'a' })
    expect(matchSubject(want('Dune', 1984), index)).toEqual({ id: 'b' })
    expect(matchSubject(want('Dark', 2017, 'series'), index)).toEqual({ id: 'd' })
  })

  it('does not guess between remakes or near titles', () => {
    expect(matchSubject(want('Dune', null), index)).toEqual({ ambiguous: true })
    expect(matchSubject(want('Dune', 2000), index)).toBeNull()
    expect(matchSubject(want('Dune Part', 2024), index)).toBeNull()
  })

  it('tells same-titled candidates apart by runtime or country', () => {
    const twins = [entry('x', 'Home', 2015, 'movie', { runtime: 94 }), entry('y', 'Home', 2015, 'movie', { runtime: 120, country: 'India' })]
    expect(matchSubject(want('Home', 2015, 'movie', { runtime: 95 }), twins)).toEqual({ id: 'x' })
    expect(matchSubject(want('Home', 2015, 'movie', { countries: ['IN'] }), twins)).toEqual({ id: 'y' })
    expect(matchSubject(want('Home', 2015), twins)).toEqual({ ambiguous: true })
  })

  it('uses the original title, then a single loose match', () => {
    expect(matchSubject(want('Spirited Away', 2001, 'movie', { originalTitle: 'Sen to Chihiro no Kamikakushi' }), [entry('s', 'Sen to Chihiro no Kamikakushi', 2001)])).toEqual({ id: 's' })
    expect(matchSubject(want('Squid Game', 2021, 'series'), [entry('q', 'Squid Game [Hindi]', 2021, 'series')])).toEqual({ id: 'q' })
    expect(matchSubject(want('Squid Game', 2021, 'series'), [entry('q', 'Squid Game [Hindi]', 2021, 'series'), entry('r', 'Squid Game S2', 2024, 'series')])).toEqual({ ambiguous: true })
  })
})

describe('parseDownloads', () => {
  const movie = {
    downloads: [
      { url: 'https://cdn.example/m480.mp4', resolution: 480, size: '545259520' },
      { url: 'https://cdn.example/m1080.mp4', resolution: 1080, size: 1932735283 },
    ],
    captions: [{ url: 'https://cdn.example/en.srt', lan: 'en' }],
  }

  it('lists the files best first, with sizes, and leaves out captions', () => {
    expect(parseDownloads(movie, null, null)).toEqual([
      { quality: '1080p', size: '1.8 GB', filename: null, language: null, url: 'https://cdn.example/m1080.mp4' },
      { quality: '480p', size: '520 MB', filename: null, language: null, url: 'https://cdn.example/m480.mp4' },
    ])
    expect(parseDownloads({ message: 'No downloads available' }, null, null)).toEqual([])
  })

  it('only gives an episode the files tied to it', () => {
    const tagged = { files: [{ url: 'https://cdn.example/1', se: 1, ep: 1 }, { url: 'https://cdn.example/2', se: 1, ep: 2 }] }
    expect(parseDownloads(tagged, 1, 2).map((f) => f.url)).toEqual(['https://cdn.example/2'])
    expect(parseDownloads({ files: [{ url: 'https://cdn.example/Show.S02E05.mkv' }] }, 2, 5)).toHaveLength(1)
    expect(parseDownloads({ se: 1, ep: 3, downloads: [{ url: 'https://cdn.example/x' }] }, 1, 3)).toHaveLength(1)
    // Nothing says which episode these are: no guessing.
    expect(parseDownloads(movie, 1, 3)).toEqual([])
  })
})

describe('createMovieboxDownloads', () => {
  const config = { workerUrl: 'https://worker.example', secret: 's3cret', redis: { redisUrl: '', redisToken: '' } }
  const worker = () =>
    vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.['X-Worker-Secret']).toBe('s3cret')
      const path = url.replace(config.workerUrl, '')
      if (path === '/home/rows') return Response.json({ data: { rows: [{ opId: 'trend' }] } })
      if (path.startsWith('/home/subjects')) {
        return Response.json({ data: { items: [{ subjectId: '77', subjectType: 1, title: 'Dune', releaseDate: '2021-09-15' }] } })
      }
      if (path === '/download/77') return Response.json({ downloads: [{ url: 'https://cdn.example/d.mp4', resolution: 720 }] })
      return new Response('nope', { status: 404 })
    })
  const query = (title: string, year: string) => new URLSearchParams({ movieId: '438631', title, year, type: 'movie' })

  it('resolves through the index once, then uses the saved match', async () => {
    const fetchImpl = worker()
    const store = memoryStore()
    const service = createMovieboxDownloads(config, fetchImpl as never, store)
    const res = fakeResponse()
    await service.handle(query('Dune', '2021'), res as never)
    expect(JSON.parse(res.body)).toEqual({
      available: true,
      label: null,
      options: [{ quality: '720p', size: null, filename: null, language: null, url: 'https://cdn.example/d.mp4' }],
    })
    expect(store.data.get('moviebox:map:v1:movie:438631')).toBe('77')

    fetchImpl.mockClear()
    await service.handle(query('Dune', '2021'), fakeResponse() as never)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://worker.example/download/77'])
  })

  it('remembers a title with no match', async () => {
    const fetchImpl = worker()
    const service = createMovieboxDownloads(config, fetchImpl as never, memoryStore())
    const res = fakeResponse()
    await service.handle(new URLSearchParams({ movieId: '1', title: 'Unknown', type: 'movie' }), res as never)
    expect(JSON.parse(res.body)).toEqual({ available: false, reason: 'no-match' })
    fetchImpl.mockClear()
    await service.handle(new URLSearchParams({ movieId: '1', title: 'Unknown', type: 'movie' }), fakeResponse() as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('answers 502 without Worker details when the Worker fails', async () => {
    const service = createMovieboxDownloads(config, (async () => new Response('boom', { status: 500 })) as never, memoryStore())
    const res = fakeResponse()
    await service.handle(query('Dune', '2021'), res as never)
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toEqual({ available: false, reason: 'error' })
  })

  it('refuses a series request without an episode', async () => {
    const service = createMovieboxDownloads(config, worker() as never, memoryStore())
    const res = fakeResponse()
    await service.handle(new URLSearchParams({ movieId: '1399', title: 'Dark', type: 'series' }), res as never)
    expect(res.statusCode).toBe(400)
  })
})
