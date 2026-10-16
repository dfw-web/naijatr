import { ADS_ENABLED, MONETAG_TAGS } from '../config/ads'
import { isTvMode } from '../tv/tvMode'
import { adsDisabled } from './directLink'

/**
 * Adds the site-wide Monetag tags to the page. Does nothing while ADS_ENABLED
 * is false, on test visits (localhost, ?noads=1), and on TVs, where a remote
 * can't close them (see src/tv).
 */
export function loadMonetagTags(): void {
  if (!ADS_ENABLED || adsDisabled() || isTvMode()) return
  for (const tag of MONETAG_TAGS) {
    const script = document.createElement('script')
    script.dataset.zone = tag.zone
    script.src = tag.src
    document.body.append(script)
  }
}
