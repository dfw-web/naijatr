import { useCallback, useEffect, useState } from 'react'
import { parseFilters, serializeFilters, type TypeFilter } from '../config/discoverFilters'
import { useCatalogProvider } from '../data/provider'
import type { DiscoverRequest, MediaItem } from '../types/media'

type Request = Omit<DiscoverRequest, 'page'>

interface Loaded {
  key: string
  /** Last page that loaded. */
  page: number
  items: MediaItem[]
  totalPages: number
  totalResults: number | null
}

interface Wanted {
  key: string
  page: number
  attempt: number
}

interface Failure {
  key: string
  page: number
  attempt: number
  error: Error
}

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error('Something went wrong while loading titles.')

/**
 * Pages of filtered titles. Page 1 loads whenever the request changes; then
 * `loadMore` appends the next page (up to TMDB's limit). Passing `null` stays idle.
 */
export function useDiscover(request: Request | null) {
  const provider = useCatalogProvider()
  const key = request
    ? JSON.stringify([serializeFilters(request.filters), request.type, request.query.trim()])
    : null

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [wantedState, setWanted] = useState<Wanted | null>(null)
  // A new request starts again from page 1.
  const wanted: Wanted | null = key
    ? wantedState?.key === key
      ? wantedState
      : { key, page: 1, attempt: 0 }
    : null

  const current = loaded?.key === key ? loaded : null
  const wantedPage = wanted?.page ?? 0
  const attempt = wanted?.attempt ?? 0

  useEffect(() => {
    if (!key) return
    // The key round-trips the request, so the effect only re-runs when it really changes.
    const [search, type, query] = JSON.parse(key) as [string, TypeFilter, string]
    const controller = new AbortController()
    provider.discover({ filters: parseFilters(search), type, query, page: wantedPage }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        setLoaded((prev) => {
          const base = prev?.key === key && wantedPage > 1 ? prev.items : []
          const seen = new Set(base.map((item) => item.id))
          return {
            key,
            page: wantedPage,
            items: [...base, ...result.items.filter((item) => !seen.has(item.id))],
            totalPages: result.totalPages,
            totalResults: result.totalResults,
          }
        })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setFailure({ key, page: wantedPage, attempt, error: toError(error) })
        }
      },
    )
    return () => controller.abort()
  }, [provider, key, wantedPage, attempt])

  const failed =
    failure && failure.key === key && failure.page === wantedPage && failure.attempt === attempt
      ? failure.error
      : null
  const pageLoaded = current?.page === wantedPage
  const isLoading = Boolean(key) && !failed && !current
  const isLoadingMore = Boolean(current) && !failed && !pageLoaded
  const hasMore = Boolean(current && pageLoaded && current.page < current.totalPages)

  const lastPage = current?.page ?? 0
  const loadMore = useCallback(() => {
    if (key && hasMore) setWanted({ key, page: lastPage + 1, attempt: 0 })
  }, [key, hasMore, lastPage])

  const retry = useCallback(() => {
    if (key) setWanted({ key, page: wantedPage, attempt: attempt + 1 })
  }, [key, wantedPage, attempt])

  return {
    items: current?.items ?? [],
    /** Last page loaded (0 before the first). */
    page: current?.page ?? 0,
    totalResults: current?.totalResults ?? null,
    isLoading,
    isLoadingMore,
    hasMore,
    /** Error for the page being loaded (the first page, or the next one). */
    error: failed,
    loadMore,
    retry,
  }
}
