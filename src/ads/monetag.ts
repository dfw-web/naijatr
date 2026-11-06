import { useEffect } from 'react'
import { ADS_ENABLED, MULTITAG, MULTITAG_2 } from '../config/ads'
import { isTvMode } from '../tv/tvMode'
import { isPlaybackOpen } from './adManager'
import { adsDisabled, isDevHost } from './directLink'
import { adFreeReady } from '../referral/status'

/**
 * Adds the Monetag Multitag to the page, once:
 * <script src="https://quge5.com/88/tag.min.js" data-zone="302667" async data-cfasync="false">
 * Does nothing while ADS_ENABLED is false, for ad-free accounts, on test visits
 * (localhost, ?noads=1), on the pages without ads (/admin, /invite/rules) and on
 * TVs, where a remote can't close it (see src/tv). Returns whether it's on the page.
 *
 * Then the second Multitag (zone 306795, while MULTITAG_2.enabled), under the
 * same rules. It's the same script URL, and each copy reads its zone from its
 * own script element, so it gets an element (and id) of its own, added once
 * the first has loaded: each then makes its own request, and both zones serve
 * (checked in Chrome: each zone fetches its own settings and opens its own
 * pop-unders). It waits while a player is open, as it can't be paused once on.
 *
 * Monetag has no way to pause the tag once loaded; its formats and frequency
 * caps are set on the zone in the Monetag dashboard.
 */
export function loadMultitag(): boolean {
  if (!ADS_ENABLED || adsDisabled() || isTvMode()) return false
  if (document.getElementById(MULTITAG.id) || document.querySelector(`script[data-zone="${MULTITAG.zone}"]`)) return true
  const script = addTag(MULTITAG)
  const next = () => {
    script.removeEventListener('load', next)
    script.removeEventListener('error', next)
    loadSecondMultitag()
  }
  script.addEventListener('load', next)
  script.addEventListener('error', next)
  return true
}

/** How often a second Multitag held back by an open player looks again. */
export const SECOND_TAG_RETRY_MS = 3000
let secondTimer: number | undefined

/** The second Multitag, once: after the first, and not while a player is open. Returns whether it's on the page. */
export function loadSecondMultitag(): boolean {
  if (!MULTITAG_2.enabled || !ADS_ENABLED || adsDisabled() || isTvMode()) return false
  if (document.getElementById(MULTITAG_2.id)) return true
  if (isPlaybackOpen()) {
    window.clearTimeout(secondTimer)
    secondTimer = window.setTimeout(loadSecondMultitag, SECOND_TAG_RETRY_MS)
    return false
  }
  addTag(MULTITAG_2)
  return true
}

/** One Multitag script, with exactly Monetag's attributes (plus an id), counted when it loads or is blocked. */
function addTag(tag: { zone: string; src: string; id: string }) {
  const script = document.createElement('script')
  script.id = tag.id
  script.src = tag.src
  script.dataset.zone = tag.zone
  script.async = true
  script.setAttribute('data-cfasync', 'false')
  script.addEventListener('load', () => reportTag(`multitag-${tag.zone}`), { once: true })
  script.addEventListener('error', () => reportTag(`multitag-${tag.zone}-blocked`), { once: true })
  document.body.append(script)
  return script
}

/** Counted on /api/live/ad (shown on /admin/live): which Multitags loaded today. Never from a developer's machine. */
function reportTag(event: string) {
  if (isDevHost()) return
  try {
    navigator.sendBeacon?.('/api/live/ad', new Blob([JSON.stringify({ event })], { type: 'application/json' }))
  } catch {
    // Not counted.
  }
}

/**
 * Loads the Multitag once from a root component (App, Football), unless
 * `enabled` is false. A signed-in device first waits (up to 4 seconds) for the
 * server to say whether the account is ad-free: Monetag can't be taken back
 * once it's on the page.
 */
export function useMultitag(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    let live = true
    void adFreeReady().then(() => {
      if (live) loadMultitag()
    })
    return () => {
      live = false
    }
  }, [enabled])
}
