import { useEffect } from 'react'
import { ADS_ENABLED, MULTITAG } from '../config/ads'
import { isTvMode } from '../tv/tvMode'
import { adsDisabled } from './directLink'
import { adFreeReady } from '../referral/status'

/**
 * Adds the Monetag Multitag to the page, once:
 * <script src="https://quge5.com/88/tag.min.js" data-zone="302667" async data-cfasync="false">
 * Does nothing while ADS_ENABLED is false, for ad-free accounts, on test visits
 * (localhost, ?noads=1), on the pages without ads (/admin, /invite/rules) and on
 * TVs, where a remote can't close it (see src/tv). Returns whether it's on the page.
 *
 * Monetag has no way to pause the tag once loaded; its formats and frequency
 * caps are set on the zone in the Monetag dashboard.
 */
export function loadMultitag(): boolean {
  if (!ADS_ENABLED || adsDisabled() || isTvMode()) return false
  if (document.querySelector(`script[data-zone="${MULTITAG.zone}"]`)) return true
  const script = document.createElement('script')
  script.src = MULTITAG.src
  script.dataset.zone = MULTITAG.zone
  script.async = true
  script.setAttribute('data-cfasync', 'false')
  document.body.append(script)
  return true
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
