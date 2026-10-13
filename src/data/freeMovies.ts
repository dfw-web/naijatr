import type { MediaItem } from '../types/media'

/**
 * Full movies that are legal to stream for free: US public-domain films hosted
 * by the Internet Archive (played in its official embed player) and Blender
 * Foundation open movies (Creative Commons, played as direct video files).
 */
export type FreeSource =
  | { kind: 'archive'; identifier: string }
  | { kind: 'file'; url: string; mimeType: 'video/mp4' | 'video/webm' | 'video/quicktime' }

export interface FreeMovie {
  id: string
  title: string
  year: number
  /** TMDB movie id, when matched. */
  tmdbId?: number
  genres: string[]
  description: string
  license: 'Public domain' | 'CC BY 3.0' | 'CC BY 4.0'
  source: FreeSource
}

// UNVERIFIED: identifiers, URLs and TMDB ids have not been checked online yet.
// Confirm each loads (archive.org/metadata/{id}, a HEAD request for files) before shipping.
export const FREE_MOVIES: readonly FreeMovie[] = [
  {
    id: 'night-of-the-living-dead',
    title: 'Night of the Living Dead',
    year: 1968,
    tmdbId: 10331,
    genres: ['Horror'],
    description:
      'Strangers take shelter in a rural farmhouse as the recently dead rise and lay siege to it.',
    license: 'Public domain',
    source: { kind: 'archive', identifier: 'night_of_the_living_dead' },
  },
  {
    id: 'his-girl-friday',
    title: 'His Girl Friday',
    year: 1940,
    tmdbId: 3085,
    genres: ['Comedy', 'Romance'],
    description:
      'A newspaper editor schemes to keep his star reporter, and ex-wife, from remarrying.',
    license: 'Public domain',
    source: { kind: 'archive', identifier: 'his_girl_friday' },
  },
  {
    id: 'plan-9-from-outer-space',
    title: 'Plan 9 from Outer Space',
    year: 1959,
    tmdbId: 10513,
    genres: ['Science Fiction', 'Horror'],
    description: 'Aliens resurrect the dead to stop humanity from building a doomsday weapon.',
    license: 'Public domain',
    source: { kind: 'archive', identifier: 'Plan_9_from_Outer_Space_1959' },
  },
  {
    id: 'the-kid',
    title: 'The Kid',
    year: 1921,
    tmdbId: 10098,
    genres: ['Comedy', 'Drama'],
    description: 'The Tramp raises an abandoned child, until the authorities come to take him away.',
    license: 'Public domain',
    source: { kind: 'archive', identifier: 'TheKid_201502' },
  },
  {
    id: 'sherlock-jr',
    title: 'Sherlock Jr.',
    year: 1924,
    tmdbId: 992,
    genres: ['Comedy'],
    description: 'A projectionist who dreams of being a detective walks into the film he is showing.',
    license: 'Public domain',
    source: { kind: 'archive', identifier: 'SherlockJr' },
  },
  {
    id: 'big-buck-bunny',
    title: 'Big Buck Bunny',
    year: 2008,
    tmdbId: 10378,
    genres: ['Animation', 'Comedy'],
    description: 'A giant, gentle rabbit takes comic revenge on three bullying rodents.',
    license: 'CC BY 3.0',
    source: {
      kind: 'file',
      url: 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4',
      mimeType: 'video/mp4',
    },
  },
  {
    id: 'sintel',
    title: 'Sintel',
    year: 2010,
    tmdbId: 45745,
    genres: ['Animation', 'Fantasy'],
    description: 'A lonely young woman searches the world for the baby dragon she once rescued.',
    license: 'CC BY 3.0',
    source: {
      kind: 'file',
      url: 'https://download.blender.org/durian/movies/Sintel.2010.720p.mkv',
      mimeType: 'video/webm',
    },
  },
  {
    id: 'tears-of-steel',
    title: 'Tears of Steel',
    year: 2012,
    tmdbId: 133701,
    genres: ['Science Fiction'],
    description: 'In a future Amsterdam, scientists try to save the world from robots by replaying a breakup.',
    license: 'CC BY 3.0',
    source: {
      kind: 'file',
      url: 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov',
      mimeType: 'video/quicktime',
    },
  },
]

/** The URL a source plays from. */
export function freeSourceUrl(source: FreeSource): string {
  return source.kind === 'archive'
    ? `https://archive.org/embed/${encodeURIComponent(source.identifier)}`
    : source.url
}

const normalise = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The legal full copy of a movie, matched by TMDB id, else by title and year. */
export function findFreeMovie(item: MediaItem): FreeMovie | undefined {
  if (item.type !== 'movie') return undefined
  if (item.tmdbId !== undefined) {
    const byId = FREE_MOVIES.find((m) => m.tmdbId === item.tmdbId)
    if (byId) return byId
  }
  return FREE_MOVIES.find((m) => normalise(m.title) === normalise(item.title) && m.year === item.year)
}

/** Catalogue item for the homepage "Watch Free" row. Artwork is filled in from TMDB details. */
export function freeMovieToItem(movie: FreeMovie): MediaItem {
  return {
    id: `free-${movie.id}`,
    tmdbId: movie.tmdbId,
    title: movie.title,
    type: 'movie',
    year: movie.year,
    releaseDate: null,
    genres: movie.genres,
    score: 0,
    voteCount: 0,
    popularity: 0,
    description: movie.description,
    poster:
      movie.source.kind === 'archive'
        ? `https://archive.org/services/img/${encodeURIComponent(movie.source.identifier)}`
        : null,
    backdrop: null,
  }
}

export const freeMovieItems: MediaItem[] = FREE_MOVIES.map(freeMovieToItem)
