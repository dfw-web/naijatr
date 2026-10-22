import { useSyncExternalStore } from 'react'
import { readRef } from './capture'

/**
 * The "You can win too" popup, for visitors who came by a friend's invite
 * link: it opens when they close the player after their watch counted for
 * that friend (PlayerPanel → playerClosed), once per device.
 */

/** Set once this device's play counted for the friend who invited it. */
export const COUNTED_KEY = 'naijatr.ref.counted'
/** Shown once per device. */
export const INVITEE_SHOWN_KEY = 'naijatr.invitee.popup'

const store = {
  get: (key: string) => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key: string) => {
    try {
      window.localStorage.setItem(key, '1')
    } catch {
      // Not remembered: it may show again on the next close.
    }
  },
}

export const markCounted = () => store.set(COUNTED_KEY)
export const markInviteeShown = () => store.set(INVITEE_SHOWN_KEY)

/** The play's report to the server, while it's on its way. */
let pendingReport: Promise<unknown> = Promise.resolve()
export const trackReport = (report: Promise<unknown>) => {
  pendingReport = report.catch(() => {})
}

let due = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** The player of a movie or an episode closed: time for the popup, if this visitor qualifies. */
export async function playerClosed() {
  if (!readRef() || store.get(INVITEE_SHOWN_KEY)) return
  // Closed straight after pressing play: wait for the count to come back.
  await pendingReport
  if (!store.get(COUNTED_KEY) || store.get(INVITEE_SHOWN_KEY)) return
  due = true
  emit()
}

export function dismissInvitee() {
  due = false
  markInviteeShown()
  emit()
}

export const useInviteeDue = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => due,
    () => false,
  )
