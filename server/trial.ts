import { normalizeEmail } from './referral/rules.js'

/**
 * The 48-hour Premium welcome trial: a brand-new account, with an inbox that
 * has never had an account here, is Premium (ad-free, Server 2, the crown)
 * for TRIAL_HOURS from the moment its email was confirmed. It only exists
 * after TRIAL_START, which is the end of the Free Ad-Free Week (PROMO_END)
 * unless TRIAL_START is set. TRIAL_ENABLED=false switches it off.
 *
 * Kept on profiles.welcome_trial_until (ad_free_until is never touched), and
 * once per inbox for good in welcome_trials (it isn't deleted with the
 * account), with the device it was used on.
 */

/** The Free Ad-Free Week's end, the trial's start when neither TRIAL_START nor PROMO_END is set. */
export const DEFAULT_TRIAL_START = '2026-11-17T23:59:59+01:00'
export const DEFAULT_TRIAL_HOURS = 48
const HOUR_MS = 60 * 60 * 1000

export interface TrialConfig {
  enabled: boolean
  /** The trial's first moment (ms): accounts made from then on qualify, and nothing happens before it. */
  start: number
  hours: number
}

export function readTrialConfig(env: Record<string, string | undefined>): TrialConfig {
  const start = [env.TRIAL_START, env.PROMO_END, DEFAULT_TRIAL_START].map((raw) => Date.parse(raw?.trim() ?? '')).find(Number.isFinite)!
  const hours = Number(env.TRIAL_HOURS)
  return {
    enabled: (env.TRIAL_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    start,
    hours: Number.isFinite(hours) && hours > 0 && hours <= 24 * 30 ? hours : DEFAULT_TRIAL_HOURS,
  }
}

/** The trial runs now: switched on, and past its start (on the server's clock). */
export const trialLive = (config: TrialConfig, now: number) => config.enabled && now > config.start

/** What the status answer says about the trial, for everyone (the Play popup waits for it). */
export interface TrialInfo {
  start: string
  live: boolean
}

export const trialInfo = (config: TrialConfig, now: number): TrialInfo | null =>
  config.enabled ? { start: new Date(config.start).toISOString(), live: trialLive(config, now) } : null

export type TrialRefusal = 'off' | 'not-started' | 'old-account' | 'unconfirmed' | 'known-inbox' | 'inbox-had-trial' | 'device-had-trial'

export interface TrialInput {
  config: TrialConfig
  now: number
  userId: string
  email: string
  /** When the account was made. */
  createdAt: number
  /** When its email was confirmed (null: not yet). */
  emailConfirmedAt: number | null
  /** The first account ever seen with this inbox (known_emails), or null. */
  inboxFirstUser: string | null
  /** Another profile has this inbox (normalized). */
  inboxTaken: boolean
  /** The inbox's trial (welcome_trials), if it ever had one. */
  inboxTrialUser: string | null
  /** Another inbox already had its trial on this device (by the device id, or the device's own flag). */
  deviceUsed: boolean
}

/**
 * Does this account get the welcome trial, and until when? Only a new account
 * (made on or after the start), with a confirmed email, for an inbox that's
 * never had an account or a trial, on a device that's never had one.
 */
export function checkTrial(input: TrialInput): { ok: true; until: string } | { ok: false; reason: TrialRefusal } {
  const { config, now } = input
  if (!config.enabled) return { ok: false, reason: 'off' }
  if (!trialLive(config, now)) return { ok: false, reason: 'not-started' }
  if (!(input.createdAt >= config.start)) return { ok: false, reason: 'old-account' }
  if (input.emailConfirmedAt === null || !Number.isFinite(input.emailConfirmedAt)) return { ok: false, reason: 'unconfirmed' }
  if ((input.inboxFirstUser !== null && input.inboxFirstUser !== input.userId) || input.inboxTaken) return { ok: false, reason: 'known-inbox' }
  if (input.inboxTrialUser !== null && input.inboxTrialUser !== input.userId) return { ok: false, reason: 'inbox-had-trial' }
  if (input.deviceUsed) return { ok: false, reason: 'device-had-trial' }
  // From the confirmation, never from before the trial's start.
  const from = Math.max(input.emailConfirmedAt, config.start)
  return { ok: true, until: new Date(from + config.hours * HOUR_MS).toISOString() }
}

/** The inbox a trial is kept under (Gmail dots and +tags are the same inbox). */
export const trialInbox = (email: string) => normalizeEmail(email)

/** True while `until` (welcome_trial_until) is still ahead. */
export const trialRunning = (until: string | null | undefined, now: number) => {
  const end = until ? Date.parse(until) : NaN
  return Number.isFinite(end) && end > now
}
