import type { MediaItem, MediaType } from '../types/media'

export const typeLabel = (type: MediaType) => (type === 'movie' ? 'Movie' : 'Series')

export const formatYear = (year: number | null) => (year === null ? 'TBA' : String(year))

/** Score to one decimal, or null when a title has no ratings yet. */
export const formatScore = (item: MediaItem) =>
  item.voteCount > 0 ? item.score.toFixed(1) : null

/** Compact vote count, e.g. 18420 → "18.4K". */
export const formatVotes = (count: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count)

/** Case-insensitive match against title, type, year, genres and certification. */
export function matchesQuery(item: MediaItem, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    item.title,
    typeLabel(item.type),
    item.type === 'series' ? 'tv show' : 'film',
    formatYear(item.year),
    item.certification ?? '',
    ...item.genres,
  ]
    .join(' ')
    .toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

export type SortKey = 'popular' | 'rating' | 'newest' | 'title'

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'popular', label: 'Most popular' },
  { value: 'rating', label: 'Highest rated' },
  { value: 'newest', label: 'Newest' },
  { value: 'title', label: 'Title A–Z' },
]

const byReleaseDesc = (a: MediaItem, b: MediaItem) =>
  (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '')

/** Returns a new, sorted array. Unrated titles sink to the bottom of "rating". */
export function sortItems(items: MediaItem[], key: SortKey) {
  const sorted = [...items]
  switch (key) {
    case 'popular':
      return sorted.sort((a, b) => b.popularity - a.popularity)
    case 'rating':
      return sorted.sort(
        (a, b) => Number(b.voteCount > 0) - Number(a.voteCount > 0) || b.score - a.score,
      )
    case 'newest':
      return sorted.sort(byReleaseDesc)
    case 'title':
      return sorted.sort((a, b) => a.title.localeCompare(b.title))
  }
}

/** Every genre used by a list of items, alphabetically. */
export const collectGenres = (items: MediaItem[]) =>
  [...new Set(items.flatMap((item) => item.genres))].sort((a, b) => a.localeCompare(b))
