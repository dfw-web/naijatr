import type { MediaType } from '../types/media'

/**
 * Everything the Browse filters can offer lives here, so adding an industry,
 * genre or category is a one-line change. IDs are what appear in the URL.
 */

export interface Industry {
  id: string
  label: string
  /** ISO 3166-1 codes sent as `with_origin_country` (several are ORed). */
  countries: string[]
  /** ISO 639-1 code sent as `with_original_language`, for industries defined by language too. */
  language?: string
  /**
   * Usual original languages, used only to filter text-search results that
   * carry no `origin_country` (TMDB's movie search results often don't).
   */
  languages: string[]
}

export const INDUSTRIES: Industry[] = [
  { id: 'nollywood', label: 'Nollywood', countries: ['NG'], languages: ['en', 'yo', 'ig', 'ha'] },
  { id: 'hollywood', label: 'Hollywood', countries: ['US'], languages: ['en'] },
  { id: 'bollywood', label: 'Bollywood', countries: ['IN'], language: 'hi', languages: ['hi'] },
  { id: 'korean', label: 'Korean', countries: ['KR'], languages: ['ko'] },
  { id: 'chinese', label: 'Chinese', countries: ['CN', 'HK', 'TW'], languages: ['zh', 'cn'] },
  { id: 'japanese', label: 'Japanese', countries: ['JP'], languages: ['ja'] },
  { id: 'filipino', label: 'Filipino', countries: ['PH'], languages: ['tl', 'en'] },
  { id: 'british', label: 'British', countries: ['GB'], languages: ['en'] },
  { id: 'ghanaian', label: 'Ghanaian', countries: ['GH'], languages: ['en', 'ak', 'tw'] },
  { id: 'south-african', label: 'South African', countries: ['ZA'], languages: ['en', 'af', 'zu', 'xh'] },
  { id: 'french', label: 'French', countries: ['FR'], languages: ['fr'] },
  { id: 'spanish', label: 'Spanish', countries: ['ES'], languages: ['es'] },
  { id: 'turkish', label: 'Turkish', countries: ['TR'], languages: ['tr'] },
  { id: 'mexican', label: 'Mexican', countries: ['MX'], languages: ['es'] },
  { id: 'thai', label: 'Thai', countries: ['TH'], languages: ['th'] },
]

export interface GenreChip {
  id: string
  label: string
  /** TMDB genre names; IDs are looked up from /genre/{movie,tv}/list at runtime. null = no such TV genre. */
  movie: string
  tv: string | null
}

export const GENRES: GenreChip[] = [
  { id: 'action', label: 'Action', movie: 'Action', tv: 'Action & Adventure' },
  { id: 'adventure', label: 'Adventure', movie: 'Adventure', tv: 'Action & Adventure' },
  { id: 'comedy', label: 'Comedy', movie: 'Comedy', tv: 'Comedy' },
  { id: 'romance', label: 'Romance', movie: 'Romance', tv: null },
  { id: 'drama', label: 'Drama', movie: 'Drama', tv: 'Drama' },
  { id: 'horror', label: 'Horror', movie: 'Horror', tv: null },
  { id: 'thriller', label: 'Thriller', movie: 'Thriller', tv: null },
  { id: 'crime', label: 'Crime', movie: 'Crime', tv: 'Crime' },
  { id: 'mystery', label: 'Mystery', movie: 'Mystery', tv: 'Mystery' },
  { id: 'fantasy', label: 'Fantasy', movie: 'Fantasy', tv: 'Sci-Fi & Fantasy' },
  { id: 'scifi', label: 'Sci-Fi', movie: 'Science Fiction', tv: 'Sci-Fi & Fantasy' },
  { id: 'animation', label: 'Animation', movie: 'Animation', tv: 'Animation' },
  { id: 'family', label: 'Family', movie: 'Family', tv: 'Family' },
  { id: 'documentary', label: 'Documentary', movie: 'Documentary', tv: 'Documentary' },
  { id: 'war', label: 'War', movie: 'War', tv: 'War & Politics' },
  { id: 'history', label: 'History', movie: 'History', tv: null },
  { id: 'music', label: 'Music', movie: 'Music', tv: null },
  { id: 'western', label: 'Western', movie: 'Western', tv: 'Western' },
]

