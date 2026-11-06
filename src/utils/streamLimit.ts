import { STREAM_LIMIT_RESET_UTC_HOUR, type PlayerServerId } from '../config/players'

/**
 * The servers that hit this viewer's daily limit, on this device only.
 *
 * Both servers end in EmbedMaster's player, whose "You have reached today's
 * limit" is most likely per viewer (IP), so it's never shared with anyone
 * else. A server that didn't start within 10 s is marked until the estimated
 * reset; Play then tries the other one first, and when both are marked it
 * shows the limit message at once (with "Try again", which clears the marks).
 * A server that starts playing is cleared.
 */
const KEY = 'naijatr.streamLimit'

type Marks = Partial<Record<PlayerServerId, number>>

function read(now: number): Marks {
  try {
    const marks = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Marks
    return Object.fromEntries(
      Object.entries(marks).filter(([, until]) => typeof until === 'number' && until > now),
    ) as Marks
  } catch {
    return {}
  }
}

function write(marks: Marks) {
  try {
    if (Object.keys(marks).length) localStorage.setItem(KEY, JSON.stringify(marks))
    else localStorage.removeItem(KEY)
  } catch {
    // This visit only.
  }
}

/** When the providers' day is expected to start again (their reset isn't published: an estimate). */
export function nextReset(now = Date.now()): number {
  const reset = new Date(now)
  reset.setUTCHours(STREAM_LIMIT_RESET_UTC_HOUR, 0, 0, 0)
  if (reset.getTime() <= now) reset.setUTCDate(reset.getUTCDate() + 1)
  return reset.getTime()
}

export const isLimited = (server: PlayerServerId, now = Date.now()) => read(now)[server] !== undefined

export function markLimited(server: PlayerServerId, now = Date.now()) {
  write({ ...read(now), [server]: nextReset(now) })
}

export function clearLimited(server?: PlayerServerId, now = Date.now()) {
  if (!server) return write({})
  const marks = read(now)
  if (marks[server] === undefined) return
  delete marks[server]
  write(marks)
}

/** "3 hours", "1 hour", "40 minutes": how long until `at`. */
export function timeUntil(at: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000))
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'}`
}
