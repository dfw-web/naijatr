import type { useDiscover } from '../hooks/useDiscover'

/**
 * A filtered text search can leave a page with no matches while later pages
 * have some, so keep loading pages on our own, up to this many, before
 * showing "No titles match".
 */
export const AUTO_SCAN_PAGES = 5

/** True while empty results should keep loading the next page. */
export const isScanning = ({ items, hasMore, page, error }: ReturnType<typeof useDiscover>) =>
  items.length === 0 && !error && page > 0 && page < AUTO_SCAN_PAGES && hasMore

/** "1,234 titles", "40+ titles" (count unknown), or "Loading…". */
export function discoverCountText(discover: ReturnType<typeof useDiscover>) {
  const { isLoading, error, totalResults, items, hasMore } = discover
  if (isLoading || isScanning(discover) || (items.length === 0 && discover.isLoadingMore)) return 'Loading…'
  if (items.length === 0) return '0 titles'
  if (error) return ''
  if (totalResults !== null) return `${totalResults.toLocaleString()} ${totalResults === 1 ? 'title' : 'titles'}`
  const more = hasMore || discover.isLoadingMore
  return `${items.length}${more ? '+' : ''} ${items.length === 1 && !more ? 'title' : 'titles'}`
}

/** Keyword categories can't apply to a text search (keywords aren't in /search results). */
export const searchIgnoresCategories = (categories: string[]) => categories.some((id) => id !== 'anime')
