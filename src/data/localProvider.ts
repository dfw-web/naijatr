import type { CatalogProvider, MediaItem } from '../types/media'
import { matchesQuery, sortItems } from '../utils/media'
import { sampleItems } from './sampleData'

const SECTION_SIZE = 12

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
