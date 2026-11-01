import { useEffect, useSyncExternalStore } from 'react'

/**
 * One notice card at a time: a card that's due (the "Ads are back" card)
 * holds the queue until it's gone, and later cards (the monthly greeting)
 * wait for it.
 */
let holding = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Holds later notices while `active`. */
export function useHoldNotices(active: boolean): void {
  useEffect(() => {
    if (!active) return
    holding += 1
    emit()
    return () => {
      holding -= 1
      emit()
    }
  }, [active])
}

/** True while an earlier notice is due or showing. */
export const useNoticesHeld = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => holding > 0,
    () => false,
  )
