import Fuse from 'fuse.js'
import type { MediaItem } from '../types/media'
import { correctQuery, normalize, queryVariants } from './normalize'
import { FUZZY_THRESHOLD, itemFromEntry, rankHits, type TitleIndex } from './titleIndex'

/** Fewer exact results than this: try the typo-tolerant steps too. */
export const ENOUGH_RESULTS = 3
/** Extra TMDB searches for one query, at most. */
const MAX_VARIANTS = 5
/** Results from the extra searches must look at least this much like the query. */
const LOOSE_THRESHOLD = 0.45

export interface SmartResult {
  items: MediaItem[]
  /** How many came from the search exactly as typed (ranked first). */
  exactCount: number
  /** What the results are for when the typed query found nothing ("Avengers"), else null. */
  showingFor: string | null
}

type Search = (query: string, signal?: AbortSignal) => Promise<MediaItem[]>

/** An extra search that fails just adds nothing. */
const quiet = (search: Search, query: string, signal?: AbortSignal) =>
  search(query, signal).catch((error: unknown) => {
    if (signal?.aborted) throw error
    return [] as MediaItem[]
  })

/** Title-case a corrected query for "Showing results for …". */
const titleCase = (text: string) => text.replace(/\b\w/g, (c) => c.toUpperCase())

/**
 * Typo-tolerant search:
 * 1. the query as typed (TMDB /search/multi);
 * 2. with fewer than 3 results, cleaned-up and spelling-corrected variants,
 *    searched in parallel, plus a fuzzy match against the local title index;
 * 3. merged: exact results first, then by how closely the title matches
 *    (Fuse score), then by popularity.
 * Throws only when the search as typed fails and nothing else found anything.
 */
export async function smartSearch(
  search: Search,
  query: string,
  getIndex: () => Promise<TitleIndex | null>,
  signal?: AbortSignal,
): Promise<SmartResult> {
  const typed = query.trim()
  let exact: MediaItem[] = []
  let exactError: unknown = null
  try {
    exact = await search(typed, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    exactError = error
  }
  if (exact.length >= ENOUGH_RESULTS) return { items: exact, exactCount: exact.length, showingFor: null }

  const index = await getIndex()
  const corrected = index ? correctQuery(typed, index.vocabulary) : null
  const variants = [...new Set([corrected, ...queryVariants(typed)].filter((v): v is string => Boolean(v)))]
    // TMDB ignores case, so only searches that differ by more than case.
    .filter((v) => v.toLowerCase() !== typed.toLowerCase())
    .slice(0, MAX_VARIANTS)
  const fuzzyHits = index ? [...index.find(typed), ...(corrected ? index.find(corrected) : [])] : []
  const variantResults = await Promise.all(variants.map((v) => quiet(search, v, signal)))

  const exactIds = new Set(exact.map((item) => item.id))
  // Full TMDB results beat index cards for the same title.
  const candidates = new Map<string, MediaItem>()
  for (const hit of fuzzyHits) if (!exactIds.has(hit.entry.id)) candidates.set(hit.entry.id, itemFromEntry(hit.entry))
  for (const item of variantResults.flat()) if (!exactIds.has(item.id)) candidates.set(item.id, item)

  // Score every candidate against what was typed and the corrected spelling.
  const targets = [normalize(typed), ...(corrected ? [corrected] : [])]
  const pool = [...candidates.values()].map((item) => ({ item, title: normalize(item.title), original: normalize(item.originalTitle ?? '') }))
  const fuse = new Fuse(pool, { keys: ['title', 'original'], threshold: LOOSE_THRESHOLD, ignoreLocation: true, ignoreFieldNorm: true, includeScore: true })
  const best = new Map<string, number>()
  for (const target of targets) {
    for (const r of fuse.search(target.slice(0, 32))) {
      const score = r.score ?? 1
      if (score < (best.get(r.item.item.id) ?? Infinity)) best.set(r.item.item.id, score)
    }
  }
  let ranked = rankHits(
    pool.filter(({ item }) => best.has(item.id)).map(({ item }) => ({ item, score: best.get(item.id)!, popularity: item.popularity })),
  ).map((r) => r.item)
  // Nothing looks like the query, but the variants found something: better than nothing.
  if (!ranked.length && !exact.length) ranked = [...candidates.values()].sort((a, b) => b.popularity - a.popularity)

  const items = [...exact, ...ranked]
  if (!items.length && exactError) throw exactError

  let showingFor: string | null = null
  if (!exact.length && items.length) {
    const top = fuzzyHits.find((hit) => hit.score <= FUZZY_THRESHOLD)
    showingFor = corrected ? titleCase(corrected) : top ? top.entry.title : items[0].title
  }
  return { items, exactCount: exact.length, showingFor }
}
