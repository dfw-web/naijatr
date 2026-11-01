import { SYNC_PROMPT } from '../config/account'

/**
 * The gentle reminders, each shown at most once every 7 days: "sync" (sign in
 * to keep your progress) and "password" (set a password to log in on other
 * devices). Shown, "Not now" and "Skip for now" all start the 7 days.
 */
export type Reminder = 'sync' | 'password'

const KEYS: Record<Reminder, string> = { sync: 'naijatr.syncPrompt.closedAt', password: 'naijatr.passwordReminder.closedAt' }

export function snoozed(reminder: Reminder, now = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(KEYS[reminder]))
    return Number.isFinite(at) && at > 0 && now - at < SYNC_PROMPT.snoozeMs
  } catch {
    return true
  }
}

export function snooze(reminder: Reminder): void {
  try {
    localStorage.setItem(KEYS[reminder], String(Date.now()))
  } catch {
    // Not shown again this visit anyway.
  }
}
