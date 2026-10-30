import { useCallback } from 'react'
import { useCatalogProvider } from '../data/provider'
import { titleIndexSoon } from '../search/indexStore'
import { smartSearch, type SmartResult } from '../search/smartSearch'
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

/**
 * Typo-tolerant search (src/search/smartSearch.ts), debounced. `strict`
 * searches only for exactly what was typed ("Search instead for …").
 */
export function useSmartSearch(query: string, strict = false) {
  const provider = useCatalogProvider()
  const debounced = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS)
  const load = useCallback(
    async (signal: AbortSignal): Promise<SmartResult> => {
      const search = (q: string, s?: AbortSignal) => provider.search(q, s)
      if (strict) {
        const items = await search(debounced, signal)
        return { items, exactCount: items.length, showingFor: null }
      }
      return smartSearch(search, debounced, () => titleIndexSoon(provider, signal), signal)
    },
    [provider, debounced, strict],
  )
  const result = useAsync(debounced ? load : null)
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
