import { vi } from 'vitest'
import { AD_RULES } from '../config/ads'

/** The ad links clicked so far (see setup.ts), as [href, target, rel]. */
export const adLinkClicks = () =>
  vi
    .mocked(HTMLAnchorElement.prototype.click)
    .mock.contexts.filter((link) => (link as HTMLAnchorElement).dataset.adLink !== undefined)
    .map((link) => {
      const { href, target, rel } = link as HTMLAnchorElement
      return [href, target, rel]
    })

export const AD_LINK = ['https://uplcm.com/4/12033849', '_blank', 'noopener noreferrer']

/** The limits the direct-link ad used to have (the site ships without any); tests of the limits set them. */
export const LIMITED_AD_RULES = {
  cooldownMs: 60_000,
  dailyCap: 8,
  oncePerTitle: true,
  footballRepeatMs: 5 * 60_000,
  searchRepeatMs: 10 * 60_000,
}

/** Puts those limits on for the current test (setup.ts takes them off again). */
export const useLimitedAdRules = () => void Object.assign(AD_RULES, LIMITED_AD_RULES)