/** TMDB's Animation genre id is the same for movies and TV. Anime = Animation + Japanese. */
export const ANIMATION_GENRE_NAME = 'Animation'

export interface Category {
  id: string
  label: string
  /** TMDB keyword name, looked up once via /search/keyword. Absent for Anime. */
  keyword?: string
}

export const CATEGORIES: Category[] = [
  { id: 'anime', label: 'Anime' },
  { id: 'paranormal', label: 'Paranormal', keyword: 'paranormal' },
  { id: 'supernatural', label: 'Supernatural', keyword: 'supernatural' },
  { id: 'zombie', label: 'Zombie', keyword: 'zombie' },
  { id: 'superhero', label: 'Superhero', keyword: 'superhero' },
  { id: 'true-story', label: 'Based on True Story', keyword: 'based on true story' },
  { id: 'martial-arts', label: 'Martial Arts', keyword: 'martial arts' },
]

export type RuntimeKey = 'short' | 'normal' | 'long'

export const RUNTIMES: { id: RuntimeKey; label: string; gte?: number; lte?: number }[] = [
  { id: 'short', label: 'Short (<90 min)', lte: 89 },
  { id: 'normal', label: 'Normal', gte: 90, lte: 150 },
  { id: 'long', label: 'Long (>150 min)', gte: 151 },
]

export type DiscoverSort = 'popular' | 'top' | 'newest' | 'oldest'

export const DISCOVER_SORTS: { id: DiscoverSort; label: string }[] = [
  { id: 'popular', label: 'Popular' },
  { id: 'top', label: 'Top Rated' },
  { id: 'newest', label: 'Newest' },
  { id: 'oldest', label: 'Oldest' },
]

export type TypeFilter = MediaType | 'both'

export const TYPE_OPTIONS: { id: TypeFilter; label: string }[] = [
  { id: 'movie', label: 'Movies' },
  { id: 'series', label: 'Series' },
  { id: 'both', label: 'Both' },
]

export const MIN_YEAR = 1900
export const MAX_RATING = 9
/** TMDB refuses pages beyond 500. */
export const MAX_PAGE = 500
/** Votes required whenever a rating matters, so 1-vote titles don't flood the list. */
export const MIN_VOTES_FOR_RATING = 50

export interface DiscoverFilters {
  /** null = the page's own type (Movies page → movies). */
  type: TypeFilter | null
  industries: string[]
  genres: string[]
  genreMatch: 'all' | 'any'
  categories: string[]
  yearFrom: number | null
  yearTo: number | null
  /** 0 = no minimum. */
  minRating: number
  runtime: RuntimeKey | null
  sort: DiscoverSort
}

export const DEFAULT_FILTERS: DiscoverFilters = {
  type: null,
  industries: [],
  genres: [],
  genreMatch: 'all',
  categories: [],
  yearFrom: null,
  yearTo: null,
  minRating: 0,
  runtime: null,
  sort: 'popular',
}

/** Filters that narrow the results (type and sort don't). */
export const hasNarrowingFilters = (f: DiscoverFilters) =>
  f.industries.length > 0 ||
  f.genres.length > 0 ||
  f.categories.length > 0 ||
  f.yearFrom !== null ||
  f.yearTo !== null ||
  f.minRating > 0 ||
  f.runtime !== null

export const resolveType = (f: DiscoverFilters, pageType: MediaType): TypeFilter => f.type ?? pageType

// ---- URL query string ------------------------------------------------------

const known = (ids: string[], list: { id: string }[]) =>
  ids.filter((id, i) => list.some((x) => x.id === id) && ids.indexOf(id) === i)

const listParam = (value: string | null) => (value ? value.split(',').filter(Boolean) : [])

const yearParam = (value: string | null) => {
  const year = Number(value)
  return value && Number.isInteger(year) && year >= MIN_YEAR && year <= 2100 ? year : null
}

