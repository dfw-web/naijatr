import { useCallback, useEffect, useState } from 'react'
import type { Season } from './types'

/**
 * Talks only to our own /api/football routes (server/football/handlers.ts),
 * never to api-sports.io, so the API key never reaches the browser.
 */

export type FootballErrorReason =
  | 'bad-request'
  | 'not-configured'
  | 'rate-limited'
  | 'plan'
  | 'auth'
  | 'not-found'
  | 'upstream-error'
  | 'unreachable'
  | 'offline'

export class FootballError extends Error {
  readonly reason: FootballErrorReason
  readonly season?: Season

  constructor(reason: FootballErrorReason, season?: Season) {
    super(`Football data request failed: ${reason}`)
    this.reason = reason
    this.season = season
  }
}

export interface FootballResult<T> {
  data: T
  /** True when the server could not refresh and sent its last good answer. */
  stale?: boolean
  season?: Season
}

export async function fetchFootball<T>(path: string, signal?: AbortSignal): Promise<FootballResult<T>> {
  let response: Response
  try {
    response = await fetch(`/api/football/${path}`, { signal, headers: { Accept: 'application/json' } })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new FootballError(navigator.onLine === false ? 'offline' : 'unreachable')
  }
  let body: Partial<FootballResult<T>> & { error?: FootballErrorReason }
  try {
    body = await response.json()
  } catch {
    throw new FootballError('upstream-error')
  }
  if (!response.ok || body.error || !('data' in body)) {
    throw new FootballError(body.error ?? 'upstream-error', body.season)
  }
  return body as FootballResult<T>
}

interface Loaded<T> {
  path: string
  result?: FootballResult<T>
  error?: FootballError
}

/**
 * Loads `path` and, with `refreshMs`, reloads it on that interval while the
 * tab is visible. A failed background refresh keeps the data already shown.
 */
export function useFootball<T>(path: string | null, refreshMs?: number) {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    fetchFootball<T>(path, controller.signal).then(
      (result) => setLoaded({ path, result }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        const failure = error instanceof FootballError ? error : new FootballError('upstream-error')
        setLoaded((previous) =>
          previous?.path === path && previous.result ? previous : { path, error: failure },
        )
      },
    )
    return () => controller.abort()
  }, [path, tick])

  useEffect(() => {
    if (!refreshMs) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') setTick((n) => n + 1)
    }, refreshMs)
    return () => window.clearInterval(id)
  }, [refreshMs])

  const retry = useCallback(() => {
    setLoaded(null)
    setTick((n) => n + 1)
  }, [])

  const current = loaded?.path === path ? loaded : null
  return {
    data: current?.result?.data,
    stale: current?.result?.stale ?? false,
    season: current?.result?.season ?? current?.error?.season,
    error: current?.error,
    loading: path !== null && !current,
    retry,
  }
}

/** Friendly copy for each failure, so a bad day upstream never breaks the page. */
export function describeFootballError(error: FootballError): { title: string; message: string } {
  switch (error.reason) {
    case 'rate-limited':
      return {
        title: 'Football data is taking a breather',
        message: "We've reached our data provider's request limit. Scores will be back shortly, so try again in a little while.",
      }
    case 'not-configured':
      return {
        title: "Football isn't set up yet",
        message: 'The football data key has not been added on the server.',
      }
    case 'auth':
      return {
        title: 'Football data is unavailable',
        message: 'Our football data provider did not accept the request. Please try again later.',
      }
    case 'plan':
      return {
        title: 'Not included in our data plan',
        message: 'This information needs a paid API-Football plan.',
      }
    case 'not-found':
      return { title: 'Match not found', message: 'This match may have been removed or the link is wrong.' }
    case 'offline':
      return { title: "You're offline", message: 'Connect to the internet to see live football.' }
    default:
      return {
        title: "Couldn't load football data",
        message: 'Something went wrong on our side. Please try again in a moment.',
      }
  }
}
