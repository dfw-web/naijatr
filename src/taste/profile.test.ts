import { afterEach, describe, expect, it } from 'vitest'
import type { MediaItem } from '../types/media'
import {
  applyPicks,
  applySignal,
  attributeScores,
  attributesOf,
  categoriesOf,
  COLD_START_SCORE,
  emptyProfile,
  HALF_LIFE_MS,
  isColdStart,
  MAX_ATTRIBUTES,
  readTaste,
  recordTaste,
  resetTaste,
  TASTE_KEY,
  tasteScore,
} from './profile'
import { dedupeRows, interleave, planPersonalHome, rankByTaste, seedTitles, varietySize } from './personalHome'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 21)

const title = (id: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  title: id,
  type: 'series',
  year: 2024,
  releaseDate: null,
  genres: [],
  score: 8,
  voteCount: 100,
  popularity: 10,
  description: '',
  poster: null,
  backdrop: null,
  ...extra,
})

const anime = (id: string, tmdbId = 1) =>
  title(id, { tmdbId, genreIds: [16, 10759], originCountry: ['JP'], originalLanguage: 'ja', keywordIds: [1, 2, 3, 4, 5, 6] })
const kdrama = (id: string, tmdbId = 2) => title(id, { tmdbId, genreIds: [18], originCountry: ['KR'], originalLanguage: 'ko' })

afterEach(() => window.localStorage.clear())

describe('taste attributes', () => {
  it('derives the categories', () => {
    expect(categoriesOf(anime('a'))).toEqual(['anime'])
    expect(categoriesOf(kdrama('k'))).toEqual(['kdrama'])
    expect(categoriesOf(title('n', { type: 'movie', originCountry: ['NG'] }))).toEqual(['nollywood'])
    expect(categoriesOf(title('b', { type: 'movie', originCountry: ['IN'], originalLanguage: 'hi' }))).toEqual(['bollywood'])
    // Japanese live action is a J-drama, not anime.
    expect(categoriesOf(title('j', { genreIds: [18], originCountry: ['JP'], originalLanguage: 'ja' }))).toEqual(['jdrama'])
    expect(categoriesOf(title('c', { originCountry: ['TW'] }))).toEqual(['cdrama'])
  })

  it('uses type, genres, country, language, up to 5 keywords and categories', () => {
    expect(attributesOf(anime('a'))).toEqual(['t:tv', 'g:16', 'g:10759', 'c:JP', 'l:ja', 'k:1', 'k:2', 'k:3', 'k:4', 'k:5', 'cat:anime'])
  })
})

describe('scoring', () => {
  it('adds each signal weight to every attribute of the title', () => {
    let p = applySignal(emptyProfile(), anime('a'), 'open', NOW)
    p = applySignal(p, anime('a'), 'play', NOW)
    p = applySignal(p, anime('a'), 'watched', NOW)
    const scores = attributeScores(p, NOW)
    expect(scores.get('cat:anime')).toBe(9)
    expect(scores.get('l:ja')).toBe(9)
    expect(p.titles[0]).toMatchObject({ id: 'a', plays: 1, finishedAt: NOW })
  })

  it('takes points off for leaving early, removing and not interested', () => {
    let p = applySignal(emptyProfile(), kdrama('k'), 'play', NOW)
    p = applySignal(p, kdrama('k'), 'left', NOW)
    expect(attributeScores(p, NOW).get('cat:kdrama')).toBe(1)
    p = applySignal(p, kdrama('k'), 'removed', NOW)
    p = applySignal(p, kdrama('k'), 'notInterested', NOW)
    expect(attributeScores(p, NOW).get('cat:kdrama')).toBe(-7)
    expect(p.hidden).toEqual(['k'])
  })

  it('keeps the attributes a title had before (keywords from its details page)', () => {
    let p = applySignal(emptyProfile(), anime('a'), 'open', NOW)
    p = applySignal(p, { id: 'a', title: 'a', type: 'series' }, 'removed', NOW)
    expect(attributeScores(p, NOW).get('k:1')).toBe(-2)
  })

  it('ranks titles by how well they match', () => {
    const p = applySignal(emptyProfile(), anime('a'), 'watched', NOW)
    const scores = attributeScores(p, NOW)
    expect(tasteScore(scores, anime('b'))).toBeGreaterThan(tasteScore(scores, kdrama('k')))
    // TMDB's own order breaks the tie between the two anime.
    const ranked = rankByTaste([[kdrama('k'), anime('b')], [anime('c')]], scores)
    expect(ranked.map((i) => i.id)).toEqual(['c', 'b', 'k'])
  })

  it('ranks a title in both recommendations and similar higher', () => {
    const ranked = rankByTaste([[title('x'), title('y')], [title('y')]], new Map())
    expect(ranked[0].id).toBe('y')
  })
})

