import { useMemo } from 'react'
import { useSearch } from '../hooks/useCatalog'
import type { MediaItem } from '../types/media'
import { useTitleIndex } from './indexStore'
import { itemFromEntry } from './titleIndex'

/** Suggestions start at this many characters. */
export const SUGGEST_MIN_CHARS = 2
export const SUGGESTION_LIMIT = 8
export const SUGGESTIONS_ID = 'search-suggestions'
export const suggestionId = (index: number) => `search-suggestion-${index}`

/**
 * Live suggestions while typing: the local fuzzy index first (instant, and
 * typo-tolerant), then TMDB's results once they arrive (debounced). Starts
 * loading the index only once the search box is used.
 */
export function useSuggestions(query: string, enabled: boolean): MediaItem[] {
  const text = query.trim()
  const active = enabled && text.length >= SUGGEST_MIN_CHARS
  const index = useTitleIndex(enabled)
  const remote = useSearch(active ? text : '')
  const remoteItems = remote.state.status === 'success' && !remote.isPending ? remote.state.data : null

  return useMemo(() => {
    if (!active) return []
    const local = index ? index.find(text, SUGGESTION_LIMIT).map((hit) => itemFromEntry(hit.entry)) : []
    const full = new Map((remoteItems ?? []).map((item) => [item.id, item]))
    // TMDB's copy has more detail; same place in the list.
    const merged = local.map((item) => full.get(item.id) ?? item)
    const seen = new Set(merged.map((item) => item.id))
    for (const item of remoteItems ?? []) if (!seen.has(item.id)) merged.push(item)
    return merged.slice(0, SUGGESTION_LIMIT)
  }, [active, index, text, remoteItems])
}
