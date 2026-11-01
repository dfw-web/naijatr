/**
 * The film and episode players, in the order the viewer sees them: the first
 * is "Server 1", the next "Server 2". Move an entry up or down to reorder
 * them, or set `enabled: false` to take one away. Labels follow the order.
 *
 * - nextstream:  the NextStream page behind /api/play (needs NEXTSTREAM_* on Vercel);
 * - embedmaster: embedmaster.link, played straight from the page. Needs
 *   VITE_EMBEDMASTER_PLAYER_ID; the player is domain-locked to www.naijatr.com,
 *   so on localhost it won't start and the viewer is moved to the other server.
 */
export type PlayerServerId = 'nextstream' | 'embedmaster'

export const PLAYER_SERVERS: { id: PlayerServerId; enabled: boolean }[] = [
  { id: 'nextstream', enabled: true },
  { id: 'embedmaster', enabled: true },
]

/** A server that hasn't sent a single player event this long after it was opened is switched for the other. */
export const SERVER_START_TIMEOUT_MS = 10_000

/** The timeout in use (tests shorten it). */
export const serverTiming = { startMs: SERVER_START_TIMEOUT_MS }

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
