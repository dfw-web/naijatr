import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../types/media'
import {
  CONTINUE_KEY,
  CONTINUE_LIMIT,
  episodeLabel,
  finishEntry,
  nextEpisodeOf,
  readContinueWatching,
  recordPlay,
  recordProgress,
  removeEntry,
} from './continueWatching'

const title = (id: number, type: MediaItem['type'] = 'movie', extra: Partial<MediaItem> = {}): MediaItem => ({
  id: `tmdb-${type}-${id}`,
  tmdbId: id,
  title: `Title ${id}`,
  type,
  year: 2020,
  releaseDate: null,
  genres: [],
  score: 7,
  voteCount: 10,
  popularity: 1,
  description: '',
  poster: `https://image.tmdb.org/t/p/w500/p${id}.jpg`,
  backdrop: `https://image.tmdb.org/t/p/w1280/b${id}.jpg`,
  ...extra,
})

const show = title(1399, 'series', {
  seasons: [
    { number: 1, name: 'Season 1', episodeCount: 2 },
    { number: 2, name: 'Season 2', episodeCount: 3 },
  ],
})

const ids = () => readContinueWatching().map((e) => e.id)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  // TMDB episode details, through /api/tmdb.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const match = /season\/(\d+)\/episode\/(\d+)/.exec(url)
      return match
        ? new Response(JSON.stringify({ name: `Episode ${match[2]}`, still_path: `/s${match[1]}e${match[2]}.jpg` }))
        : new Response('{}', { status: 404 })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('ordering', () => {
  it('puts the most recently watched first, and moves a title to the front when played again', () => {
    recordPlay(title(1), {}, 1000)
    recordPlay(title(2), {}, 2000)
    recordPlay(title(3), {}, 3000)
    expect(ids()).toEqual(['tmdb-movie-3', 'tmdb-movie-2', 'tmdb-movie-1'])
    recordPlay(title(1), {}, 4000)
    expect(ids()).toEqual(['tmdb-movie-1', 'tmdb-movie-3', 'tmdb-movie-2'])
  })

  it('keeps one card per series, for the episode being watched', () => {
    recordPlay(show, { season: 1, episode: 1 }, 1000)
    recordPlay(title(5), {}, 2000)
    recordPlay(show, { season: 2, episode: 3 }, 3000)
    const list = readContinueWatching()
    expect(list.map((e) => e.id)).toEqual(['tmdb-series-1399', 'tmdb-movie-5'])
    expect(list[0]).toMatchObject({ type: 'tv', tmdbId: 1399, season: 2, episode: 3 })
  })

  it(`keeps at most ${CONTINUE_LIMIT}, dropping the oldest`, () => {
    for (let i = 1; i <= CONTINUE_LIMIT + 3; i++) recordPlay(title(i), {}, i * 1000)
    expect(ids()).toHaveLength(CONTINUE_LIMIT)
    expect(ids()).not.toContain('tmdb-movie-1')
    expect(ids()).not.toContain('tmdb-movie-3')
    expect(ids()[0]).toBe(`tmdb-movie-${CONTINUE_LIMIT + 3}`)
  })
})

describe('progress', () => {
  it('saves the position, and keeps it when the same episode is played again', () => {
    recordPlay(title(1), {}, 1000)
    recordProgress('tmdb-movie-1', {}, 600, 6000, 2000)
    expect(readContinueWatching()[0]).toMatchObject({ progressSeconds: 600, durationSeconds: 6000, lastWatchedAt: 2000 })
    recordPlay(title(1), {}, 3000)
    expect(readContinueWatching()[0]).toMatchObject({ progressSeconds: 600, durationSeconds: 6000 })
  })

  it('starts the progress over on a different episode', () => {
    recordPlay(show, { season: 1, episode: 1 }, 1000)
    recordProgress(show.id, { season: 1, episode: 1 }, 300, 2400, 2000)
    recordPlay(show, { season: 1, episode: 2 }, 3000)
    expect(readContinueWatching()[0]).toMatchObject({ episode: 2, progressSeconds: null })
  })

  it('removes a movie once 90% is watched', () => {
    recordPlay(title(1), {}, 1000)
    recordProgress('tmdb-movie-1', {}, 5300, 6000, 2000)
    expect(ids()).toEqual(['tmdb-movie-1'])
    recordProgress('tmdb-movie-1', {}, 5400, 6000, 3000)
    expect(ids()).toEqual([])
    // The player's last updates don't bring it back.
    recordProgress('tmdb-movie-1', {}, 5500, 6000, 4000)
    expect(ids()).toEqual([])
  })

  it('ignores updates for an episode the card has moved past', () => {
    recordPlay(show, { season: 1, episode: 1 }, 1000)
    finishEntry(show.id, { season: 1, episode: 1 }, 2000)
    recordProgress(show.id, { season: 1, episode: 1 }, 100, 2400, 3000)
    expect(readContinueWatching()[0]).toMatchObject({ season: 1, episode: 2, progressSeconds: null })
  })
})

describe('next episode', () => {
  it('works out the next episode, the next season, or the end', () => {
    expect(nextEpisodeOf(show.seasons!, 1, 1)).toEqual({ season: 1, episode: 2 })
    expect(nextEpisodeOf(show.seasons!, 1, 2)).toEqual({ season: 2, episode: 1 })
    expect(nextEpisodeOf(show.seasons!, 2, 3)).toBeNull()
    // Season sizes unknown: the next number, and the player says if it exists.
    expect(nextEpisodeOf([], 4, 7)).toEqual({ season: 4, episode: 8 })
  })

  it('moves the card on at 90%, and on "ended", with the next episode\'s title and still', async () => {
    recordPlay(show, { season: 1, episode: 2 }, 1000)
    recordProgress(show.id, { season: 1, episode: 2 }, 2200, 2400, 2000)
    let [entry] = readContinueWatching()
    expect(entry).toMatchObject({ season: 2, episode: 1, progressSeconds: null, lastWatchedAt: 2000 })
    await flush()
    ;[entry] = readContinueWatching()
    expect(entry.episodeTitle).toBe('Episode 1')
    expect(entry.still).toBe('https://image.tmdb.org/t/p/w780/s2e1.jpg')
    expect(episodeLabel(entry)).toBe('S2 · E1 – Episode 1')

    finishEntry(show.id, { season: 2, episode: 1 }, 3000)
    expect(readContinueWatching()[0]).toMatchObject({ season: 2, episode: 2 })
  })

  it('removes the series after its last episode', () => {
    recordPlay(show, { season: 2, episode: 3 }, 1000)
    finishEntry(show.id, { season: 2, episode: 3 }, 2000)
    expect(ids()).toEqual([])
  })
})

describe('removal and storage', () => {
  it('removes a card with ✕', () => {
    recordPlay(title(1), {}, 1000)
    recordPlay(title(2), {}, 2000)
    removeEntry('tmdb-movie-2')
    expect(ids()).toEqual(['tmdb-movie-1'])
  })

  it('never breaks the page when storage is broken or blocked', () => {
    localStorage.setItem(CONTINUE_KEY, '{not json')
    expect(readContinueWatching()).toEqual([])
    localStorage.setItem(CONTINUE_KEY, JSON.stringify([{ id: 1 }, null, 'x']))
    expect(readContinueWatching()).toEqual([])

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      expect(readContinueWatching()).toEqual([])
      expect(() => recordPlay(title(1))).not.toThrow()
      expect(() => recordProgress('tmdb-movie-1', {}, 10, 100)).not.toThrow()
      expect(() => removeEntry('tmdb-movie-1')).not.toThrow()
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})
