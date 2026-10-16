import { useCallback, useRef } from 'react'
import type { MouseEvent } from 'react'
import { openAd } from '../ads/directLink'
import { ADS_ENABLED } from '../config/ads'

const AD_CLICKS = 2

/**
 * Returns an `onClickCapture` handler that opens the ad in a new tab for the first two
 * tab clicks. The first click is swallowed so the current tab stays put; the second
 * click goes through as normal. The count lives in a ref, so it resets whenever the host
 * component mounts. If the browser blocks the ad, the page with `adKey` shows an ad break.
 * While ADS_ENABLED is false it does nothing, so tab clicks work as normal.
 */
export function useAdTwice(adKey: string) {
  const clicks = useRef(0)

  return useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!ADS_ENABLED || clicks.current >= AD_CLICKS) return
      if (!(event.target as HTMLElement).closest('[role="tab"]')) return
      // Opened synchronously, inside the tap, before the tab switch.
      if (!openAd(event.nativeEvent, adKey)) return
      clicks.current += 1
      if (clicks.current === 1) event.stopPropagation()
    },
    [adKey],
  )
}