describe('decay', () => {
  it('halves every 14 days', () => {
    const p = applySignal(emptyProfile(), anime('a'), 'watched', NOW)
    expect(attributeScores(p, NOW + HALF_LIFE_MS).get('cat:anime')).toBeCloseTo(2.5)
    expect(attributeScores(p, NOW + 2 * HALF_LIFE_MS).get('cat:anime')).toBeCloseTo(1.25)
  })

  it('lets a new taste overtake an old one', () => {
    let p = applySignal(emptyProfile(), anime('a'), 'watched', NOW)
    p = applySignal(p, anime('a'), 'watched', NOW)
    p = applySignal(p, kdrama('k'), 'watched', NOW + 30 * DAY)
    const scores = attributeScores(p, NOW + 30 * DAY)
    expect(scores.get('cat:kdrama')!).toBeGreaterThan(scores.get('cat:anime')!)
  })

  it('keeps only the strongest 30 attributes', () => {
    let p = emptyProfile()
    for (let i = 0; i < 20; i += 1) p = applySignal(p, title(`t${i}`, { genreIds: [i * 2, i * 2 + 1], keywordIds: [100 + i] }), 'open', NOW)
    p = applySignal(p, anime('a'), 'watched', NOW)
    expect(Object.keys(p.attrs)).toHaveLength(MAX_ATTRIBUTES)
    expect(p.attrs['cat:anime']).toBeDefined()
  })
})

describe('cold start', () => {
  it('is cold until one attribute reaches the threshold', () => {
    expect(isColdStart(emptyProfile(), NOW)).toBe(true)
    let p = applySignal(emptyProfile(), kdrama('k'), 'play', NOW)
    expect(isColdStart(p, NOW)).toBe(true)
    expect(planPersonalHome(p, NOW)).toBeNull()
    p = applySignal(p, kdrama('k'), 'open', NOW)
    expect(attributeScores(p, NOW).get('t:tv')).toBe(COLD_START_SCORE)
    expect(isColdStart(p, NOW)).toBe(false)
  })

  it('goes cold again as old history fades', () => {
    const p = applySignal(emptyProfile(), anime('a'), 'watched', NOW)
    expect(isColdStart(p, NOW)).toBe(false)
    expect(isColdStart(p, NOW + HALF_LIFE_MS)).toBe(true)
  })

  it('is warmed by a single "What do you like?" pick, for a few days', () => {
    const p = applyPicks(emptyProfile(), ['Anime'], NOW)
    expect(isColdStart(p, NOW)).toBe(false)
    expect(isColdStart(p, NOW + 4 * DAY)).toBe(false)
    expect(isColdStart(p, NOW + 5 * DAY)).toBe(true)
    expect(p.asked).toBe(true)
    const plan = planPersonalHome(p, NOW)!
    expect(plan.top.map((r) => r.id)).toEqual(['picked-for-you'])
    expect(plan.top[0].requests[0].params).toMatchObject({ with_genres: '16', with_original_language: 'ja' })
  })
})

