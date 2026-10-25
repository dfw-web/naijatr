/**
 * The "Invite & Win" contest settings, from env:
 *
 * - CONTEST_ACTIVE  "true" turns it on.
 * - CONTEST_START / CONTEST_END  Africa/Lagos time, e.g. "2026-10-23 18:00"
 *   and "2026-10-25 23:59" (Lagos is UTC+1 all year). A full ISO time with
 *   its own offset also works.
 * - CONTEST_PRIZES  naira for 1st, 2nd, 3rd: "30000,20000,10000" (default).
 *
 * It is one contest at a time: nothing repeats. Its id comes from the start
 * time, so a later contest (new dates) starts with a fresh leaderboard while
 * the old one's data stays put. Outside start..end nothing scores, so the
 * board freezes on its own at the end.
 */

export const DEFAULT_PRIZES = [30000, 20000, 10000]
const LAGOS_OFFSET = '+01:00'

export type ContestPhase = 'off' | 'upcoming' | 'live' | 'ended'

export interface Contest {
  /** Stable id for this contest's Redis keys. */
  id: string
  active: boolean
  start: number
  end: number
  prizes: number[]
}

/** "2026-10-23 18:00" (Lagos) → epoch ms; NaN when unreadable. */
export function parseLagosTime(value: string | undefined): number {
  const text = (value ?? '').trim()
  if (!text) return Number.NaN
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) return Date.parse(text)
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (!match) return Number.NaN
  const [, date, hour, minute, second = '00'] = match
  return Date.parse(`${date}T${hour.padStart(2, '0')}:${minute}:${second}${LAGOS_OFFSET}`)
}

export function readContest(env: Record<string, string | undefined>): Contest | null {
  const start = parseLagosTime(env.CONTEST_START)
  let end = parseLagosTime(env.CONTEST_END)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  // "23:59" means the whole minute.
  if (/:59$/.test((env.CONTEST_END ?? '').trim())) end += 59_999
  const prizes = (env.CONTEST_PRIZES ?? '')
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isFinite(p) && p > 0)
    .slice(0, 3)
  return {
    id: new Date(start).toISOString().slice(0, 16).replace(/[-:]/g, ''),
    active: (env.CONTEST_ACTIVE ?? '').trim().toLowerCase() === 'true',
    start,
    end,
    prizes: prizes.length === 3 ? prizes : DEFAULT_PRIZES,
  }
}

export function contestPhase(contest: Contest | null, now: number): ContestPhase {
  if (!contest || !contest.active) return 'off'
  if (now < contest.start) return 'upcoming'
  return now < contest.end ? 'live' : 'ended'
}

/** Whether a referral at `at` scores in this contest. */
export const scoresAt = (contest: Contest | null, at: number) => contestPhase(contest, at) === 'live'

/**
 * The leaderboard's sorted-set score: points first, then whoever got there
 * first (an earlier time ranks higher on a tie). Exact as a double while
 * points < 900,000.
 */
export const boardScore = (points: number, at: number, contest: Contest) =>
  points * 1e10 + (1e10 - 1 - Math.max(0, Math.floor((at - contest.start) / 1000)))

export const pointsOf = (score: number) => Math.floor(score / 1e10)

export const PLACES = ['1st', '2nd', '3rd'] as const

