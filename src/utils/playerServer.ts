import { pageview } from '@vercel/analytics'
import { embedmasterPlayerId, PLAYER_SERVERS, type PlayerServerId } from '../config/players'

const KEY = 'naijatr.playerServer'

/**
 * The servers that can play this title, in the config's order: NextStream when
 * its movie (or TV) template is set up on the server, EmbedMaster when its
 * player id is. Both need the TMDB id.
 */
export function availableServers(nextStream: boolean, tmdbId: number | undefined): PlayerServerId[] {
  if (tmdbId === undefined) return []
  return PLAYER_SERVERS.filter(
    (server) => server.enabled && (server.id === 'nextstream' ? nextStream : embedmasterPlayerId() !== ''),
  ).map((server) => server.id)
}

/** "Server 1", "Server 2"…: the label follows the server's place in the list. */
export const serverLabel = (servers: PlayerServerId[], id: PlayerServerId) => `Server ${servers.indexOf(id) + 1}`

/** The server picked last on this device, if it can play this title; else the first. */
export function preferredServer(servers: PlayerServerId[]): PlayerServerId | null {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(KEY)
  } catch {
    // Storage blocked: the first server.
  }
  return servers.find((server) => server === saved) ?? servers[0] ?? null
}

/** Remembers the viewer's pick for every title on this device. */
export function savePreferredServer(id: PlayerServerId): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // This visit only.
  }
}

/** Counted in Vercel Analytics: a server picked by the viewer, or switched to after the other failed. */
export const trackServerSwitch = (to: PlayerServerId, how: 'picked' | 'auto') =>
  pageview({ route: '/go/player-server', path: `/go/player-server?to=${to}&how=${how}` })
