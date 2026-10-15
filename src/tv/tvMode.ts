/**
 * Smart TV mode. The detection runs inline in index.html (before the ad tags,
 * which are skipped on TVs) and marks <html class="tv-mode">; everything else
 * reads that class. Add ?tv=1 to any URL to try TV mode on a computer, and
 * ?tv=0 to turn it off again (both are remembered in this browser).
 */
export const isTvMode = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('tv-mode')

/** The public site, used for links that leave the TV (QR codes). */
export const SITE_URL = 'https://www.naijatr.com'

/** Deep link to a title's details page, as opened by App (see useTitleDeepLink). */
export const titleParam = (item: { type: 'movie' | 'series'; tmdbId?: number }) =>
  item.tmdbId === undefined ? null : `${item.type}-${item.tmdbId}`

/** Link to watch a title on a phone, tagged so the visits show up in analytics. */
export function phoneLink(item: { type: 'movie' | 'series'; tmdbId?: number }) {
  const param = titleParam(item)
  const url = new URL(SITE_URL)
  if (param) url.searchParams.set('title', param)
  url.searchParams.set('utm_source', 'tv_qr')
  return url.toString()
}
