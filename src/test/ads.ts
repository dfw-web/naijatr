import { vi } from 'vitest'

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
