import { useEffect, useState } from 'react'
import { useCatalogProvider } from '../data/provider'
import type { CatalogProvider } from '../types/media'
import { readContinueWatching, useContinueWatching, type ContinueEntry } from '../utils/continueWatching'
import { createTitleIndex, entryFromItem, type IndexEntry, type TitleIndex } from './titleIndex'

/**
 * The local title index behind typo-tolerant search: the provider's list
 * (popular, trending, top-rated, Nollywood, K-drama, anime, Bollywood; see
 * server/searchIndex.ts) plus everything in Continue Watching. Loaded once
 * per provider, only once someone searches, and shared by the suggestions
 * and the results page.
 */

/** A search waits at most this long for the index; after that it goes without. */
export const INDEX_WAIT_MS = 4000

const entriesByProvider = new WeakMap<CatalogProvider, Promise<IndexEntry[]>>()

function loadEntries(provider: CatalogProvider): Promise<IndexEntry[]> {
  let promise = entriesByProvider.get(provider)
  if (!promise) {
    const load: Promise<IndexEntry[]> = (provider.searchIndex?.() ?? Promise.resolve([])).catch(() => {
      // Let the next search try again.
      if (entriesByProvider.get(provider) === load) entriesByProvider.delete(provider)
      return []
    })
    entriesByProvider.set(provider, load)
    promise = load
  }
  return promise
}

let built: { base: IndexEntry[]; watched: ContinueEntry[]; index: TitleIndex | null } | null = null

function indexOf(base: IndexEntry[], watched: ContinueEntry[]): TitleIndex | null {
  if (built && built.base === base && built.watched === watched) return built.index
  const extra = watched.map((entry) => entryFromItem({ ...entry.item, originalTitle: undefined }))
  const index = base.length || extra.length ? createTitleIndex([...base, ...extra]) : null
  built = { base, watched, index }
  return index
}

/** The index, once loaded (null if there's nothing to search). */
export async function titleIndexFor(provider: CatalogProvider): Promise<TitleIndex | null> {
  const base = await loadEntries(provider)
  return indexOf(base, readContinueWatching())
}

/** titleIndexFor, giving up after INDEX_WAIT_MS so a slow index never holds up results. */
export function titleIndexSoon(provider: CatalogProvider, signal?: AbortSignal): Promise<TitleIndex | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), INDEX_WAIT_MS)
    signal?.addEventListener('abort', () => clearTimeout(timer), { once: true })
    void titleIndexFor(provider).then((index) => {
      clearTimeout(timer)
      resolve(index)
    })
  })
}

/** The index for instant suggestions; null until loaded. Starts loading once `enabled`. */
export function useTitleIndex(enabled: boolean): TitleIndex | null {
  const provider = useCatalogProvider()
  const watched = useContinueWatching()
  const [loaded, setLoaded] = useState<{ provider: CatalogProvider; base: IndexEntry[] } | null>(null)
  const ready = loaded?.provider === provider

  useEffect(() => {
    if (!enabled || ready) return
    let alive = true
    void loadEntries(provider).then((base) => alive && setLoaded({ provider, base }))
    return () => {
      alive = false
    }
  }, [enabled, ready, provider])

  return ready ? indexOf(loaded.base, watched) : null
}
