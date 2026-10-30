import Fuse from 'fuse.js'
import type { MediaItem, MediaType } from '../types/media'
import { buildVocabulary, normalize, type Vocabulary } from './normalize'

/** One title in the local search index. */
export interface IndexEntry {
  /** Our MediaItem id (tmdb-movie-550). */
  id: string
  tmdbId?: number
  type: MediaType
  title: string
  originalTitle?: string
  /** Other names it's known by. */
  alt?: string[]
  year: number | null
  poster: string | null
  popularity: number
  score: number
}

/**
 * The index as /api/search-index sends it, one compact row per title:
 * [tmdbId, "m" | "s", title, originalTitle | "", year | 0, posterPath | "", popularity, score × 10].
 */
export type IndexRow = [number, 'm' | 's', string, string, number, string, number, number]

const IMAGE_BASE = 'https://image.tmdb.org/t/p'

export function entryFromRow([tmdbId, kind, title, original, year, poster, popularity, score]: IndexRow): IndexEntry {
  const type: MediaType = kind === 's' ? 'series' : 'movie'
  return {
    id: `tmdb-${type}-${tmdbId}`,
    tmdbId,
    type,
    title,
    ...(original && original !== title ? { originalTitle: original } : {}),
    year: year || null,
    poster: poster ? `${IMAGE_BASE}/w342${poster}` : null,
    popularity,
    score: score / 10,
  }
}

export const isIndexRow = (row: unknown): row is IndexRow =>
  Array.isArray(row) && row.length === 8 && typeof row[0] === 'number' && (row[1] === 'm' || row[1] === 's') && typeof row[2] === 'string'

export const entryFromItem = (item: Pick<MediaItem, 'id' | 'tmdbId' | 'type' | 'title' | 'originalTitle' | 'year' | 'poster' | 'popularity' | 'score'>): IndexEntry => ({
  id: item.id,
  ...(item.tmdbId !== undefined ? { tmdbId: item.tmdbId } : {}),
  type: item.type,
  title: item.title,
  ...(item.originalTitle ? { originalTitle: item.originalTitle } : {}),
  year: item.year,
  poster: item.poster,
  popularity: item.popularity,
  score: item.score,
})

/** A card for an index entry; the details panel loads the rest. */
export const itemFromEntry = (entry: IndexEntry): MediaItem => ({
  id: entry.id,
  ...(entry.tmdbId !== undefined ? { tmdbId: entry.tmdbId } : {}),
  type: entry.type,
  title: entry.title,
  ...(entry.originalTitle ? { originalTitle: entry.originalTitle } : {}),
  year: entry.year,
  releaseDate: null,
  genres: [],
  score: entry.score,
  voteCount: 0,
  popularity: entry.popularity,
  description: '',
  poster: entry.poster,
  backdrop: null,
})

/** Fuse's typo tolerance: 0 = exact, 1 = anything. */
export const FUZZY_THRESHOLD = 0.35

interface Searchable {
  entry: IndexEntry
  title: string
  original: string
  alt: string[]
}

export interface FuzzyHit {
  entry: IndexEntry
  /** 0 = perfect match … FUZZY_THRESHOLD = barely. */
  score: number
}

export interface TitleIndex {
  entries: IndexEntry[]
  vocabulary: Vocabulary
  /** Closest titles first; among near-equal matches, the more popular one. */
  find(query: string, limit?: number): FuzzyHit[]
}

/** Scores this close count as a tie, broken by popularity. */
const TIE = 0.05

export const rankHits = <T extends { score: number; popularity: number }>(hits: T[]) =>
  hits.sort((a, b) => Math.round(a.score / TIE) - Math.round(b.score / TIE) || b.popularity - a.popularity)

export function createTitleIndex(entries: IndexEntry[]): TitleIndex {
  // Later entries win, so callers can add fresher copies (Continue Watching) last.
  const unique = [...new Map(entries.map((e) => [e.id, e])).values()]
  const searchable: Searchable[] = unique.map((entry) => ({
    entry,
    title: normalize(entry.title),
    original: entry.originalTitle ? normalize(entry.originalTitle) : '',
    alt: (entry.alt ?? []).map(normalize),
  }))
  const fuse = new Fuse(searchable, {
    keys: [
      { name: 'title', weight: 1 },
      { name: 'original', weight: 0.7 },
      { name: 'alt', weight: 0.6 },
    ],
    threshold: FUZZY_THRESHOLD,
    ignoreLocation: true,
    // A long title ("Avengers: Infinity War") is as good a match as a short one; popularity decides.
    ignoreFieldNorm: true,
    includeScore: true,
  })
  const vocabulary = buildVocabulary(
    unique.flatMap((e) => [e.title, e.originalTitle ?? '', ...(e.alt ?? [])].filter(Boolean).map((text) => ({ text, weight: e.popularity }))),
  )
  return {
    entries: unique,
    vocabulary,
    find(query, limit = 20) {
      const q = normalize(query)
      if (q.length < 2) return []
      const hits = fuse
        .search(q.slice(0, 32), { limit: limit * 3 })
        .map((r) => ({ entry: r.item.entry, score: r.score ?? 1, popularity: r.item.entry.popularity }))
      return rankHits(hits)
        .slice(0, limit)
        .map(({ entry, score }) => ({ entry, score }))
    },
  }
}
