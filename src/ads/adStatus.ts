import type { BeforeSend } from '@vercel/analytics/react'

/**
 * What happened to the ad this session, for the analytics dashboard:
 * blocked → the browser blocked the ad tab and the ad break was due;
 * fallback-continue / fallback-skip → what the visitor did on the ad break.
 */
export type AdStatus = 'blocked' | 'fallback-continue' | 'fallback-skip'

const KEY = 'naijatr.ad'
let memory: AdStatus | null = null

export function setAdStatus(status: AdStatus) {
  memory = status
  try {
    sessionStorage.setItem(KEY, status)
  } catch {
    // Storage blocked (private mode): the in-memory value still tags this page load.
  }
}

export function getAdStatus(): AdStatus | null {
  try {
    return (sessionStorage.getItem(KEY) as AdStatus | null) ?? memory
  } catch {
    return memory
  }
}

/** beforeSend step: adds ?ad=<status> to events from sessions where the ad was blocked. */
export const tagAdStatus: BeforeSend = (event) => {
  const status = getAdStatus()
  if (!status) return event
  const url = new URL(event.url)
  url.searchParams.set('ad', status)
  return { ...event, url: url.toString() }
}
