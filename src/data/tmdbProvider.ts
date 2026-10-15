import { MAX_PAGE } from '../config/discoverFilters'
import type {
  CatalogProvider,
  DiscoverPage,
  MediaItem,
  MediaType,
  Trailer,
  WatchProvider,
  WatchProviders,
} from '../types/media'
import {
  isoDate,
  keywordNames,
  pickKeyword,
  planDiscover,
  planSearch,
  sortMerged,
  type Endpoint,
  type GenreLists,
} from './tmdbDiscover'

/**
 * TMDB-backed catalogue.
 *
 * Requests go to `/api/tmdb/*` on our own origin. The Vite dev/preview server
 * proxies them to api.themoviedb.org and attaches the credentials server-side
 * (see vite.config.ts), so no key or token is ever shipped to the browser.
 */
const API_BASE = '/api/tmdb'
const IMAGE_BASE = 'https://image.tmdb.org/t/p'

/** Raw list result from TMDB's movie, tv, trending and search endpoints. */
export interface TmdbResult {
  id: number
  media_type?: 'movie' | 'tv' | 'person'
  title?: string
  name?: string
  release_date?: string
  first_air_date?: string
  genre_ids?: number[]
  overview?: string
  poster_path?: string | null
  backdrop_path?: string | null
  vote_average?: number
  vote_count?: number
  popularity?: number
  adult?: boolean
  origin_country?: string[]
  original_language?: string
}

interface TmdbPage {
  results: TmdbResult[]
  total_pages?: number
  total_results?: number
}

interface TmdbKeywordPage {
  results: { id: number; name: string }[]
}

interface TmdbGenreList {
  genres: { id: number; name: string }[]
}

interface TmdbCredits {
  cast?: { name: string; order?: number }[]
  crew?: { name: string; job?: string }[]
}

/** Fields we use from /movie/{id} and /tv/{id} with appended credits and ratings. */
export interface TmdbDetails {
  genres?: { id: number; name: string }[]
  tagline?: string
  status?: string
  runtime?: number | null
  number_of_seasons?: number
  seasons?: { season_number: number; name?: string; episode_count?: number }[]
  created_by?: { name: string }[]
  credits?: TmdbCredits
  release_dates?: {
    results: { iso_3166_1: string; release_dates: { certification: string }[] }[]
  }
  content_ratings?: { results: { iso_3166_1: string; rating: string }[] }
  overview?: string
  poster_path?: string | null
  backdrop_path?: string | null
  videos?: { results: TmdbVideo[] }
  'watch/providers'?: { results: Record<string, TmdbRegionProviders | undefined> }
}

export interface TmdbVideo {
  key: string
  name?: string
  site: string
  type: string
  official?: boolean
}

interface TmdbProvider {
  provider_id: number
  provider_name: string
  logo_path?: string | null
  display_priority?: number
}

export interface TmdbRegionProviders {
  link?: string
  flatrate?: TmdbProvider[]
  free?: TmdbProvider[]
  ads?: TmdbProvider[]
  rent?: TmdbProvider[]
  buy?: TmdbProvider[]
}

const CAST_LIMIT = 6

/**
 * Discover filters that keep lists to well-known titles: a minimum number of
 * ratings, and (for TV) no news, reality or talk shows, which otherwise
 * dominate TMDB's raw popularity charts.
 */
const DISCOVER_FILTERS: Record<MediaType, Record<string, string>> = {
  movie: { include_adult: 'false', 'vote_count.gte': '100' },
  series: { include_adult: 'false', 'vote_count.gte': '200', without_genres: '10763,10764,10767' },
}
const RATING_REGIONS = ['US', 'GB']
/** "Where to watch" region, then the fallback when TMDB lists nothing there. */
export const WATCH_REGIONS = ['NG', 'US']
const YOUTUBE_ID = /^[\w-]{11}$/

/** Picks the official YouTube trailer (preferred) or teaser; null when there is none. */
export function pickTrailer(videos: TmdbVideo[] = []): Trailer | null {
  const rank = (v: TmdbVideo) => (v.type === 'Trailer' ? 0 : 1)
  const best = videos
    .filter(
      (v) =>
        v.site === 'YouTube' &&
        v.official === true &&
        (v.type === 'Trailer' || v.type === 'Teaser') &&
        YOUTUBE_ID.test(v.key),
    )
    .sort((a, b) => rank(a) - rank(b))[0]
  return best ? { key: best.key, name: best.name?.trim() || 'Trailer' } : null
}

