import { useCallback, useEffect, useState } from 'react'

export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error }

type Loader<T> = (signal: AbortSignal) => Promise<T>

/** A settled result, tagged with the request that produced it. */
interface Settled<T> {
  load: Loader<T>
  attempt: number
  state: Extract<AsyncState<T>, { status: 'success' | 'error' }>
}

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error('Something went wrong while loading titles.')

/**
 * Runs `load` whenever it changes (pass a memoised callback), cancels stale
 * requests via AbortSignal, and exposes `retry` for error states.
 * Passing `null` leaves the hook idle.
 */
export function useAsync<T>(load: Loader<T> | null) {
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!load) return
    const controller = new AbortController()
    const settle = (state: Settled<T>['state']) => {
      if (!controller.signal.aborted) setSettled({ load, attempt, state })
    }
    load(controller.signal).then(
      (data) => settle({ status: 'success', data }),
      (error: unknown) => settle({ status: 'error', error: toError(error) }),
    )
    return () => controller.abort()
  }, [load, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  // Derived during render: anything not yet settled for the current request is loading.
  const state: AsyncState<T> = !load
    ? { status: 'idle' }
    : settled && settled.load === load && settled.attempt === attempt
      ? settled.state
      : { status: 'loading' }

  return { state, retry }
}
