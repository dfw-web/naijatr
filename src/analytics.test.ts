import { describe, expect, it } from 'vitest'
import { hashRouteAsPath } from './analytics'

const send = (url: string) => hashRouteAsPath({ type: 'pageview', url })?.url

describe('hashRouteAsPath', () => {
  it('reports the hash route as the path, keeping filters', () => {
    expect(send('https://www.naijatr.com/#/movies')).toBe('https://www.naijatr.com/movies')
    expect(send('https://www.naijatr.com/#/series')).toBe('https://www.naijatr.com/series')
    expect(send('https://www.naijatr.com/?genre=comedy&industry=nollywood#/movies')).toBe(
      'https://www.naijatr.com/movies?genre=comedy&industry=nollywood',
    )
  })

  it('leaves URLs without a hash route alone', () => {
    expect(send('https://www.naijatr.com/')).toBe('https://www.naijatr.com/')
    expect(send('https://www.naijatr.com/football')).toBe('https://www.naijatr.com/football')
    expect(send('https://www.naijatr.com/#top')).toBe('https://www.naijatr.com/#top')
  })
})
