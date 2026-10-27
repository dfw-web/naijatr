import { describe, expect, it } from 'vitest'
import { AD_LINK, adLinkClicks } from '../test/ads'
import { adsDisabled, openAd } from './directLink'

describe('adsDisabled', () => {
  it('is off on the live site and on test visits with ?noads=1', () => {
    expect(adsDisabled('https://www.naijatr.com/#/movies')).toBe(false)
    expect(adsDisabled('https://www.naijatr.com/#/movies?noads=1')).toBe(true)
    // Remembered for the rest of the visit, until ?noads=0.
    expect(adsDisabled('https://www.naijatr.com/')).toBe(true)
    expect(adsDisabled('https://www.naijatr.com/?noads=0')).toBe(false)
    expect(adsDisabled('https://www.naijatr.com/')).toBe(false)
  })

  it('is off on the admin pages, the contest rules and the claim form', () => {
    for (const path of ['/admin/live', '/admin/', '/admin', '/challenge/rules', '/challenge/claim/']) {
      expect(adsDisabled(`https://www.naijatr.com${path}`)).toBe(true)
    }
    for (const path of ['/', '/football', '/challenge', '/administrator']) {
      expect(adsDisabled(`https://www.naijatr.com${path}`)).toBe(false)
    }
  })
})

describe('openAd', () => {
  it('opens once per tap, even when the capture and bubble handlers both call it', () => {
    const tap = new MouseEvent('click')
    expect(openAd(tap, 'title:movie:1')).toBe(true)
    expect(openAd(tap, 'title:movie:1')).toBe(false)
    expect(adLinkClicks()).toEqual([AD_LINK])
    expect(openAd(new MouseEvent('click'), 'title:movie:1')).toBe(true)
    expect(adLinkClicks()).toHaveLength(2)
  })
})
