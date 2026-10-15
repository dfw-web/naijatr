import { GENRES, RUNTIMES, type DiscoverFilters } from '../config/discoverFilters'
import type { CatalogProvider, MediaItem } from '../types/media'
import { matchesQuery, sortItems } from '../utils/media'
import { sampleItems } from './sampleData'

const SECTION_SIZE = 12
const DISCOVER_PAGE_SIZE = 20

/** Minutes from a "2h 14m" length string, or null. */
const runtimeMinutes = (length?: string) => {
  const match = length?.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/)
  return match && (match[1] || match[2]) ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : null
}

/**
 * Browse filters against sample data. Samples have no country, language or
 * keyword data, so industry and keyword filters (and Anime) match nothing
 * rather than pretending.
 */
function matchesFilters(item: MediaItem, f: DiscoverFilters) {
  if (f.industries.length || f.categories.length) return false
  const genreNames = f.genres.map((id) => {
    const chip = GENRES.find((g) => g.id === id)!
    return [chip.label, chip.movie, chip.tv].filter(Boolean) as string[]
  })
  const has = (names: string[]) => names.some((n) => item.genres.includes(n))
  if (genreNames.length && !(f.genreMatch === 'all' ? genreNames.every(has) : genreNames.some(has))) {
    return false
  }
  if (f.yearFrom !== null && (item.year === null || item.year < f.yearFrom)) return false
  if (f.yearTo !== null && (item.year === null || item.year > f.yearTo)) return false
  if (f.minRating > 0 && (item.voteCount === 0 || item.score < f.minRating)) return false
  const runtime = RUNTIMES.find((r) => r.id === f.runtime)
  if (runtime && item.type === 'movie') {
    const minutes = runtimeMinutes(item.length)
    if (minutes === null) return false
    if (runtime.gte !== undefined && minutes < runtime.gte) return false
    if (runtime.lte !== undefined && minutes > runtime.lte) return false
  }
  return true
}

/** Resolves after `ms`, or rejects straight away if the request is aborted. */
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })
}

interface LocalProviderOptions {
  items?: MediaItem[]
  /** Simulated network latency, so loading states behave as they will with a real API. */
  latencyMs?: number
}

/** Serves the bundled sample catalogue through the same interface as TMDB. */
export function createLocalProvider({
  items = sampleItems,
  latencyMs = 450,
}: LocalProviderOptions = {}): CatalogProvider {
  const released = items.filter((item) => item.releaseDate !== null)

  return {
    name: 'Sample data',

    async getHome(signal) {
      await delay(latencyMs, signal)
      const trending = sortItems(released, 'popular')
      // "Popular" = most rated, like TMDB's vote-count ordering.
      const popular = (type: MediaItem['type']) =>
        released.filter((item) => item.type === type).sort((a, b) => b.voteCount - a.voteCount)

      return {
        featured: trending.find((item) => item.backdrop) ?? null,
        sections: [
          { id: 'trending', title: 'Trending Now', items: trending.slice(0, SECTION_SIZE) },
          { id: 'popular-movies', title: 'Popular Movies', items: popular('movie').slice(0, SECTION_SIZE) },
          { id: 'popular-series', title: 'Popular Series', items: popular('series').slice(0, SECTION_SIZE) },
          { id: 'recent', title: 'New & Recent', items: sortItems(released, 'newest').slice(0, SECTION_SIZE) },
        ],
      }
    },

    async getByType(type, signal) {
      await delay(latencyMs, signal)
      return sortItems(
        items.filter((item) => item.type === type),
        'popular',
      )
    },

    async discover({ filters, type, query, page }, signal) {
      await delay(Math.min(latencyMs, 200), signal)
      const matches = items.filter(
        (item) =>
          (type === 'both' || item.type === type) &&
          matchesQuery(item, query) &&
          matchesFilters(item, filters),
      )
      const sorted =
        filters.sort === 'popular'
          ? sortItems(matches, 'popular')
          : filters.sort === 'top'
            ? sortItems(matches, 'rating')
            : filters.sort === 'newest'
              ? sortItems(matches, 'newest')
              : sortItems(matches, 'newest').reverse()
      const start = (page - 1) * DISCOVER_PAGE_SIZE
      return {
        items: sorted.slice(start, start + DISCOVER_PAGE_SIZE),
        page,
        totalPages: Math.ceil(sorted.length / DISCOVER_PAGE_SIZE),
        totalResults: sorted.length,
      }
    },

    async getDetails(item, signal) {
      // Sample items already carry everything we have.
      await delay(Math.min(latencyMs, 150), signal)
      return item
    },

    async search(query, signal) {
      await delay(Math.min(latencyMs, 200), signal)
      return sortItems(
        items.filter((item) => matchesQuery(item, query)),
        'popular',
      )
    },
  }
}
