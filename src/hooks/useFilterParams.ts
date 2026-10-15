import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_FILTERS, parseFilters, serializeFilters, type DiscoverFilters } from '../config/discoverFilters'
import { useDebouncedValue } from './useDebouncedValue'

export const FILTER_DEBOUNCE_MS = 300

/**
 * Browse filters, kept in the URL query string so links are shareable and
 * Back/Forward step through filter changes. `filters` updates instantly (for
 * the chips); `committed` follows ~300 ms later and drives requests and history.
 */
export function useFilterParams() {
  const [filters, setFilters] = useState<DiscoverFilters>(() => parseFilters(window.location.search))
  const committed = useDebouncedValue(filters, FILTER_DEBOUNCE_MS)

  useEffect(() => {
    const onPopState = () => setFilters(parseFilters(window.location.search))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const search = serializeFilters(committed)
    if (search === window.location.search) return
    const { pathname, hash } = window.location
    window.history.pushState(null, '', pathname + search + hash)
  }, [committed])

  const reset = useCallback(() => setFilters(DEFAULT_FILTERS), [])

  return { filters, committed, setFilters, reset }
}
