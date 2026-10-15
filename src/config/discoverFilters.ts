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

/** TMDB refuses pages beyond 500. */
export const MAX_PAGE = 500
/** Votes required for Top Rated, so 1-vote titles don't flood the list. */
export const MIN_VOTES_FOR_RATING = 50

export interface DiscoverFilters {
  /** null = the page's own type (Movies page → movies). */
  type: TypeFilter | null
  industries: string[]
  genres: string[]
  genreMatch: 'all' | 'any'
  categories: string[]
  sort: DiscoverSort
}

export const DEFAULT_FILTERS: DiscoverFilters = {
  type: null,
  industries: [],
  genres: [],
  genreMatch: 'all',
  categories: [],
  sort: 'popular',
}

/** Filters that narrow the results (type and sort don't). */
export const hasNarrowingFilters = (f: DiscoverFilters) =>
  f.industries.length > 0 || f.genres.length > 0 || f.categories.length > 0

/** The Type filter, or the page's default: movies on Movies, series on Series, both on search. */
export const resolveType = (f: DiscoverFilters, pageType: TypeFilter): TypeFilter => f.type ?? pageType

// ---- URL query string ------------------------------------------------------

const known = (ids: string[], list: { id: string }[]) =>
  ids.filter((id, i) => list.some((x) => x.id === id) && ids.indexOf(id) === i)

const listParam = (value: string | null) => (value ? value.split(',').filter(Boolean) : [])

/** Reads filters from a query string. Unknown values are dropped, so a bad link can't break the page. */
export function parseFilters(search: string): DiscoverFilters {
  const p = new URLSearchParams(search)
  const type = p.get('type')
  const sort = p.get('sort')
  return {
    type: TYPE_OPTIONS.some((t) => t.id === type) ? (type as TypeFilter) : null,
    industries: known(listParam(p.get('industry')), INDUSTRIES),
    genres: known(listParam(p.get('genre')), GENRES),
    genreMatch: p.get('match') === 'any' ? 'any' : 'all',
    categories: known(listParam(p.get('category')), CATEGORIES),
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
export function activeFilters(f: DiscoverFilters, pageType: TypeFilter): ActiveFilter[] {
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
  return chips
}

/** Clears every filter but keeps the sort order. */
export const clearFilters = (f: DiscoverFilters): DiscoverFilters => ({ ...DEFAULT_FILTERS, sort: f.sort })
