import type { BeforeSend } from '@vercel/analytics/react'
import { tagAdStatus } from './ads/adStatus'
import { isTvMode } from './tv/tvMode'

/**
 * Views live after the "#" (/#/movies), which the Vercel Analytics dashboard
 * would lump together as "/". Report the hash route as the path instead, so
 * /#/movies?x=1 is counted as /movies?x=1. Other URLs are sent unchanged.
 */
export const hashRouteAsPath: BeforeSend = (event) => {
  const url = new URL(event.url)
  if (!url.hash.startsWith('#/')) return event
  const route = new URL(url.hash.slice(1), url.origin)
  // The route's own query (rare) wins; otherwise keep the page's (filters).
  return { ...event, url: `${url.origin}${route.pathname}${route.search || url.search}` }
}

/** Tags events from smart TVs with ?device=tv, so TV visits can be counted. */
export const tagTvDevice: BeforeSend = (event) => {
  if (!isTvMode()) return event
  const url = new URL(event.url)
  url.searchParams.set('device', 'tv')
  return { ...event, url: url.toString() }
}

/** A winner's private claim link (?t=…) never reaches analytics. */
export const dropClaimToken: BeforeSend = (event) => {
  const url = new URL(event.url)
  if (!url.searchParams.has('t')) return event
  url.searchParams.delete('t')
  return { ...event, url: url.toString() }
}

/** Everything sent to Vercel Analytics: hash routes as paths, tagged ?ad=… when the ad was blocked and ?device=tv on TVs. */
export const analyticsBeforeSend: BeforeSend = (event) => {
  const routed = hashRouteAsPath(dropClaimToken(event)!)
  const tagged = routed && tagAdStatus(routed)
  return tagged && tagTvDevice(tagged)
}
