import { describe, expect, it, vi } from 'vitest'
import {
  activeFilters,
  DEFAULT_FILTERS,
  parseFilters,
  serializeFilters,
  type DiscoverFilters,
} from '../config/discoverFilters'
import { planDiscover, planSearch, type GenreLists } from './tmdbDiscover'
import { createTmdbProvider } from './tmdbProvider'

const LISTS: GenreLists = {
  movie: [
    { id: 28, name: 'Action' },
    { id: 12, name: 'Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 27, name: 'Horror' },
    { id: 10749, name: 'Romance' },
    { id: 878, name: 'Science Fiction' },
  ],
  tv: [
    { id: 10759, name: 'Action & Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 10765, name: 'Sci-Fi & Fantasy' },
  ],
}
const TODAY = '2026-10-15'
const f = (patch: Partial<DiscoverFilters>): DiscoverFilters => ({ ...DEFAULT_FILTERS, ...patch })

describe('planDiscover', () => {
  it('combines industries with | and genres with , (Nollywood + Comedy + Animation)', () => {
    const plan = planDiscover(
      f({ industries: ['nollywood', 'hollywood'], genres: ['comedy', 'animation'] }),
      'movie',
      LISTS,
      [],
      TODAY,
    )!
    expect(plan.params).toMatchObject({
      with_origin_country: 'NG|US',
      with_genres: '35,16',
      include_adult: 'false',
      sort_by: 'popularity.desc',
    })
    expect(plan.params.with_original_language).toBeUndefined()
    expect(plan.keep).toBeUndefined()
  })

  it('uses | when matching any genre', () => {
    const plan = planDiscover(f({ genres: ['comedy', 'romance'], genreMatch: 'any' }), 'movie', LISTS, [], TODAY)!
    expect(plan.params.with_genres).toBe('35|10749')
  })

  it('adds Hindi only when every chosen industry has a language', () => {
    expect(planDiscover(f({ industries: ['bollywood'] }), 'movie', LISTS, [], TODAY)!.params).toMatchObject({
      with_origin_country: 'IN',
      with_original_language: 'hi',
    })
    const mixed = planDiscover(f({ industries: ['bollywood', 'hollywood'] }), 'movie', LISTS, [], TODAY)!
    expect(mixed.params.with_original_language).toBeUndefined()
    expect(planDiscover(f({ industries: ['chinese'] }), 'tv', LISTS, [], TODAY)!.params.with_origin_country).toBe(
      'CN|HK|TW',
    )
  })

  it('maps genres to TV ids, skipping ones TV lacks, and skips TV when none exist', () => {
    const tv = planDiscover(f({ genres: ['action', 'adventure', 'romance'] }), 'tv', LISTS, [], TODAY)!
    expect(tv.params.with_genres).toBe('10759')
    expect(planDiscover(f({ genres: ['horror'] }), 'tv', LISTS, [], TODAY)).toBeNull()
    expect(planDiscover(f({ genres: ['scifi'] }), 'tv', LISTS, [], TODAY)!.params.with_genres).toBe('10765')
  })

  it('treats Anime as Animation + Japanese', () => {
    const plan = planDiscover(f({ categories: ['anime'], genres: ['comedy'] }), 'tv', LISTS, [], TODAY)!
    expect(plan.params).toMatchObject({ with_genres: '35,16', with_original_language: 'ja' })
    // "Any" can't express Animation AND (A OR B) in one param, so Animation is checked locally.
    const any = planDiscover(
      f({ categories: ['anime'], genres: ['comedy', 'action'], genreMatch: 'any' }),
      'movie',
      LISTS,
      [],
      TODAY,
    )!
    expect(any.params.with_genres).toBe('35|28')
    expect(any.keep!({ genre_ids: [35, 16] })).toBe(true)
    expect(any.keep!({ genre_ids: [35] })).toBe(false)
  })

  it('passes keyword ids, and matches nothing when a keyword could not be found', () => {
    const plan = planDiscover(f({ categories: ['zombie', 'superhero'] }), 'movie', LISTS, [12377, 9715], TODAY)!
    expect(plan.params.with_keywords).toBe('12377|9715')
    expect(planDiscover(f({ categories: ['zombie'] }), 'movie', LISTS, [], TODAY)).toBeNull()
  })

  it('applies year, rating (with a vote floor), runtime (movies only) and sort', () => {
    const filters = f({ yearFrom: 2010, yearTo: 2020, minRating: 7, runtime: 'long', sort: 'oldest' })
    expect(planDiscover(filters, 'movie', LISTS, [], TODAY)!.params).toMatchObject({
      'primary_release_date.gte': '2010-01-01',
      'primary_release_date.lte': '2020-12-31',
      'vote_average.gte': '7',
      'vote_count.gte': '50',
      'with_runtime.gte': '151',
      sort_by: 'primary_release_date.asc',
    })
    const tv = planDiscover(filters, 'tv', LISTS, [], TODAY)!.params
    expect(tv).toMatchObject({ 'first_air_date.gte': '2010-01-01', sort_by: 'first_air_date.asc' })
    expect(tv['with_runtime.gte']).toBeUndefined()

    const newest = planDiscover(f({ sort: 'newest' }), 'movie', LISTS, [], TODAY)!.params
    expect(newest['primary_release_date.lte']).toBe(TODAY)
    expect(planDiscover(f({ sort: 'top' }), 'tv', LISTS, [], TODAY)!.params['vote_count.gte']).toBe('50')
  })
})

describe('planSearch', () => {
  it('checks genre, origin country (or language), year and rating client-side', () => {
    const plan = planSearch(
      f({ industries: ['nollywood'], genres: ['comedy'], yearFrom: 2015, minRating: 6 }),
      'movie',
      LISTS,
      'love',
    )!
    expect(plan.params).toEqual({ query: 'love', include_adult: 'false' })
    const ok = { genre_ids: [35], origin_country: ['NG'], release_date: '2019-02-01', vote_average: 6.5, vote_count: 80 }
    expect(plan.keep!(ok)).toBe(true)
    expect(plan.keep!({ ...ok, origin_country: ['US'] })).toBe(false)
    expect(plan.keep!({ ...ok, origin_country: undefined, original_language: 'yo' })).toBe(true)
    expect(plan.keep!({ ...ok, genre_ids: [28] })).toBe(false)
    expect(plan.keep!({ ...ok, release_date: '2010-01-01' })).toBe(false)
    expect(plan.keep!({ ...ok, vote_count: 3 })).toBe(false)
  })
})

describe('filter URL', () => {
  it('round-trips and ignores junk', () => {
    const filters = f({
      type: 'both',
      industries: ['nollywood', 'korean'],
      genres: ['comedy', 'romance'],
      genreMatch: 'any',
      categories: ['anime'],
      yearFrom: 2000,
      yearTo: 2024,
      minRating: 7,
      runtime: 'short',
      sort: 'top',
    })
    const search = serializeFilters(filters)
    expect(search).toContain('industry=nollywood,korean')
    expect(parseFilters(search)).toEqual(filters)
    expect(serializeFilters(DEFAULT_FILTERS)).toBe('')
    expect(parseFilters('?genre=comedy,nope&rating=99&sort=bogus&from=12')).toEqual(
      f({ genres: ['comedy'], minRating: 9 }),
    )
  })

  it('lists active filters as removable chips', () => {
    const filters = f({ industries: ['nollywood'], genres: ['comedy'], yearFrom: 2020, yearTo: 2020 })
    const chips = activeFilters(filters, 'movie')
    expect(chips.map((c) => c.label)).toEqual(['Nollywood', 'Comedy', '2020'])
    expect(chips[0].remove(filters).industries).toEqual([])
  })
})

describe('TMDB discover', () => {
  const page = (results: object[], total = results.length) =>
    new Response(JSON.stringify({ results, total_pages: 3, total_results: total }))

  function mockTmdb() {
    return vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://x')
      const path = url.pathname.replace('/api/tmdb', '')
      if (path === '/genre/movie/list') return new Response(JSON.stringify({ genres: LISTS.movie }))
      if (path === '/genre/tv/list') return new Response(JSON.stringify({ genres: LISTS.tv }))
      if (path === '/search/keyword') {
        return new Response(JSON.stringify({ results: [{ id: 999, name: 'zombie apocalypse' }, { id: 12377, name: 'zombie' }] }))
      }
      if (path === '/discover/movie') return page([{ id: 1, title: 'Film', popularity: 10, genre_ids: [35] }], 41)
      if (path === '/discover/tv') return page([{ id: 2, name: 'Show', popularity: 50, genre_ids: [35] }], 7)
      return new Response('{}', { status: 404 })
    })
  }

  it('merges movies and series by popularity, looks keywords up once, and caches responses', async () => {
    const fetchMock = mockTmdb()
    const provider = createTmdbProvider(fetchMock as unknown as typeof fetch)
    const request = {
      filters: f({ genres: ['comedy'], categories: ['zombie'] }),
      type: 'both' as const,
      query: '',
      page: 1,
    }

    const result = await provider.discover(request)
    expect(result.items.map((i) => i.title)).toEqual(['Show', 'Film'])
    expect(result.totalResults).toBe(48)
    expect(result.totalPages).toBe(3)

    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    const movie = new URL(urls.find((u) => u.startsWith('/api/tmdb/discover/movie'))!, 'http://x')
    expect(movie.searchParams.get('with_keywords')).toBe('12377')
    expect(movie.searchParams.get('with_genres')).toBe('35')
    expect(movie.searchParams.get('include_adult')).toBe('false')
    expect(movie.searchParams.get('page')).toBe('1')

    await provider.discover(request)
    const again = fetchMock.mock.calls.map(([u]) => String(u))
    expect(again.length).toBe(urls.length)
    expect(again.filter((u) => u.startsWith('/api/tmdb/search/keyword'))).toHaveLength(1)
  })

  it('skips the TV call for a movie-only genre', async () => {
    const fetchMock = mockTmdb()
    const provider = createTmdbProvider(fetchMock as unknown as typeof fetch)
    const result = await provider.discover({ filters: f({ genres: ['horror'] }), type: 'both', query: '', page: 1 })
    expect(result.items.map((i) => i.type)).toEqual(['movie'])
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/tmdb/discover/tv'))).toBe(false)
  })
})
