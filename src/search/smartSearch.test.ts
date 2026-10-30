import { describe, expect, it, vi } from 'vitest'
import { CATALOG, ENTRIES, exactSearch } from './fixtures'
import { smartSearch } from './smartSearch'
import { createTitleIndex } from './titleIndex'

const index = createTitleIndex(ENTRIES)
const withIndex = async () => index
const run = (query: string, search = exactSearch()) => smartSearch(search, query, withIndex)
const titles = (result: { items: { title: string }[] }) => result.items.map((item) => item.title)

describe('smartSearch: typos', () => {
  it.each([
    ['avngers', 'Avengers'],
    ['spidr man', 'Spider Man'],
    ['squid gme', 'Squid Game'],
    ['money hiest', 'Money Heist'],
    ['anikualpo', 'Anikulapo'],
  ])('"%s" finds results, showing them for "%s"', async (typo, showing) => {
    const result = await run(typo)
    expect(result.exactCount).toBe(0)
    expect(result.showingFor).toBe(showing)
    expect(result.items.length).toBeGreaterThan(0)
  })

  it('puts the closest, then the most popular, title first', async () => {
    expect(titles(await run('avngers')).slice(0, 3)).toEqual(['Avengers: Endgame', 'Avengers: Infinity War', 'The Avengers'].sort((a, b) => {
      const pop = (t: string) => CATALOG.find((i) => i.title === t)!.popularity
      return pop(b) - pop(a)
    }))
    expect(titles(await run('squid gme'))[0]).toBe('Squid Game')
    expect(titles(await run('money hiest'))[0]).toBe('Money Heist')
    // The exact title is the closest match; the sequel is next.
    expect(titles(await run('spidr man')).slice(0, 2)).toEqual(['Spider-Man', 'Spider-Man: No Way Home'])
  })

  it('copes with extra spaces and missing accents', async () => {
    expect(titles(await run('   squid     gme   '))[0]).toBe('Squid Game')
    expect(titles(await run('amelie'))[0]).toBe('Amélie')
  })

  it('finds a title by its original name', async () => {
    expect(titles(await run('la casa de papl'))[0]).toBe('Money Heist')
  })
})

describe('smartSearch: flow', () => {
  it('stops after the search as typed when it finds 3 or more', async () => {
    const getIndex = vi.fn(withIndex)
    const result = await smartSearch(exactSearch(), 'avengers', getIndex)
    expect(result.exactCount).toBe(3)
    expect(result.showingFor).toBeNull()
    expect(getIndex).not.toHaveBeenCalled()
  })

  it('keeps exact matches first, then adds close ones, with no "showing results for"', async () => {
    const result = await run('furious')
    expect(result.exactCount).toBe(1)
    expect(titles(result)[0]).toBe('Furious 7')
    expect(result.showingFor).toBeNull()
  })

  it('tries cleaned-up variants in parallel ("part 2" → "2")', async () => {
    const search = vi.fn(exactSearch())
    const result = await smartSearch(search, 'toy story part two', async () => null)
    expect(search).toHaveBeenCalledWith('toy story part two', undefined)
    expect(search).toHaveBeenCalledWith('toy story 2', undefined)
    expect(titles(result)).toContain('Toy Story 2')
  })

  it('finds nothing when nothing is close', async () => {
    const result = await run('qqzzxx')
    expect(result.items).toEqual([])
    expect(result.showingFor).toBeNull()
  })

  it('still shows close titles from the index when the search itself fails', async () => {
    const failing = async () => {
      throw new Error('TMDB is down')
    }
    const result = await run('squid gme', failing)
    expect(titles(result)[0]).toBe('Squid Game')
  })

  it('reports the error when the search fails and nothing else is found', async () => {
    const failing = async () => {
      throw new Error('TMDB is down')
    }
    await expect(run('qqzzxx', failing)).rejects.toThrow('TMDB is down')
  })

  it('works without an index (cleaned-up variants only)', async () => {
    const result = await smartSearch(exactSearch(), 'Squid  Game!', async () => null)
    expect(titles(result)).toEqual(['Squid Game'])
  })
})
