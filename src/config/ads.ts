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
export const MULTITAG = { zone: '302667', src: 'https://quge5.com/88/tag.min.js', id: 'monetag-multitag-1' } as const

/**
 * A second Multitag, on test next to the first (both stay on). Same script
 * URL: each copy reads the zone from its own script element, so it gets its
 * own element and id, added once the first has loaded. To turn it off without
 * touching zone 302667: set MULTITAG_2_ENABLED=false on Vercel and redeploy.
 * (`enabled` comes from vite.config.ts; tests switch it.)
 */
export const MULTITAG_2 = {
  zone: '306795',
  src: 'https://quge5.com/88/tag.min.js',
  id: 'monetag-multitag-2',
  enabled: __MULTITAG_2_ENABLED__,
}

/** The direct-link ad, opened in a new tab by src/ads/adManager.ts. */
export const DIRECT_LINK_URL = 'https://uplcm.com/4/12033849'

/**
 * When the direct-link ad may open (src/ads/adManager.ts). Tune these here:
 * each trigger can be switched off on its own, and two safety limits hold for
 * all of them. Always, whatever is set here: nothing while a player is open
 * (so never on the player's own controls), nothing on the tap that opens or
 * closes a popup (sign-in, the Telegram gate, the invite and ad-free sheets),
 * nothing for ad-free accounts, and nothing on /admin, /account, /privacy,
 * /invite/rules or the password pages. Tests set their own.
 */
export const AD_RULES = {
  /** At least this long between any two direct-link ads (0: no gap). */
  cooldownMs: 30_000,
  /** At most this many per visitor per day, midnight to midnight Lagos time (Infinity: no cap). */
  dailyCap: 20,
  /** Which taps may open the ad. */
  triggers: {
    /** A title's card (or View Details), every time. */
    card: true,
    /** Play, every time (not just the first per title). */
    play: true,
    /** A football match's Watch. */
    football: true,
    /** A search submitted. */
    search: true,
    /** A Continue Watching card, or a title in My List. */
    list: true,
    /** Picking another season or episode (before Play: never while a player is open). */
    episode: true,
    /** Picking Server 1 / Server 2 (before Play: never while a player is open). */
    server: true,
  },
  /** Cards and Play open the ad only the first time per title each visit. */
  oncePerTitle: false,
  /** A football match's Watch tab opens the ad again only after this long (0: every time). */
  footballRepeatMs: 0,
  /** Search opens the ad again only after this long (0: every search). */
  searchRepeatMs: 0,
}

/**
 * The "Too many ads?" banner (src/ads/AdUpsell.tsx): after every `every`th
 * direct-link ad of the day, at most `perDay` times a day.
 */
export const AD_UPSELL = { every: 5, perDay: 2 }

/**
 * When the ad settings above last changed, for the before/after marker on
 * /admin/live. Update it with every change to AD_RULES.
 */
export const AD_LEVEL = {
  changedAt: '2026-11-06T18:30:00Z',
  summary: 'Every card, Play, football Watch, search, list item, episode and server pick; 30 s apart, 20 a day',
}