const mapProviders = (list: TmdbProvider[] = []): WatchProvider[] =>
  [...list]
    .sort((a, b) => (a.display_priority ?? 0) - (b.display_priority ?? 0))
    .map((p) => ({
      id: p.provider_id,
      name: p.provider_name,
      logo: p.logo_path ? `${IMAGE_BASE}/w92${p.logo_path}` : null,
    }))

/** Providers for the first region in `regions` that has any; null when none do. */
export function pickWatchProviders(
  results: Record<string, TmdbRegionProviders | undefined> = {},
  regions: string[] = WATCH_REGIONS,
): WatchProviders | null {
  for (const region of regions) {
    const r = results[region]
    if (!r) continue
    const providers: WatchProviders = {
      region,
      link: r.link ?? null,
      stream: mapProviders(r.flatrate),
      free: mapProviders([...(r.free ?? []), ...(r.ads ?? [])]),
      rent: mapProviders(r.rent),
      buy: mapProviders(r.buy),
    }
    if (providers.stream.length + providers.free.length + providers.rent.length + providers.buy.length) {
      return providers
    }
  }
  return null
}

const formatRuntime = (minutes: number) => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** Merges a TMDB details response into an existing list item. */
export function mergeTmdbDetails(item: MediaItem, details: TmdbDetails): MediaItem {
  const certification =
    item.type === 'movie'
      ? RATING_REGIONS.flatMap(
          (region) =>
            details.release_dates?.results
              .find((r) => r.iso_3166_1 === region)
              ?.release_dates.map((d) => d.certification)
              .filter(Boolean) ?? [],
        )[0]
      : RATING_REGIONS.flatMap(
          (region) =>
            details.content_ratings?.results
              .filter((r) => r.iso_3166_1 === region && r.rating)
              .map((r) => r.rating) ?? [],
        )[0]

  const length =
    item.type === 'movie'
      ? details.runtime
        ? formatRuntime(details.runtime)
        : undefined
      : details.number_of_seasons
        ? `${details.number_of_seasons} Season${details.number_of_seasons === 1 ? '' : 's'}`
        : undefined

  const makers =
    item.type === 'movie'
      ? details.credits?.crew?.filter((c) => c.job === 'Director').map((c) => c.name)
      : details.created_by?.map((c) => c.name)

  const cast = [...(details.credits?.cast ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .slice(0, CAST_LIMIT)
    .map((c) => c.name)

  const seasons = details.seasons
    ?.filter((s) => s.season_number > 0 && (s.episode_count ?? 0) > 0)
    .map((s) => ({
      number: s.season_number,
      name: s.name?.trim() || `Season ${s.season_number}`,
      episodeCount: s.episode_count ?? 0,
    }))

  return {
    ...item,
    seasons: seasons?.length ? seasons : item.seasons,
    genres: details.genres?.length ? details.genres.map((g) => g.name) : item.genres,
    certification: certification || item.certification,
    length: length ?? item.length,
    tagline: details.tagline?.trim() || item.tagline,
    status: details.status || item.status,
    makers: makers?.length ? [...new Set(makers)] : item.makers,
    cast: cast.length ? cast : item.cast,
    // Curated free titles may arrive without artwork; fill it from TMDB.
    poster: item.poster ?? (details.poster_path ? `${IMAGE_BASE}/w500${details.poster_path}` : null),
    backdrop:
      item.backdrop ?? (details.backdrop_path ? `${IMAGE_BASE}/w1280${details.backdrop_path}` : null),
    trailer: details.videos ? pickTrailer(details.videos.results) : item.trailer,
    watchProviders: details['watch/providers']
      ? pickWatchProviders(details['watch/providers'].results)
      : item.watchProviders,
  }
}

export class CatalogRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CatalogRequestError'
    this.status = status
  }
}

type FetchLike = typeof fetch

async function requestJson<T>(
  fetchImpl: FetchLike,
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams({ language: 'en-US', ...params })
  const response = await fetchImpl(`${API_BASE}${path}?${query}`, { signal })
  if (!response.ok) {
    const message =
      response.status === 401
        ? 'The TMDB credentials were rejected. Check the key in your .env.local file.'
        : `TMDB request failed (${response.status}).`
    throw new CatalogRequestError(response.status, message)
  }
  return (await response.json()) as T
}

