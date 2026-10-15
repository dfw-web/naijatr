import { describe, expect, it, vi } from 'vitest'
import { matchesQuery, sortItems } from '../utils/media'
import type { CatalogProvider } from '../types/media'
import { createFallbackProvider } from './fallbackProvider'
import { createLocalProvider } from './localProvider'
import { sampleItems } from './sampleData'
import {
  CatalogRequestError,
  createTmdbProvider,
  mapTmdbResult,
  mergeTmdbDetails,
  pickTrailer,
  pickWatchProviders,
} from './tmdbProvider'

describe('sample data', () => {
  it('has unique ids and both content types', () => {
    const ids = sampleItems.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(sampleItems.some((item) => item.type === 'movie')).toBe(true)
    expect(sampleItems.some((item) => item.type === 'series')).toBe(true)
  })
})

describe('matchesQuery', () => {
  const velvet = sampleItems.find((item) => item.id === 'velvet-hour')!

  it('matches title, genre, year, type and certification, case-insensitively', () => {
    expect(matchesQuery(velvet, 'VELVET')).toBe(true)
    expect(matchesQuery(velvet, 'thriller')).toBe(true)
    expect(matchesQuery(velvet, '2024')).toBe(true)
    expect(matchesQuery(velvet, 'movie mystery')).toBe(true)
    expect(matchesQuery(velvet, 'r')).toBe(true)
  })

  it('requires every word to match', () => {
    expect(matchesQuery(velvet, 'velvet comedy')).toBe(false)
  })
})

describe('sortItems', () => {
  it('sorts by rating with unrated titles last, without mutating the input', () => {
    const input = [...sampleItems]
    const sorted = sortItems(input, 'rating')
    expect(sorted[sorted.length - 1].voteCount).toBe(0)
    expect(sorted[0].score).toBeGreaterThanOrEqual(sorted[1].score)
    expect(input).toEqual(sampleItems)
  })
})

describe('local provider', () => {
  const provider = createLocalProvider({ latencyMs: 0 })

  it('builds the four homepage sections', async () => {
    const home = await provider.getHome()
    expect(home.sections.map((s) => s.title)).toEqual([
      'Trending Now',
      'Popular Movies',
      'Popular Series',
      'New & Recent',
    ])
    const [, movies, series, recent] = home.sections
    expect(movies.items.every((item) => item.type === 'movie')).toBe(true)
    expect(series.items.every((item) => item.type === 'series')).toBe(true)
    const dates = recent.items.map((item) => item.releaseDate!)
    expect(dates).toEqual([...dates].sort().reverse())
    expect(home.featured?.backdrop).toBeTruthy()
  })

  it('returns only the requested type', async () => {
    const series = await provider.getByType('series')
    expect(series.length).toBeGreaterThan(0)
    expect(series.every((item) => item.type === 'series')).toBe(true)
  })

  it('rejects when aborted', async () => {
    const slow = createLocalProvider({ latencyMs: 1000 })
    const controller = new AbortController()
    const promise = slow.getHome(controller.signal)
    controller.abort()
    await expect(promise).rejects.toBeDefined()
  })
})

