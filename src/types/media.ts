import type { DiscoverFilters, TypeFilter } from '../config/discoverFilters'

export type MediaType = 'movie' | 'series'

export interface MediaItem {
  id: string
  title: string
  type: MediaType
  /** Release year, or null when the title has no announced date yet. */
  year: number | null
  /** ISO date (YYYY-MM-DD) of release or first air date, when known. */
  releaseDate: string | null
  genres: string[]
  /** Age/content rating, e.g. "PG-13" or "TV-MA", when known. */
  certification?: string
  /** Average audience score out of 10. */
  score: number
  /** Number of audience ratings behind the score. */
  voteCount: number
  /** Relative popularity used for "trending" ordering. */
  popularity: number
  /** Runtime for movies ("2h 14m") or season count for series ("3 Seasons"), when known. */
  length?: string
  description: string
  /** Portrait image (2:3), or null if none exists. */
  poster: string | null
  /** Landscape image (16:9), or null if none exists. */
  backdrop: string | null
  /** Numeric TMDB id, for titles that came from TMDB. */
  tmdbId?: number
  /** TMDB genre ids, origin countries and original language: the taste profile's attributes (src/taste). */
  genreIds?: number[]
  originCountry?: string[]
  originalLanguage?: string
  /** Up to 5 TMDB keyword ids, filled in by getDetails(). */
  keywordIds?: number[]

  // Extra fields filled in by CatalogProvider.getDetails().
  tagline?: string
  /** e.g. "Released", "Returning Series", "Ended". */
  status?: string
  /** Director(s) for movies, creator(s) for series. */
  makers?: string[]
  /** Top-billed cast. */
  cast?: string[]
  /** Regular seasons of a series (specials excluded), when known. */
  seasons?: SeasonSummary[]
  /** Official YouTube trailer or teaser; null when TMDB has none. */
  trailer?: Trailer | null
  /** TMDB "Where to watch" providers (JustWatch data); null when none are listed. */
  watchProviders?: WatchProviders | null
  /** TMDB recommendations ("More like this"), when known. */
  similar?: MediaItem[]
}

export interface Trailer {
  /** YouTube video id. */
  key: string
  name: string
}

export interface WatchProvider {
  id: number
  name: string
  logo: string | null
}

export interface WatchProviders {
  /** ISO 3166-1 region the list is for, e.g. "NG". */
  region: string
  /** TMDB's watch page for the title, when given. */
  link: string | null
  stream: WatchProvider[]
  free: WatchProvider[]
  rent: WatchProvider[]
  buy: WatchProvider[]
}

export interface SeasonSummary {
  number: number
  name: string
  episodeCount: number
}

export interface CatalogSection {
  id: string
  title: string
  items: MediaItem[]
}

export interface HomeCatalog {
  featured: MediaItem | null
  sections: CatalogSection[]
}

/**
 * The contract every catalogue source implements. UI code only talks to this
 * interface, so swapping the local sample data for TMDB needs no UI changes.
 */
export interface CatalogProvider {
  /** Short name shown in attribution, e.g. "Sample data" or "TMDB". */
  readonly name: string
  getHome(signal?: AbortSignal): Promise<HomeCatalog>
  getByType(type: MediaType, signal?: AbortSignal): Promise<MediaItem[]>
  search(query: string, signal?: AbortSignal): Promise<MediaItem[]>
  /**
   * One page of titles matching the Browse filters (`type` already resolved).
   * With a text `query`, searches by title and applies the filters client-side.
   */
  discover(request: DiscoverRequest, signal?: AbortSignal): Promise<DiscoverPage>
  /** Returns the item enriched with extra detail (runtime, cast, ...), when available. */
  getDetails(item: MediaItem, signal?: AbortSignal): Promise<MediaItem>
  /**
   * One TMDB list (recommendations, similar, discover) for the personalised
   * home rows, cached for a day. Only the TMDB provider has it.
   */
  listTmdb?(path: string, params: Record<string, string>, type: MediaType, signal?: AbortSignal): Promise<MediaItem[]>
  /** Present when the provider can fall back to another source (see fallbackProvider.ts). */
  readonly fallback?: FallbackStore
}

export interface FallbackStatus {
  /** True while results come from the fallback source. */
  active: boolean
  reason: string | null
}

export interface FallbackStore {
  getStatus(): FallbackStatus
  subscribe(listener: () => void): () => void
}

export interface DiscoverRequest {
  filters: DiscoverFilters
  type: TypeFilter
  /** Text search; blank for plain discovery. */
  query: string
  /** 1-based. */
  page: number
}

export interface DiscoverPage {
  items: MediaItem[]
  page: number
  totalPages: number
  /** Total matches, or null when unknown (text search filtered client-side). */
  totalResults: number | null
}