describe('the personal home plan', () => {
  const heavyAnime = () => {
    let p = emptyProfile()
    // Finished a1, a2, a3 in turn, then played a2 again.
    for (const [i, id] of ['a1', 'a2', 'a3'].entries()) {
      p = applySignal(p, anime(id, i + 1), 'play', NOW + i)
      p = applySignal(p, anime(id, i + 1), 'watched', NOW + i)
    }
    return applySignal(p, anime('a2', 2), 'play', NOW + 3)
  }

  it('follows the latest finished and the most played', () => {
    expect(seedTitles(heavyAnime()).map((t) => t.id)).toEqual(['a3', 'a2'])
  })

  it('plans More like, Picked for you, the anime row and something different', () => {
    const plan = planPersonalHome(heavyAnime(), NOW + 3)!
    expect(plan.top.map((r) => r.kind)).toEqual(['more-like', 'more-like', 'picked', 'category'])
    expect(plan.top[0].title).toMatch(/^(More like|Since you enjoyed) a3$/)
    expect(plan.top[0].requests.map((r) => r.path)).toEqual(['/tv/3/recommendations', '/tv/3/similar'])
    expect(plan.top[3].title).toBe("Anime you'll love")
    expect(plan.variety?.requests).toHaveLength(2)
    expect(plan.variety?.requests.some((r) => r.params.with_genres === '16')).toBe(false)
    // Watched titles are never suggested.
    expect([...plan.exclude].sort()).toEqual(['a1', 'a2', 'a3'])
  })

  it('shows a category row only when its score is clearly high', () => {
    const p = applySignal(heavyAnime(), kdrama('k'), 'open', NOW + 3)
    const plan = planPersonalHome(p, NOW + 3)!
    expect(plan.top.filter((r) => r.kind === 'category').map((r) => r.id)).toEqual(['category-anime'])
  })
})

describe('de-duplication', () => {
  const rows = (lists: Record<string, string[]>) =>
    Object.entries(lists).map(([id, ids]) => ({ id, items: ids.map((i) => title(i)) }))
  const ids = (out: { id: string; items: MediaItem[] }[]) => Object.fromEntries(out.map((r) => [r.id, r.items.map((i) => i.id)]))

  it('never shows a title in two rows, nor anything excluded', () => {
    const out = dedupeRows(rows({ a: ['1', '2', '3'], b: ['2', '4', 'w'], c: ['1', '4', '5'] }), new Set(['w']))
    expect(ids(out)).toEqual({ a: ['1', '2', '3'], b: ['4'], c: ['5'] })
  })

  it('keeps the Trending chart whole, and takes its titles out of the other rows', () => {
    const out = dedupeRows(rows({ picked: ['1', '2'], trending: ['2', '3'], rest: ['3', '4'] }), new Set(), new Set(['trending']))
    expect(ids(out)).toEqual({ picked: ['1'], trending: ['2', '3'], rest: ['4'] })
  })

  it('takes turns for the variety row, about 1 in 5 of the personal titles', () => {
    expect(interleave([[title('a1'), title('a2')], [title('b1')]], 3).map((i) => i.id)).toEqual(['a1', 'b1', 'a2'])
    expect(varietySize(60)).toBe(15)
    expect(varietySize(4)).toBe(6)
  })
})

describe('storage', () => {
  it('saves to localStorage and resets', () => {
    recordTaste(anime('a'), 'watched')
    expect(JSON.parse(window.localStorage.getItem(TASTE_KEY)!).titles[0].id).toBe('a')
    resetTaste()
    expect(readTaste().titles).toEqual([])
    expect(readTaste().asked).toBe(true)
  })

  it('never throws on bad data', () => {
    window.localStorage.setItem(TASTE_KEY, '{nope')
    expect(readTaste().titles).toEqual([])
    expect(() => recordTaste(anime('a'), 'open')).not.toThrow()
  })
})
