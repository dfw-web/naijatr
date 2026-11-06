/**
 * The film and episode players, in the order the viewer sees them: the first
 * is "Server 1", the next "Server 2". Move an entry up or down to reorder
 * them, or set `enabled: false` to take one away. Labels follow the order.
 *
 * - nextstream:  the NextStream page behind /api/play (needs NEXTSTREAM_* on Vercel);
 * - embedmaster: embedmaster.link, played straight from the page. Needs
 *   VITE_EMBEDMASTER_PLAYER_ID; the player is domain-locked to www.naijatr.com,
 *   so on localhost it won't start.
 *
 * Each account gets one of them: free accounts Server 1, ad-free accounts
 * Server 2 (src/utils/playerServer.ts).
 */
export type PlayerServerId = 'nextstream' | 'embedmaster'

export const PLAYER_SERVERS: { id: PlayerServerId; enabled: boolean }[] = [
  { id: 'nextstream', enabled: true },
  { id: 'embedmaster', enabled: true },
]

/** A film or episode left in a hidden tab (or app) this long is closed: EmbedMaster counts every player opened. */
export const HIDDEN_CLOSE_MS = 2 * 60 * 1000

/** The timings in use (tests shorten them). */
export const serverTiming = { hiddenCloseMs: HIDDEN_CLOSE_MS }

export const EMBEDMASTER_ORIGIN = 'https://embedmaster.link'

/** Options on every EmbedMaster player URL. */
export const EMBEDMASTER_OPTIONS = { skin: 'onyx', welcome_page: 'off', autoplay: 'on' } as const

/** The EmbedMaster player id (public: it's in every embed URL). Read on each call so tests can set it. */
export const embedmasterPlayerId = (): string => (import.meta.env.VITE_EMBEDMASTER_PLAYER_ID ?? '').trim()

/** EmbedMaster's player for a TMDB movie, or an episode when `episode` is given. */
export function embedmasterUrl(tmdbId: number, episode?: { season: number; episode: number }): string {
  const path = episode ? `tv/${tmdbId}/${episode.season}/${episode.episode}` : `movie/${tmdbId}`
  const query = new URLSearchParams(EMBEDMASTER_OPTIONS).toString()
  return `${EMBEDMASTER_ORIGIN}/${encodeURIComponent(embedmasterPlayerId())}/${path}?${query}`
}
