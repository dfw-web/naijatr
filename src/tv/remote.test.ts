import { describe, expect, it } from 'vitest'
import { pickNext, type Box } from './remote'

const box = (left: number, top: number, width = 100, height = 150): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
})

// Two rows of cards, the second scrolled a little to the right, plus a navbar button above.
const nav = box(400, 0, 120, 40)
const row1 = [box(0, 100), box(120, 100), box(240, 100), box(360, 100)]
const row2 = [box(50, 300), box(170, 300), box(290, 300), box(410, 300)]
const all = [nav, ...row1, ...row2]

describe('pickNext (spatial navigation)', () => {
  it('moves to the neighbour in the same row', () => {
    expect(all[pickNext(row1[1], all, 'right')]).toBe(row1[2])
    expect(all[pickNext(row1[1], all, 'left')]).toBe(row1[0])
  })

  it('moves down to the card below that lines up best, not the nearest corner', () => {
    expect(all[pickNext(row1[1], all, 'down')]).toBe(row2[1])
    expect(all[pickNext(row2[3], all, 'up')]).toBe(row1[3])
  })

  it('goes from the bottom row up through the top row to the navbar', () => {
    expect(all[pickNext(row1[3], all, 'up')]).toBe(nav)
  })

  it('finds nothing past the edge', () => {
    expect(pickNext(row1[0], all, 'left')).toBe(-1)
    expect(pickNext(row2[2], all, 'down')).toBe(-1)
  })

  it('ignores items behind it and the item itself', () => {
    expect(pickNext(row1[3], [row1[3], row1[0]], 'right')).toBe(-1)
  })
})
