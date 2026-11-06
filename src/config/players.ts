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

/**
 * A player with no playable start (duration, time or play) this long after it
 * opened: most likely the network's daily limit (EmbedMaster counts movies
 * opened per IP, on both servers). Only a Server 1 page that never opened
 * EmbedMaster is switched for Server 2, so a play opens one player.
 */
export const SERVER_START_TIMEOUT_MS = 10_000

/**
 * The hour (UTC) the providers' daily limit is expected to reset. Not
 * published; midnight UTC (01:00 in Lagos) is a guess. Change it once the
 * player's "Try again in …" shows the real time.
 */
export const STREAM_LIMIT_RESET_UTC_HOUR = 0

/** A film or episode left in a hidden tab (or app) this long is closed: EmbedMaster counts every player opened. */
export const HIDDEN_CLOSE_MS = 2 * 60 * 1000

/** The timings in use (tests shorten them). */
export const serverTiming = { startMs: SERVER_START_TIMEOUT_MS, hiddenCloseMs: HIDDEN_CLOSE_MS }

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
