import { isDevHost } from '../ads/directLink'
import type { PlayerServerId } from '../config/players'

/**
 * Today's player stats on /admin/live (server/live/handlers.ts), per server:
 * - load:     a player opened (after Play, a switch or a retry);
 * - nostart:  no playable start within 10 s (most likely the viewer's daily limit);
 * - fallback: switched away from it by itself, to the other server;
 * - limited:  the "daily streaming limit" message shown, this server tried last.
 */
export type PlayerStat = 'load' | 'nostart' | 'fallback' | 'limited'

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
