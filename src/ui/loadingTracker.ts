/**
 * What the app is loading right now (titles, a drama, a lazily loaded
 * section), for the slim red bar at the top (src/components/NavProgress.tsx)
 * and for knowing when the splash (index.html) can go (src/ui/splash.ts).
 */

let active = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Something started loading; call the returned function once it's done (more calls do nothing). */
export function beginLoading(): () => void {
  active += 1
  emit()
  let done = false
  return () => {
    if (done) return
    done = true
    active -= 1
    emit()
  }
}

/** Tracks a promise: loading until it settles. */
export function trackLoading<T>(promise: Promise<T>): Promise<T> {
  const done = beginLoading()
  promise.then(done, done)
  return promise
}

export const isLoading = () => active > 0

export function subscribeLoading(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** For tests. */
export function resetLoading(): void {
  active = 0
  emit()
}
