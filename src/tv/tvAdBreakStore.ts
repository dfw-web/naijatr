import { useSyncExternalStore } from 'react'
import { isTvMode } from './tvMode'

/**
 * The TV ad break: in TV mode, the first Play of each title (or match) this
 * visit shows a full-screen ad break first; its Continue button then runs the
 * playback. Off TV, and for later plays, the playback runs straight away.
 */

interface Pending {
  key: string
  action: () => void
  /** Shown as a "watch on your phone" QR code while no banner zone is set up. */
  phoneUrl?: string
}

const shown = new Set<string>()
let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Runs `action` now, or after the ad break when this is the title's first play on a TV. */
export function playAfterAdBreak(key: string, action: () => void, phoneUrl?: string) {
  if (!isTvMode() || shown.has(key)) return action()
  shown.add(key)
  pending = { key, action, phoneUrl }
  emit()
}

/** Continue: close the break and play. Runs inside the button press, so fullscreen is allowed. */
export function continueAfterAdBreak() {
  const current = pending
  pending = null
  emit()
  current?.action()
}

/** Back: close the break without playing; the next Play goes straight to the video. */
export function cancelAdBreak() {
  pending = null
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const usePendingAdBreak = () => useSyncExternalStore(subscribe, () => pending)

/** Test helper. */
export function resetTvAdBreaks() {
  shown.clear()
  pending = null
  emit()
}
