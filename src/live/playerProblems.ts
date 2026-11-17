import { isDevHost } from '../ads/directLink'
import type { PlayerServerId } from '../config/players'
import { isTvMode } from '../tv/tvMode'

/**
 * Player problems for /admin/live (server/live/handlers.ts): a player that
 * gave no sign of life 12 seconds after opening ("slow"), or stopped moving
 * for 10 seconds mid-show ("stall"). Only ids and known values are sent: the
 * admin page looks the title's name up.
 */

export type ProblemKind = 'slow' | 'stall'
export type ProblemDevice = 'iphone' | 'ipad' | 'android' | 'android-tablet' | 'desktop' | 'tv'

export interface ProblemReport {
  kind: ProblemKind
  /** "movie:550" or "tv:1399". */
  item: string
  /** Series: "s1e3". */
  ep: string | null
  server: PlayerServerId
  /** The source picked in the player's own menu (MovieJoy, VidStore…), if it said. */
  source: string | null
  device: ProblemDevice
}

const REPORT_URL = '/api/live/problem'

export function deviceKind(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
  tv = isTvMode(),
): ProblemDevice {
  if (tv) return 'tv'
  if (/iPhone|iPod/i.test(userAgent)) return 'iphone'
  if (/iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)) return 'ipad'
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? 'android' : 'android-tablet'
  return 'desktop'
}

/** Logs one problem on /api/live/problem. Never from a developer's machine. */
export function reportPlayerProblem(report: ProblemReport): void {
  if (isDevHost()) return
  try {
    navigator.sendBeacon?.(REPORT_URL, new Blob([JSON.stringify(report)], { type: 'application/json' }))
  } catch {
    // Not logged.
  }
}