/** Reads filters from a query string. Unknown values are dropped, so a bad link can't break the page. */
export function parseFilters(search: string): DiscoverFilters {
  const p = new URLSearchParams(search)
  const type = p.get('type')
  const runtime = p.get('runtime')
  const sort = p.get('sort')
  const rating = Number(p.get('rating'))
  return {
    type: TYPE_OPTIONS.some((t) => t.id === type) ? (type as TypeFilter) : null,
    industries: known(listParam(p.get('industry')), INDUSTRIES),
    genres: known(listParam(p.get('genre')), GENRES),
    genreMatch: p.get('match') === 'any' ? 'any' : 'all',
    categories: known(listParam(p.get('category')), CATEGORIES),
    yearFrom: yearParam(p.get('from')),
    yearTo: yearParam(p.get('to')),
    minRating: Number.isFinite(rating) ? Math.min(MAX_RATING, Math.max(0, Math.round(rating))) : 0,
    runtime: RUNTIMES.some((r) => r.id === runtime) ? (runtime as RuntimeKey) : null,
    sort: DISCOVER_SORTS.some((s) => s.id === sort) ? (sort as DiscoverSort) : 'popular',
  }
}

/** The query string for `filters` ("" for the defaults), with a leading "?" when non-empty. */
export function serializeFilters(f: DiscoverFilters): string {
  const p = new URLSearchParams()
  if (f.type) p.set('type', f.type)
  if (f.industries.length) p.set('industry', f.industries.join(','))
  if (f.genres.length) p.set('genre', f.genres.join(','))
  if (f.genres.length > 1 && f.genreMatch === 'any') p.set('match', 'any')
  if (f.categories.length) p.set('category', f.categories.join(','))
  if (f.yearFrom !== null) p.set('from', String(f.yearFrom))
  if (f.yearTo !== null) p.set('to', String(f.yearTo))
  if (f.minRating > 0) p.set('rating', String(f.minRating))
  if (f.runtime) p.set('runtime', f.runtime)
  if (f.sort !== 'popular') p.set('sort', f.sort)
  const query = p.toString().replace(/%2C/g, ',')
  return query ? `?${query}` : ''
}

// ---- Active filter chips ---------------------------------------------------

export interface ActiveFilter {
  key: string
  label: string
  /** The filters with this one removed. */
  remove: (f: DiscoverFilters) => DiscoverFilters
}

const labelOf = (list: { id: string; label: string }[], id: string) =>
  list.find((x) => x.id === id)?.label ?? id

const without = (ids: string[], id: string) => ids.filter((x) => x !== id)

/** Every removable filter currently applied, in display order. */
export function activeFilters(f: DiscoverFilters, pageType: MediaType): ActiveFilter[] {
  const chips: ActiveFilter[] = []
  if (f.type && f.type !== pageType) {
    chips.push({
      key: 'type',
      label: f.type === 'both' ? 'Movies & Series' : labelOf(TYPE_OPTIONS, f.type),
      remove: (x) => ({ ...x, type: null }),
    })
  }
  for (const id of f.industries) {
    chips.push({
      key: `industry-${id}`,
      label: labelOf(INDUSTRIES, id),
      remove: (x) => ({ ...x, industries: without(x.industries, id) }),
    })
  }
  for (const id of f.genres) {
    chips.push({
      key: `genre-${id}`,
      label: labelOf(GENRES, id),
      remove: (x) => ({ ...x, genres: without(x.genres, id) }),
    })
  }
  for (const id of f.categories) {
    chips.push({
      key: `category-${id}`,
      label: labelOf(CATEGORIES, id),
      remove: (x) => ({ ...x, categories: without(x.categories, id) }),
    })
  }
  if (f.yearFrom !== null || f.yearTo !== null) {
    chips.push({
      key: 'years',
      label:
        f.yearFrom !== null && f.yearTo !== null
          ? f.yearFrom === f.yearTo
            ? String(f.yearFrom)
            : `${f.yearFrom}–${f.yearTo}`
          : f.yearFrom !== null
            ? `From ${f.yearFrom}`
            : `Up to ${f.yearTo}`,
      remove: (x) => ({ ...x, yearFrom: null, yearTo: null }),
    })
  }
  if (f.minRating > 0) {
    chips.push({ key: 'rating', label: `★ ${f.minRating}+`, remove: (x) => ({ ...x, minRating: 0 }) })
  }
  if (f.runtime) {
    chips.push({ key: 'runtime', label: labelOf(RUNTIMES, f.runtime), remove: (x) => ({ ...x, runtime: null }) })
  }
  return chips
}

/** Clears every filter but keeps the sort order. */
export const clearFilters = (f: DiscoverFilters): DiscoverFilters => ({ ...DEFAULT_FILTERS, sort: f.sort })
