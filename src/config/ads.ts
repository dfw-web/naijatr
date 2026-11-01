/**
 * Master switch for every ad on the site: the Monetag Multitag, the direct-link
 * ad (src/ads/adManager.ts), the "ad break" overlays and the TV ad slots.
 * Ads are ON, on the movie pages and football alike. To switch them all off:
 * set VITE_ADS_ENABLED=false in the Vercel project's environment variables and
 * redeploy.
 * The Monetag site verification tag in index.html stays either way.
 */
export const ADS_ENABLED: boolean = import.meta.env.VITE_ADS_ENABLED !== 'false'

/**
 * Which sections show ads: the movie section (the home page, movies, series,
 * search and the player) and football. Set one to false to take its Multitag,
 * direct-link ads and TV ad break away. (Tests switch it.)
 */
export const AD_SECTIONS = { movies: true, football: true }

/** The site-wide Monetag Multitag (it includes the Vignette). Loaded by src/ads/monetag.ts. */
export const MULTITAG = { zone: '302667', src: 'https://quge5.com/88/tag.min.js' } as const

/** The direct-link ad, opened in a new tab by src/ads/adManager.ts. */
export const DIRECT_LINK_URL = 'https://uplcm.com/4/12033849'

/**
 * When the direct-link ad may open (src/ads/adManager.ts). No limits: an ad on
 * every card tap, every Play, every search and every football Watch, with no
 * gap and no daily maximum. (It still never opens while a player is open, or on
 * the tap that opens or closes a popup.) To bring limits back, set e.g.
 * cooldownMs: 60_000, dailyCap: 8, oncePerTitle: true, footballRepeatMs: 5 * 60_000,
 * searchRepeatMs: 10 * 60_000. Tests set their own.
 */
export const AD_RULES = {
  /** At least this long between any two direct-link ads (0: no gap). */
  cooldownMs: 0,
  /** At most this many per visitor per day, midnight to midnight Lagos time (Infinity: no cap). */
  dailyCap: Infinity,
  /** Cards and Play open the ad only the first time per title each visit. */
  oncePerTitle: false,
  /** A football match's Watch tab opens the ad again only after this long (0: every time). */
  footballRepeatMs: 0,
  /** Search opens the ad again only after this long (0: every search). */
  searchRepeatMs: 0,
}
