import { isDevHost } from '../ads/directLink'
import type { PlayerServerId } from '../config/players'

/** Today's player opens on /admin/live (server/live/handlers.ts), per server: a player opened (after Play, or a retry). */
export type PlayerStat = 'load'

const REPORT_URL = '/api/live/player'

/** Counts the event on /api/live/player. Never from a developer's machine. */
export function reportPlayer(server: PlayerServerId, event: PlayerStat) {
  if (isDevHost()) return
  try {
    navigator.sendBeacon?.(REPORT_URL, new Blob([JSON.stringify({ server, event })], { type: 'application/json' }))
  } catch {
    // Not counted.
  }
}