describe('TMDB provider', () => {
  const genres = new Map([
    [28, 'Action'],
    [18, 'Drama'],
  ])

  it('maps movie and tv results, building image URLs and skipping people/adult titles', () => {
    const movie = mapTmdbResult(
      {
        id: 7,
        media_type: 'movie',
        title: 'Example',
        release_date: '2024-05-01',
        genre_ids: [28, 999],
        overview: 'Plot.',
        poster_path: '/p.jpg',
        backdrop_path: null,
        vote_average: 7.456,
        vote_count: 1200,
        popularity: 50,
      },
      'movie',
      genres,
    )
    expect(movie).toMatchObject({
      id: 'tmdb-movie-7',
      type: 'movie',
      year: 2024,
      genres: ['Action'],
      score: 7.5,
      poster: 'https://image.tmdb.org/t/p/w500/p.jpg',
      backdrop: null,
    })

    const show = mapTmdbResult({ id: 8, name: 'Show', first_air_date: '' }, 'series', genres)
    expect(show).toMatchObject({ type: 'series', title: 'Show', year: null, releaseDate: null })

    expect(mapTmdbResult({ id: 9, media_type: 'person' }, 'movie', genres)).toBeNull()
    expect(mapTmdbResult({ id: 10, adult: true }, 'movie', genres)).toBeNull()
  })

  it('only calls the same-origin proxy, never with a key in the URL', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url)
      const body = path.includes('/genre/')
        ? { genres: [{ id: 18, name: 'Drama' }] }
        : { results: [{ id: 1, media_type: 'tv', name: 'A Show', genre_ids: [18] }] }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const provider = createTmdbProvider(fetchMock as unknown as typeof fetch)

    const results = await provider.search('show')
    expect(results[0]).toMatchObject({ title: 'A Show', type: 'series', genres: ['Drama'] })

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.every((url) => url.startsWith('/api/tmdb/'))).toBe(true)
    expect(urls.some((url) => /api_key|token/i.test(url))).toBe(false)
    expect(urls.some((url) => url.startsWith('/api/tmdb/search/multi?'))).toBe(true)
  })

  it('does not let a cancelled request poison the shared genre cache', async () => {
    // Mirrors React StrictMode: start a request, abort it, immediately start another.
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await Promise.resolve()
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Response('{}', { status: 401 })
    })
    const provider = createTmdbProvider(fetchMock as unknown as typeof fetch)

    const controller = new AbortController()
    const first = provider.getHome(controller.signal).catch(() => 'aborted')
    controller.abort()
    const error = await provider.getHome().catch((e: unknown) => e)

    await first
    expect(error).toBeInstanceOf(CatalogRequestError)
    expect((error as Error).message).toMatch(/credentials were rejected/)
  })

  it('turns a 401 into a readable error', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }))
    const provider = createTmdbProvider(fetchMock as unknown as typeof fetch)

    const error = await provider.getHome().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CatalogRequestError)
    expect((error as Error).message).toMatch(/credentials were rejected/)
  })
})

