import { useEffect, useState } from 'react'
import { useSignInSheet } from '../account/account'
import { isPlaybackOpen, useOverlayOpen } from '../ads/adManager'
import { useActivationDue, useUnlockDue } from '../referral/status'
import { useNoticesHeld } from '../ui/noticeQueue'
import { promoWeekTiming } from './promoText'

/** Popups that wait for a free moment (the Free Ad-Free Week's and the welcome trial's). */

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // This visit only.
  }
}

/** Seen by this account (or device) already: a list of ids under one key. */
export const seenBy = (key: string, id: string) => (read(key) ?? '').split(',').includes(id)
export const markSeenBy = (key: string, id: string) => write(key, [...new Set([...(read(key) ?? '').split(',').filter(Boolean), id])].join(','))

/** Another popup, sheet or a player is on screen: the popup waits. */
const somethingOpen = () => isPlaybackOpen() || document.querySelector('[role="dialog"], [aria-modal="true"]') !== null

/**
 * Opens once `eligible` and `unseen` have held for the delay and the screen
 * is free; `show` marks it seen at that moment (false: seen meanwhile, on
 * another tab). Open, it stays until closed or no longer `eligible` (the
 * promo ended, or they signed in): being seen now doesn't close it.
 */
export function useFreeMoment(eligible: boolean, unseen: boolean, show: () => boolean) {
  const due = eligible && unseen
  const overlayOpen = useOverlayOpen()
  const noticesHeld = useNoticesHeld()
  const sheet = useSignInSheet()
  const unlock = useUnlockDue()
  const activation = useActivationDue()
  const [waited, setWaited] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!due) return
    const timer = window.setTimeout(() => setWaited(true), promoWeekTiming.delayMs)
    return () => window.clearTimeout(timer)
  }, [due])
  const blocked = overlayOpen || noticesHeld || sheet !== null || unlock || activation
  useEffect(() => {
    if (!due || !waited || blocked || open) return
    const tryShow = () => {
      if (somethingOpen() || !show()) return false
      setOpen(true)
      return true
    }
    if (tryShow()) return
    const timer = window.setInterval(() => {
      if (tryShow()) window.clearInterval(timer)
    }, promoWeekTiming.pollMs)
    return () => window.clearInterval(timer)
    // `show` is read when it's time; a new one each render doesn't restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due, waited, blocked, open])
  return [open && eligible, () => setOpen(false)] as const
}

