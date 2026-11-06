import { STREAM_LIMIT_RESET_UTC_HOUR } from '../config/players'

/**
 * This network hit EmbedMaster's daily limit, remembered on this device only.
 *
 * EmbedMaster counts the movies opened per IP, and both servers end in its
 * player, so the limit is the network's, not a server's: switching servers
 * would only open (and count) another player. A player with no playable start
 * within 10 s marks it until the estimated reset; Play then shows the limit
 * message first, with "Try again" (another network may have its own limit),
 * which clears the mark. A player that starts playing clears it too.
 */
const KEY = 'naijatr.streamLimit'

function readUntil(now: number): number | null {
  try {
    const until = Number(JSON.parse(localStorage.getItem(KEY) ?? 'null')?.until)
    return Number.isFinite(until) && until > now ? until : null
  } catch {
    return null
  }
}

/** When the providers' day is expected to start again (their reset isn't published: an estimate). */
export function nextReset(now = Date.now()): number {
  const reset = new Date(now)
  reset.setUTCHours(STREAM_LIMIT_RESET_UTC_HOUR, 0, 0, 0)
  if (reset.getTime() <= now) reset.setUTCDate(reset.getUTCDate() + 1)
  return reset.getTime()
}

export const isLimited = (now = Date.now()) => readUntil(now) !== null

export function markLimited(now = Date.now()) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ until: nextReset(now) }))
  } catch {
    // This visit only (nothing to remember it in).
  }
}

export function clearLimited() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing saved.
  }
}
