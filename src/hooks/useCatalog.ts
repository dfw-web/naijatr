import { useCallback } from 'react'
import { useCatalogProvider } from '../data/provider'
import type { MediaItem, MediaType } from '../types/media'
import { useAsync } from './useAsync'
import { useDebouncedValue } from './useDebouncedValue'

/** Featured title and homepage sections. */
export function useHomeCatalog() {
  const provider = useCatalogProvider()
  return useAsync(useCallback((signal: AbortSignal) => provider.getHome(signal), [provider]))
}

/** Every movie, or every series, for the browse pages. */
export function useTitlesByType(type: MediaType) {
  const provider = useCatalogProvider()
  return useAsync(
    useCallback((signal: AbortSignal) => provider.getByType(type, signal), [provider, type]),
  )
}

export const SEARCH_DEBOUNCE_MS = 250

/** Debounced search. Idle while the query is blank. */
export function useSearch(query: string) {
  const provider = useCatalogProvider()
  const debounced = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS)
  const load = useCallback(
    (signal: AbortSignal) => provider.search(debounced, signal),
    [provider, debounced],
  )
  const result = useAsync(debounced ? load : null)
  // While the user is still typing, report loading rather than stale results.
  const isPending = query.trim() !== debounced
  return { ...result, isPending, debouncedQuery: debounced }
}

/** Extra detail (runtime, cast, ...) for the details panel. */
export function useItemDetails(item: MediaItem) {
  const provider = useCatalogProvider()
  return useAsync(
    useCallback((signal: AbortSignal) => provider.getDetails(item, signal), [provider, item]),
  )
}
