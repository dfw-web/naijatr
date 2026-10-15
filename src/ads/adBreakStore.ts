import { useEffect, useSyncExternalStore } from 'react'

// Pages (titles, matches) on screen now that can show an ad break.
const mounted = new Map<string, number>()
// Pages that already had their ad break: at most one each.
const shown = new Set<string>()
let active: string | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** The ad for `key` was blocked: show its ad break, if that page is still open and hasn't had one. */
export function requestAdBreak(key: string) {
  if (!mounted.get(key) || shown.has(key)) return
  shown.add(key)
  active = key
  emit()
}

export function closeAdBreak() {
  active = null
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Registers the page while mounted; true while its ad break is showing. */
export function useAdBreak(key: string): boolean {
  useEffect(() => {
    mounted.set(key, (mounted.get(key) ?? 0) + 1)
    return () => {
      const count = (mounted.get(key) ?? 1) - 1
      if (count) mounted.set(key, count)
      else mounted.delete(key)
      // Leaving the page ends its ad break.
      if (!count && active === key) closeAdBreak()
    }
  }, [key])
  return useSyncExternalStore(subscribe, () => active === key)
}

/** Test helper: forget which pages had their ad break. */
export function resetAdBreaks() {
  shown.clear()
  active = null
  emit()
}