/** Rejects as soon as `signal` aborts, without cancelling the shared `promise`. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

const RESPONSE_CACHE_SIZE = 200
const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000

/** Converts a TMDB list result into our MediaItem shape. Returns null for people and adult titles. */
export function mapTmdbResult(
  result: TmdbResult,
  fallbackType: MediaType,
  genreNames: Map<number, string>,
): MediaItem | null {
  if (result.adult || result.media_type === 'person') return null
  const type: MediaType =
    result.media_type === 'tv' ? 'series' : result.media_type === 'movie' ? 'movie' : fallbackType
  const releaseDate = (type === 'movie' ? result.release_date : result.first_air_date) || null

  return {
    id: `tmdb-${type}-${result.id}`,
    tmdbId: result.id,
    title: result.title ?? result.name ?? 'Untitled',
    type,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    releaseDate,
    genres: (result.genre_ids ?? []).flatMap((id) => genreNames.get(id) ?? []),
    score: Math.round((result.vote_average ?? 0) * 10) / 10,
    voteCount: result.vote_count ?? 0,
    popularity: result.popularity ?? 0,
    description: result.overview?.trim() || 'No overview is available for this title yet.',
    poster: result.poster_path ? `${IMAGE_BASE}/w500${result.poster_path}` : null,
    backdrop: result.backdrop_path ? `${IMAGE_BASE}/w1280${result.backdrop_path}` : null,
  }
}

