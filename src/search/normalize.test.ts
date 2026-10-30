import { describe, expect, it } from 'vitest'
import { ENTRIES } from './fixtures'
import { correctQuery, editDistance, normalize, queryVariants } from './normalize'
import { createTitleIndex } from './titleIndex'

const vocabulary = createTitleIndex(ENTRIES).vocabulary
const corrected = (query: string) => correctQuery(query, vocabulary)

describe('normalize', () => {
  it('lowercases and drops accents, punctuation and extra spaces', () => {
    expect(normalize('  Amélie ')).toBe('amelie')
    expect(normalize('Spider-Man: No   Way Home!')).toBe('spider man no way home')
    expect(normalize("Ocean's Eleven")).toBe('oceans eleven')
  })

  it('reads "&" as "and"', () => {
    expect(normalize('Fast & Furious')).toBe('fast and furious')
  })
})

describe('queryVariants', () => {
  it('cleans up the query and swaps numbers and words', () => {
    const variants = queryVariants('Toy Story Two')
    expect(variants).toContain('toy story 2')
    expect(queryVariants('toy story 2')).toContain('toy story two')
  })

  it('tries "part 2" as "2" and the other way round', () => {
    expect(queryVariants('deathly hallows part 2')).toContain('deathly hallows 2')
    expect(queryVariants('deathly hallows 2')).toContain('deathly hallows part 2')
  })

  it('tries "and" as "&"', () => {
    expect(queryVariants('fast and furious')).toContain('fast & furious')
  })

  it('tries the query minus its last word, and each word alone (common words skipped)', () => {
    const variants = queryVariants('money hiest')
    expect(variants).toContain('money')
    expect(variants).toContain('hiest')
    expect(queryVariants('the dark knight')).not.toContain('the')
  })

  it('never repeats what was typed', () => {
    expect(queryVariants('avatar')).toEqual([])
  })
})

describe('editDistance', () => {
  it('counts a swap of neighbouring letters as one edit', () => {
    expect(editDistance('hiest', 'heist')).toBe(1)
    expect(editDistance('avngers', 'avengers')).toBe(1)
    expect(editDistance('gme', 'game')).toBe(1)
    expect(editDistance('abc', 'xyz')).toBe(3)
  })

  it('stops early once past the limit', () => {
    expect(editDistance('a', 'abcdef', 2)).toBe(3)
  })
})

describe('correctQuery (spelling, from the titles we know)', () => {
  it.each([
    ['avngers', 'avengers'],
    ['Avngers', 'avengers'],
    ['spidr man', 'spider man'],
    ['squid gme', 'squid game'],
    ['money hiest', 'money heist'],
    ['anikualpo', 'anikulapo'],
    ['anikulapoo', 'anikulapo'],
    ['stranger thigns', 'stranger things'],
    ['breakin bad', 'breaking bad'],
    ['spiderman', 'spider man'],
  ])('"%s" → "%s"', (typo, fixed) => {
    expect(corrected(typo)).toBe(fixed)
  })

  it('ignores extra spaces and missing accents', () => {
    expect(corrected('  squid    gme  ')).toBe('squid game')
    // "amelie" is already right once accents are ignored.
    expect(corrected('amelie')).toBeNull()
  })

  it('leaves correct queries alone', () => {
    expect(corrected('squid game')).toBeNull()
    expect(corrected('toy story 2')).toBeNull()
  })
})
