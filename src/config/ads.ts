/**
 * Master switch for every ad on the site: the Monetag tags (Vignette, In-Page
 * Push), the direct-link ad on cards and match tabs, the "ad break" overlays and
 * the TV ad slots. Ads are OFF for now.
 *
 * To turn them back on: set VITE_ADS_ENABLED=true in the Vercel project's
 * environment variables and redeploy (or in .env.local for a local build).
 * The Monetag site verification tag in index.html stays either way.
 */
export const ADS_ENABLED: boolean = import.meta.env.VITE_ADS_ENABLED === 'true'

export interface MonetagTag {
  /** Monetag zone id. */
  zone: string
  /** The zone's script URL, from the zone's code in the Monetag dashboard. */
  src: string
}

/** Site-wide Monetag tags, loaded by loadMonetagTags() only while ADS_ENABLED is true. */
export const MONETAG_TAGS: readonly MonetagTag[] = [
  { zone: '12033043', src: 'https://nap5k.com/tag.min.js' }, // In-Page Push
  { zone: '12033047', src: 'https://n6wxm.com/vignette.min.js' }, // Vignette
  { zone: '12038439', src: 'https://n6wxm.com/vignette.min.js' }, // Vignette
]
