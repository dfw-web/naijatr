import {
  ANIMATION_GENRE_NAME,
  CATEGORIES,
  GENRES,
  INDUSTRIES,
  MIN_VOTES_FOR_RATING,
  RUNTIMES,
  type DiscoverFilters,
  type DiscoverSort,
} from '../config/discoverFilters'
import type { MediaItem } from '../types/media'

/**
 * Pure helpers that turn Browse filters into TMDB /discover parameters, or
 * into a client-side check for /search results (which ignore those filters).
 */

export type Endpoint = 'movie' | 'tv'

export interface TmdbGenre {
  id: number
  name: string
}

export interface GenreLists {
  movie: TmdbGenre[]
  tv: TmdbGenre[]
}

/** The list-result fields the client-side filter reads. */
export interface FilterableResult {
  genre_ids?: number[]
  origin_country?: string[]
  original_language?: string
  release_date?: string
  first_air_date?: string
  vote_average?: number
  vote_count?: number
}

export interface EndpointPlan {
  /** Query params, without `page`. */
  params: Record<string, string>
  /** Results must also pass this; undefined when TMDB did all the filtering. */
  keep?: (result: FilterableResult) => boolean
}

/** TV news, reality and talk shows, which otherwise dominate TV popularity charts. */
const TV_EXCLUDED_GENRES = '10763,10764,10767'

const SORT_PARAM: Record<Endpoint, Record<DiscoverSort, string>> = {
  movie: {
    popular: 'popularity.desc',
    top: 'vote_average.desc',
    newest: 'primary_release_date.desc',
    oldest: 'primary_release_date.asc',
  },
  tv: {
    popular: 'popularity.desc',
    top: 'vote_average.desc',
    newest: 'first_air_date.desc',
    oldest: 'first_air_date.asc',
  },
}

const idFor = (list: TmdbGenre[], name: string | null) =>
  name === null ? undefined : list.find((g) => g.name.toLowerCase() === name.toLowerCase())?.id

interface GenrePlan {
  /** IDs for the chips that exist on this endpoint (deduplicated). */
  ids: number[]
  /** True when genres were chosen but none exist on this endpoint: skip the call. */
  impossible: boolean
  animationId: number | null
}

/** Maps genre chips to this endpoint's IDs. Chips with no equivalent (e.g. Horror on TV) are skipped. */
export function planGenres(filters: DiscoverFilters, endpoint: Endpoint, lists: GenreLists): GenrePlan {
  const list = lists[endpoint]
  const ids = [
    ...new Set(
      filters.genres.flatMap((chipId) => {
        const chip = GENRES.find((g) => g.id === chipId)
        const id = chip && idFor(list, endpoint === 'movie' ? chip.movie : chip.tv)
        return id === undefined ? [] : [id]
      }),
    ),
  ]
  return {
    ids,
    impossible: filters.genres.length > 0 && ids.length === 0,
    animationId: idFor(list, ANIMATION_GENRE_NAME) ?? null,
  }
}

const selectedIndustries = (filters: DiscoverFilters) =>
  INDUSTRIES.filter((i) => filters.industries.includes(i.id))

/**
 * The `with_original_language` value. Anime forces Japanese. Otherwise an
 * industry's language (Bollywood = Hindi) only applies when every chosen
 * industry has one, or e.g. Hollywood + Bollywood would lose Hollywood.
 */
export function languageParam(filters: DiscoverFilters): string[] {
  if (filters.categories.includes('anime')) return ['ja']
  const industries = selectedIndustries(filters)
  if (industries.length === 0 || industries.some((i) => !i.language)) return []
  return [...new Set(industries.map((i) => i.language!))]
}

export const isoDate = (date: Date) => date.toISOString().slice(0, 10)

