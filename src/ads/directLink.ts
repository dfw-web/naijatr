import { isTvMode } from '../tv/tvMode'
import { setAdStatus } from './adStatus'
import { requestAdBreak } from './adBreakStore'

export const AD_URL = 'https://uplcm.com/4/12033849'

/**
 * How long after the tap the page must lose focus or visibility (the new ad tab
 * taking over) before we decide the browser blocked it. Tests set it to Infinity
 * so no check runs unless a test asks for one.
 */
export const adTiming = { blockCheckMs: 1000 }

const NO_ADS_KEY = 'naijatr.noads'
// Dev machines and phones on the home network (vite --host): never a real visit.
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0$|\[::1\]$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/

/** ?noads=1 (in the query or the #/route) turns ads off for the session; ?noads=0 turns them back on. */
function noAdsFlag(url: URL): boolean {
  const flag =
    url.searchParams.get('noads') ?? new URLSearchParams(url.hash.split('?')[1] ?? '').get('noads')
  try {
    if (flag === '1') sessionStorage.setItem(NO_ADS_KEY, '1')
    if (flag === '0') sessionStorage.removeItem(NO_ADS_KEY)
    return sessionStorage.getItem(NO_ADS_KEY) === '1'
  } catch {
    return flag === '1'
  }
}

/**
 * Reads ?noads= from the address the visit started on. Call it when the app
 * starts: the filters and football routes rewrite the query string soon after.
 */
export function rememberNoAdsFlag(href = window.location.href): void {
  noAdsFlag(new URL(href))
}

/** True for test visits (localhost, the home network, ?noads=1), so no impressions are wasted. */
export function adsDisabled(href = window.location.href): boolean {
  const url = new URL(href)
  if (noAdsFlag(url)) return true
  // The test runner's page is http://localhost/; it checks the ads, so let them run there.
  return import.meta.env.MODE !== 'test' && LOCAL_HOST.test(url.hostname)
}

/** Opens the ad through a real link click: Safari treats this as the user's own tap. */
function clickAdLink(): boolean {
  try {
    const link = document.createElement('a')
    link.href = AD_URL
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.dataset.adLink = ''
    link.style.display = 'none'
    document.body.append(link)
    link.click()
    link.remove()
    return true
  } catch {
    return false
  }
}

/** Fallback opener. No "noopener" feature here: with it, window.open always returns null. */
function windowOpenAd(): boolean {
  const tab = window.open(AD_URL, '_blank')
  if (tab) tab.opener = null
  return tab !== null
}

/**
 * Calls onBlocked if the page keeps focus and stays visible for a while after
 * opening the ad. Start it before opening, so an instant blur still counts.
 * Returns a function that calls onBlocked right away instead (nothing opened).
 */
function watchForBlock(onBlocked: () => void): () => void {
  const ms = adTiming.blockCheckMs
  let left = false
  let done = false
  const finish = (isBlocked: boolean) => {
    if (done) return
    done = true
    window.clearTimeout(timer)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibility)
    if (isBlocked) onBlocked()
  }
  const onBlur = () => (left = true)
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') left = true
  }
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  const timer = Number.isFinite(ms)
    ? window.setTimeout(() => finish(!left && document.visibilityState === 'visible'), ms)
    : undefined
  if (timer === undefined) finish(false)
  return () => finish(true)
}

// Taps that already opened the ad, so capture and bubble handlers of one tap can't both fire it.
const handledTaps = new WeakSet<Event>()

/**
 * Opens the ad in a new tab. Call it synchronously at the very start of a click
 * handler, before any await, timer, state update or navigation: Safari only
 * allows the new tab inside the tap itself. If the browser blocks it anyway, the
 * page with `adKey` shows a one-time ad break instead (see AdBreak).
 *
 * Returns false when nothing opened (test visit, TV, or this tap already opened it).
 */
export function openAd(tap: Event | undefined, adKey: string): boolean {
  // TV browsers can't switch to a new tab: TVs get an ad break before playback instead (src/tv).
  if (adsDisabled() || isTvMode()) return false
  const event = tap ?? window.event
  if (event) {
    if (handledTaps.has(event)) return false
    handledTaps.add(event)
  }
  const nothingOpened = watchForBlock(() => blocked(adKey))
  if (!clickAdLink() && !windowOpenAd()) nothingOpened()
  return true
}

function blocked(adKey: string) {
  setAdStatus('blocked')
  requestAdBreak(adKey)
}

/** Opens the ad from the ad break's own button: a fresh tap, which Safari allows. */
export function openAdFromAdBreak(): void {
  if (!clickAdLink()) windowOpenAd()
}
