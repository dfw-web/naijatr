import type { MediaItem } from '../types/media'
import { entryFromItem, type IndexEntry } from './titleIndex'

/** A small catalogue with the titles people misspell most, for the search tests. */
const make = (tmdbId: number, title: string, type: MediaItem['type'], year: number, popularity: number, originalTitle?: string): MediaItem => ({
  id: `tmdb-${type}-${tmdbId}`,
  tmdbId,
  title,
  ...(originalTitle ? { originalTitle } : {}),
  type,
  year,
  releaseDate: `${year}-01-01`,
  genres: [],
  score: 7,
  voteCount: 100,
  popularity,
  description: '',
  poster: null,
  backdrop: null,
})

export const CATALOG: MediaItem[] = [
  make(299534, 'Avengers: Endgame', 'movie', 2019, 90),
  make(24428, 'The Avengers', 'movie', 2012, 80),
  make(299536, 'Avengers: Infinity War', 'movie', 2018, 85),
  make(634649, 'Spider-Man: No Way Home', 'movie', 2021, 95),
  make(557, 'Spider-Man', 'movie', 2002, 60),
  make(93405, 'Squid Game', 'series', 2021, 99, '오징어 게임'),
  make(71446, 'Money Heist', 'series', 2017, 70, 'La casa de papel'),
  make(1008042, 'Anikulapo', 'movie', 2022, 20),
  make(194, 'Amélie', 'movie', 2001, 30, "Le Fabuleux Destin d'Amélie Poulain"),
  make(168259, 'Furious 7', 'movie', 2015, 50),
  make(12445, 'Harry Potter and the Deathly Hallows: Part 2', 'movie', 2011, 65),
  make(863, 'Toy Story 2', 'movie', 1999, 40),
  make(1396, 'Breaking Bad', 'series', 2008, 88),
  make(66732, 'Stranger Things', 'series', 2016, 92),
  make(12, 'Finding Nemo', 'movie', 2003, 55),
  make(76600, 'Avatar: The Way of Water', 'movie', 2022, 75),
]

export const ENTRIES: IndexEntry[] = CATALOG.map(entryFromItem)

/**
 * Searches like TMDB does: every word typed has to start a word of the title
 * (case and accents ignored), so one wrong letter finds nothing.
 */
export function exactSearch(catalog: MediaItem[] = CATALOG) {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  return async (query: string) => {
    const split = (text: string) => fold(text).split(/[^a-z0-9]+/).filter(Boolean)
    const wordsTyped = split(query)
    return catalog.filter((item) => {
      const title = split(`${item.title} ${item.originalTitle ?? ''}`)
      return wordsTyped.length > 0 && wordsTyped.every((w) => title.some((t) => t.startsWith(w)))
    })
  }
}