/** /discover parameters for one endpoint, or null when it can't match anything (skip the call). */
export function planDiscover(
  filters: DiscoverFilters,
  endpoint: Endpoint,
  lists: GenreLists,
  keywordIds: number[],
  today: string,
): EndpointPlan | null {
  const genres = planGenres(filters, endpoint, lists)
  if (genres.impossible) return null
  const keywordCategories = filters.categories.filter((id) => id !== 'anime')
  if (keywordCategories.length > 0 && keywordIds.length === 0) return null

  const params: Record<string, string> = {
    include_adult: 'false',
    sort_by: SORT_PARAM[endpoint][filters.sort],
  }
  if (endpoint === 'tv') params.without_genres = TV_EXCLUDED_GENRES

  const anime = filters.categories.includes('anime')
  let keep: EndpointPlan['keep']
  if (filters.genreMatch === 'all' || genres.ids.length <= 1) {
    const ids = anime && genres.animationId !== null ? [...new Set([...genres.ids, genres.animationId])] : genres.ids
    if (ids.length) params.with_genres = ids.join(',')
  } else {
    params.with_genres = genres.ids.join('|')
    // TMDB can't express "Animation AND (A OR B)", so check Animation here.
    if (anime && genres.animationId !== null) {
      const animationId = genres.animationId
      keep = (r) => (r.genre_ids ?? []).includes(animationId)
    }
  }

  const countries = selectedIndustries(filters).flatMap((i) => i.countries)
  if (countries.length) params.with_origin_country = countries.join('|')
  const languages = languageParam(filters)
  if (languages.length) params.with_original_language = languages.join('|')
  if (keywordIds.length) params.with_keywords = keywordIds.join('|')

  const dateField = endpoint === 'movie' ? 'primary_release_date' : 'first_air_date'
  if (filters.yearFrom !== null) params[`${dateField}.gte`] = `${filters.yearFrom}-01-01`
  else if (filters.sort === 'oldest') params[`${dateField}.gte`] = '1900-01-01' // skip undated titles
  if (filters.yearTo !== null) params[`${dateField}.lte`] = `${filters.yearTo}-12-31`
  else if (filters.sort === 'newest') params[`${dateField}.lte`] = today // skip unreleased titles

  if (filters.minRating > 0) params['vote_average.gte'] = String(filters.minRating)
  if (filters.minRating > 0 || filters.sort === 'top') {
    params['vote_count.gte'] = String(MIN_VOTES_FOR_RATING)
  }

  const runtime = RUNTIMES.find((r) => r.id === filters.runtime)
  if (endpoint === 'movie' && runtime) {
    if (runtime.gte !== undefined) params['with_runtime.gte'] = String(runtime.gte)
    if (runtime.lte !== undefined) params['with_runtime.lte'] = String(runtime.lte)
  }

  return { params, keep }
}

/**
 * /search parameters plus a client-side check for the filters /search
 * ignores: genres, industry, language, year and rating. Keyword categories
 * and runtime aren't in list results, so they can't apply to text search.
 */
export function planSearch(
  filters: DiscoverFilters,
  endpoint: Endpoint,
  lists: GenreLists,
  query: string,
): EndpointPlan | null {
  const genres = planGenres(filters, endpoint, lists)
  if (genres.impossible) return null
  const anime = filters.categories.includes('anime')
  const industries = selectedIndustries(filters)
  const countries = new Set(industries.flatMap((i) => i.countries))
  const fallbackLanguages = new Set(industries.flatMap((i) => i.languages))
  const languages = languageParam(filters)

  const keep = (r: FilterableResult) => {
    const ids = r.genre_ids ?? []
    if (genres.ids.length) {
      const match = filters.genreMatch === 'all' ? genres.ids.every((id) => ids.includes(id)) : genres.ids.some((id) => ids.includes(id))
      if (!match) return false
    }
    if (anime && (genres.animationId === null || !ids.includes(genres.animationId))) return false
    if (languages.length && !languages.includes(r.original_language ?? '')) return false
    if (countries.size) {
      const origin = r.origin_country ?? []
      const fromCountry = origin.length
        ? origin.some((c) => countries.has(c))
        : fallbackLanguages.has(r.original_language ?? '')
      if (!fromCountry) return false
    }
    const date = (endpoint === 'movie' ? r.release_date : r.first_air_date) || ''
    const year = date ? Number(date.slice(0, 4)) : null
    if (filters.yearFrom !== null && (year === null || year < filters.yearFrom)) return false
    if (filters.yearTo !== null && (year === null || year > filters.yearTo)) return false
    if (
      filters.minRating > 0 &&
      ((r.vote_average ?? 0) < filters.minRating || (r.vote_count ?? 0) < MIN_VOTES_FOR_RATING)
    ) {
      return false
    }
    return true
  }

  return { params: { query, include_adult: 'false' }, keep }
}

/** Keyword names to look up for the chosen categories. */
export const keywordNames = (filters: DiscoverFilters) =>
  CATEGORIES.filter((c) => c.keyword && filters.categories.includes(c.id)).map((c) => c.keyword!)

/** Best keyword match from /search/keyword: an exact name, else TMDB's top hit. */
export function pickKeyword(results: TmdbGenre[], name: string): number | null {
  const exact = results.find((k) => k.name.trim().toLowerCase() === name.toLowerCase())
  return (exact ?? results[0])?.id ?? null
}

/** Orders merged movie + series results the way the chosen sort would. */
export function sortMerged(items: MediaItem[], sort: DiscoverSort): MediaItem[] {
  const date = (item: MediaItem) => item.releaseDate ?? ''
  const sorted = [...items]
  switch (sort) {
    case 'popular':
      return sorted.sort((a, b) => b.popularity - a.popularity)
    case 'top':
      return sorted.sort((a, b) => b.score - a.score || b.voteCount - a.voteCount)
    case 'newest':
      return sorted.sort((a, b) => date(b).localeCompare(date(a)))
    case 'oldest':
      return sorted.sort((a, b) => (date(a) || '9999').localeCompare(date(b) || '9999'))
  }
}
