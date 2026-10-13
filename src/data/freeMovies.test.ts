import { describe, expect, it } from 'vitest'
import { FREE_MOVIES, findFreeMovie, freeMovieItems, freeSourceUrl } from './freeMovies'

describe('free movie catalogue', () => {
  it('has unique ids and TMDB ids, and only https sources', () => {
    expect(new Set(FREE_MOVIES.map((m) => m.id)).size).toBe(FREE_MOVIES.length)
    const tmdbIds = FREE_MOVIES.flatMap((m) => m.tmdbId ?? [])
    expect(new Set(tmdbIds).size).toBe(tmdbIds.length)
    for (const movie of FREE_MOVIES) expect(freeSourceUrl(movie.source)).toMatch(/^https:\/\//)
  })

  it('uses the official archive.org embed player for Internet Archive films', () => {
    expect(freeSourceUrl({ kind: 'archive', identifier: 'his_girl_friday' })).toBe(
      'https://archive.org/embed/his_girl_friday',
    )
  })

  it('matches movies by TMDB id, then by title and year, never series', () => {
    const [item] = freeMovieItems
    expect(findFreeMovie({ ...item, id: 'x', title: 'Renamed' })?.id).toBe(FREE_MOVIES[0].id)
    expect(
      findFreeMovie({ ...item, tmdbId: undefined, title: 'night of the LIVING dead!' }),
    ).toBeDefined()
    expect(findFreeMovie({ ...item, tmdbId: undefined, year: 1990 })).toBeUndefined()
    expect(findFreeMovie({ ...item, type: 'series' })).toBeUndefined()
  })
})
