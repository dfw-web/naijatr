import type { CatalogProvider, FallbackStatus } from '../types/media'

/**
 * Wraps a primary provider (TMDB) with a fallback (sample data). Every call
 * tries the primary first; if it fails for any reason other than being
 * cancelled, the fallback answers instead and the status records why, so the
 * UI can explain. A later successful primary call clears the status.
 */
export function createFallbackProvider(
  primary: CatalogProvider,
  fallback: CatalogProvider,
): CatalogProvider {
  let status: FallbackStatus = { active: false, reason: null }
  const listeners = new Set<() => void>()

  const setStatus = (next: FallbackStatus) => {
    if (next.active === status.active && next.reason === status.reason) return
    status = next
    listeners.forEach((listener) => listener())
  }

  async function withFallback<T>(
    call: (provider: CatalogProvider) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      const result = await call(primary)
      setStatus({ active: false, reason: null })
      return result
    } catch (error) {
      if (signal?.aborted) throw error
      setStatus({
        active: true,
        reason: error instanceof Error ? error.message : `${primary.name} is unavailable.`,
      })
      return call(fallback)
    }
  }

  return {
    name: primary.name,
    getHome: (signal) => withFallback((p) => p.getHome(signal), signal),
    getByType: (type, signal) => withFallback((p) => p.getByType(type, signal), signal),
    search: (query, signal) => withFallback((p) => p.search(query, signal), signal),
    discover: (request, signal) => withFallback((p) => p.discover(request, signal), signal),
    // Details only enrich an item we already show; a failure is reported in the panel.
    getDetails: (item, signal) => primary.getDetails(item, signal),
    ...(primary.listTmdb ? { listTmdb: primary.listTmdb.bind(primary) } : {}),
    fallback: {
      getStatus: () => status,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}