describe('TMDB details', () => {
  const base = {
    id: 'tmdb-movie-1',
    tmdbId: 1,
    title: 'Example',
    type: 'movie' as const,
    year: 2024,
    releaseDate: '2024-01-01',
    genres: ['Action'],
    score: 7,
    voteCount: 10,
    popularity: 1,
    description: 'x',
    poster: null,
    backdrop: null,
  }

  it('merges runtime, certification, director, cast and tagline for movies', () => {
    const merged = mergeTmdbDetails(base, {
      runtime: 125,
      tagline: ' Hold on. ',
      status: 'Released',
      genres: [{ id: 1, name: 'Action' }, { id: 2, name: 'Thriller' }],
      credits: {
        cast: [
          { name: 'B', order: 1 },
          { name: 'A', order: 0 },
        ],
        crew: [
          { name: 'D', job: 'Director' },
          { name: 'W', job: 'Writer' },
        ],
      },
      release_dates: {
        results: [
          { iso_3166_1: 'FR', release_dates: [{ certification: '12' }] },
          { iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'PG-13' }] },
        ],
      },
    })
    expect(merged).toMatchObject({
      length: '2h 05m',
      certification: 'PG-13',
      tagline: 'Hold on.',
      status: 'Released',
      makers: ['D'],
      cast: ['A', 'B'],
      genres: ['Action', 'Thriller'],
    })
  })

  it('merges seasons, rating and creators for series', () => {
    const merged = mergeTmdbDetails(
      { ...base, type: 'series' },
      {
        number_of_seasons: 1,
        created_by: [{ name: 'C' }],
        content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
      },
    )
    expect(merged).toMatchObject({ length: '1 Season', certification: 'TV-MA', makers: ['C'] })
  })

  it('requests details from the right endpoint and skips non-TMDB items', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify({ runtime: 90 }), { status: 200 }),
    )
    const provider = createTmdbProvider(fetchMock as unknown as typeof fetch)

    const detailed = await provider.getDetails(base)
    expect(detailed.length).toBe('1h 30m')
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /^\/api\/tmdb\/movie\/1\?.*append_to_response=credits%2Crelease_dates/,
    )

    const local = sampleItems[0]
    expect(await provider.getDetails(local)).toBe(local)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('TMDB trailers and watch providers', () => {
  const base = mapTmdbResult({ id: 1, title: 'Film' }, 'movie', new Map())!

  it('picks the official YouTube trailer before a teaser and ignores the rest', () => {
    expect(
      pickTrailer([
        { key: 'aaaaaaaaaaa', site: 'Vimeo', type: 'Trailer', official: true },
        { key: 'bbbbbbbbbbb', site: 'YouTube', type: 'Trailer', official: false },
        { key: 'ccccccccccc', site: 'YouTube', type: 'Teaser', official: true, name: 'Teaser' },
        { key: 'ddddddddddd', site: 'YouTube', type: 'Featurette', official: true },
        { key: 'eeeeeeeeeee', site: 'YouTube', type: 'Trailer', official: true, name: 'Trailer 2' },
      ]),
    ).toEqual({ key: 'eeeeeeeeeee', name: 'Trailer 2' })
    expect(
      pickTrailer([{ key: 'ccccccccccc', site: 'YouTube', type: 'Teaser', official: true }]),
    ).toEqual({ key: 'ccccccccccc', name: 'Trailer' })
    expect(
      pickTrailer([{ key: 'bad id', site: 'YouTube', type: 'Trailer', official: true }]),
    ).toBeNull()
    expect(pickTrailer()).toBeNull()
  })

  it('uses Nigeria providers, falling back to the US', () => {
    const netflix = { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg' }
    const ng = pickWatchProviders({
      NG: { link: 'https://tmdb.example/ng', flatrate: [netflix] },
      US: { buy: [netflix] },
    })
    expect(ng).toMatchObject({ region: 'NG', link: 'https://tmdb.example/ng', buy: [] })
    expect(ng?.stream[0]).toEqual({
      id: 8,
      name: 'Netflix',
      logo: 'https://image.tmdb.org/t/p/w92/n.jpg',
    })
    expect(pickWatchProviders({ NG: {}, US: { rent: [netflix] } })?.region).toBe('US')
    expect(pickWatchProviders({ GB: { buy: [netflix] } })).toBeNull()
  })

  it('requests videos and providers with details and merges them', async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            videos: {
              results: [{ key: 'SUXWAEX2jlg', site: 'YouTube', type: 'Trailer', official: true }],
            },
            'watch/providers': { results: {} },
            poster_path: '/p.jpg',
          }),
        ),
    )
    const detailed = await createTmdbProvider(fetchMock as unknown as typeof fetch).getDetails(base)
    expect(String(fetchMock.mock.calls[0][0])).toContain('videos%2Cwatch%2Fproviders')
    expect(detailed.trailer?.key).toBe('SUXWAEX2jlg')
    expect(detailed.watchProviders).toBeNull()
    expect(detailed.poster).toBe('https://image.tmdb.org/t/p/w500/p.jpg')
  })
})

describe('fallback provider', () => {
  const local = createLocalProvider({ latencyMs: 0 })
  const failing: CatalogProvider = {
    name: 'TMDB',
    getHome: async () => {
      throw new Error('TMDB request failed (503).')
    },
    getByType: async () => {
      throw new Error('down')
    },
    search: async () => {
      throw new Error('down')
    },
    discover: async () => {
      throw new Error('down')
    },
    getDetails: async (item) => item,
  }

  it('serves the fallback and reports why when the primary fails', async () => {
    const provider = createFallbackProvider(failing, local)
    const listener = vi.fn()
    provider.fallback!.subscribe(listener)

    const home = await provider.getHome()
    expect(home.sections[0].items.length).toBeGreaterThan(0)
    expect(provider.fallback!.getStatus()).toEqual({
      active: true,
      reason: 'TMDB request failed (503).',
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clears the status once the primary recovers', async () => {
    let up = false
    const flaky: CatalogProvider = {
      ...failing,
      getHome: (signal) => (up ? local.getHome(signal) : failing.getHome(signal)),
    }
    const provider = createFallbackProvider(flaky, local)
    await provider.getHome()
    expect(provider.fallback!.getStatus().active).toBe(true)
    up = true
    await provider.getHome()
    expect(provider.fallback!.getStatus().active).toBe(false)
  })

  it('does not fall back for cancelled requests', async () => {
    const provider = createFallbackProvider(failing, local)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.getHome(controller.signal)).rejects.toThrow()
    expect(provider.fallback!.getStatus().active).toBe(false)
  })
})