export function createTmdbProvider(fetchImpl: FetchLike = fetch.bind(globalThis)): CatalogProvider {
  let genresPromise: Promise<{ lists: GenreLists; names: Map<number, string> }> | null = null
  const keywordPromises = new Map<string, Promise<number | null>>()
  const responses = new Map<string, { at: number; promise: Promise<unknown> }>()

  // Genre lists are shared by every list and filter, so fetch both once and cache them.
  // The shared fetch deliberately ignores any single caller's AbortSignal:
  // otherwise one cancelled request would poison the cache for everyone else.
  const loadGenreData = () => {
    if (!genresPromise) {
      const promise = Promise.all([
        requestJson<TmdbGenreList>(fetchImpl, '/genre/movie/list'),
        requestJson<TmdbGenreList>(fetchImpl, '/genre/tv/list'),
      ])
        .then(([movie, tv]) => ({
          lists: { movie: movie.genres, tv: tv.genres },
          names: new Map([...movie.genres, ...tv.genres].map((g) => [g.id, g.name])),
        }))
        .catch((error: unknown) => {
          if (genresPromise === promise) genresPromise = null // let a retry try again
          throw error
        })
      genresPromise = promise
    }
    return genresPromise
  }
  const loadGenres = () => loadGenreData().then((data) => data.names)

  // Filter requests repeat a lot (Back, toggling a chip off and on, the mobile
  // sheet's count then Apply), so keep recent responses. Like the genre
  // cache, the shared fetch ignores any single caller's AbortSignal.
  const cachedJson = <T,>(path: string, params: Record<string, string>, signal?: AbortSignal) => {
    const key = `${path}?${new URLSearchParams(params)}`
    const hit = responses.get(key)
    if (hit && Date.now() - hit.at < RESPONSE_CACHE_TTL_MS) {
      return abortable(hit.promise as Promise<T>, signal)
    }
    const promise = requestJson<T>(fetchImpl, path, params).catch((error: unknown) => {
      if (responses.get(key)?.promise === promise) responses.delete(key)
      throw error
    })
    responses.delete(key)
    responses.set(key, { at: Date.now(), promise })
    if (responses.size > RESPONSE_CACHE_SIZE) responses.delete(responses.keys().next().value!)
    return abortable(promise, signal)
  }

  // Keyword IDs are looked up by name once, never hard-coded.
  const keywordId = (name: string) => {
    let promise = keywordPromises.get(name)
    if (!promise) {
      const lookup = requestJson<TmdbKeywordPage>(fetchImpl, '/search/keyword', { query: name })
        .then((page) => pickKeyword(page.results, name))
        .catch((error: unknown) => {
          if (keywordPromises.get(name) === lookup) keywordPromises.delete(name)
          throw error
        })
      keywordPromises.set(name, lookup)
      promise = lookup
    }
    return promise
  }

  const list = async (
    path: string,
    fallbackType: MediaType,
    signal?: AbortSignal,
    params: Record<string, string> = {},
  ) => {
    const [genres, page] = await Promise.all([
      loadGenres(),
      requestJson<TmdbPage>(fetchImpl, path, params, signal),
    ])
    return page.results.flatMap((result) => mapTmdbResult(result, fallbackType, genres) ?? [])
  }

  return {
    name: 'TMDB',

    async getHome(signal) {
      const [trending, popularMovies, popularSeries, nowPlaying, onTheAir] = await Promise.all([
        list('/trending/all/week', 'movie', signal),
        list('/movie/popular', 'movie', signal),
        list('/discover/tv', 'series', signal, {
          sort_by: 'popularity.desc',
          ...DISCOVER_FILTERS.series,
        }),
        list('/movie/now_playing', 'movie', signal),
        list('/tv/on_the_air', 'series', signal),
      ])
      const recent = [...nowPlaying, ...onTheAir]
        .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
        .slice(0, 20)

      return {
        featured: trending.find((item) => item.backdrop) ?? null,
        sections: [
          { id: 'trending', title: 'Trending Now', items: trending },
          { id: 'popular-movies', title: 'Popular Movies', items: popularMovies },
          { id: 'popular-series', title: 'Popular Series', items: popularSeries },
          { id: 'recent', title: 'New & Recent', items: recent },
        ],
      }
    },

    async getByType(type, signal) {
      const path = type === 'movie' ? '/discover/movie' : '/discover/tv'
      const params = { sort_by: 'popularity.desc', ...DISCOVER_FILTERS[type] }
      const pages = await Promise.all(
        ['1', '2'].map((page) => list(path, type, signal, { ...params, page })),
      )
      // Popularity can shift between page requests; drop any duplicates.
      return [...new Map(pages.flat().map((item) => [item.id, item])).values()]
    },

    search(query, signal) {
      return list('/search/multi', 'movie', signal, { query, include_adult: 'false' })
    },

    async discover({ filters, type, query, page }, signal) {
      const endpoints: Endpoint[] =
        type === 'both' ? ['movie', 'tv'] : [type === 'movie' ? 'movie' : 'tv']
      const text = query.trim()
      const [{ lists, names }, keywordIds] = await abortable(
        Promise.all([
          loadGenreData(),
          text
            ? Promise.resolve([])
            : Promise.all(keywordNames(filters).map(keywordId)).then((ids) =>
                ids.filter((id): id is number => id !== null),
              ),
        ]),
        signal,
      )
      const today = isoDate(new Date())

      const results = await Promise.all(
        endpoints.map(async (endpoint) => {
          const plan = text
            ? planSearch(filters, endpoint, lists, text)
            : planDiscover(filters, endpoint, lists, keywordIds, today)
          if (!plan) return null
          const path = `/${text ? 'search' : 'discover'}/${endpoint}`
          const data = await cachedJson<TmdbPage>(path, { ...plan.params, page: String(page) }, signal)
          const fallbackType: MediaType = endpoint === 'movie' ? 'movie' : 'series'
          return {
            items: data.results
              .filter((r) => !plan.keep || plan.keep(r))
              .flatMap((r) => mapTmdbResult(r, fallbackType, names) ?? []),
            totalPages: Math.min(data.total_pages ?? 1, MAX_PAGE),
            totalResults: plan.keep ? null : (data.total_results ?? 0),
          }
        }),
      )

      const answered = results.filter((r) => r !== null)
      const items = answered.flatMap((r) => r.items)
      // Both types: merge the two pages by the chosen sort (popularity by default).
      const merge = answered.length > 1 || (text !== '' && filters.sort !== 'popular')
      return {
        items: merge ? sortMerged(items, filters.sort) : items,
        page,
        totalPages: Math.max(0, ...answered.map((r) => r.totalPages)),
        totalResults: answered.some((r) => r.totalResults === null)
          ? null
          : answered.reduce((sum, r) => sum + (r.totalResults ?? 0), 0),
      } satisfies DiscoverPage
    },

    async getDetails(item, signal) {
      if (item.tmdbId === undefined) return item
      const path = item.type === 'movie' ? `/movie/${item.tmdbId}` : `/tv/${item.tmdbId}`
      const append =
        item.type === 'movie'
          ? 'credits,release_dates,videos,watch/providers'
          : 'aggregate_credits,content_ratings,videos,watch/providers'
      const details = await requestJson<TmdbDetails & { aggregate_credits?: TmdbCredits }>(
        fetchImpl,
        path,
        // Videos are filtered by `language`; also keep ones with no language set.
        { append_to_response: append, include_video_language: 'en,null' },
        signal,
      )
      // TV uses aggregate_credits (cast across all seasons); normalise to `credits`.
      return mergeTmdbDetails(item, {
        ...details,
        credits: details.credits ?? details.aggregate_credits,
      })
    },
  }
}
