/**
 * Master switch for every ad on the site: the Monetag Multitag, the direct-link
 * ad (src/ads/adManager.ts), the "ad break" overlays and the TV ad slots.
 * Ads are ON. To switch them all off: set VITE_ADS_ENABLED=false in the Vercel
 * project's environment variables and redeploy.
 * The Monetag site verification tag in index.html stays either way.
 */
export const ADS_ENABLED: boolean = import.meta.env.VITE_ADS_ENABLED !== 'false'

/** The site-wide Monetag Multitag (it includes the Vignette). Loaded by src/ads/monetag.ts. */
export const MULTITAG = { zone: '302667', src: 'https://quge5.com/88/tag.min.js' } as const

/** The direct-link ad, opened in a new tab by src/ads/adManager.ts. */
export const DIRECT_LINK_URL = 'https://uplcm.com/4/12033849'

/** When the direct-link ad may open (src/ads/adManager.ts). */
export const AD_RULES = {
  /** At least this long between any two direct-link ads. */
  cooldownMs: 60_000,
  /** At most this many per visitor per day (midnight to midnight, Lagos time). */
  dailyCap: 8,
  /** A football match's Watch tab opens the ad again only after this long. */
  footballRepeatMs: 5 * 60_000,
  /** Search opens the ad on the first submit, then at most this often. */
  searchRepeatMs: 10 * 60_000,
} as const
