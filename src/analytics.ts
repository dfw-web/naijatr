import type { BeforeSend } from '@vercel/analytics/react'
import { tagAdStatus } from './ads/adStatus'

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

/** Everything sent to Vercel Analytics: hash routes as paths, tagged ?ad=… when the ad was blocked. */
export const analyticsBeforeSend: BeforeSend = (event) => {
  const routed = hashRouteAsPath(event)
  return routed && tagAdStatus(routed)
}
