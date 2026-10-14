import { useCallback, useRef } from 'react'
import type { MouseEvent } from 'react'

const AD_URL = 'https://uplcm.com/4/12033849'
const AD_CLICKS = 2

/**
 * Returns an `onClickCapture` handler that opens the ad in a new tab for the first two
 * tab clicks. The first click is swallowed so the current tab stays put; the second
 * click goes through as normal. The count lives in a ref, so it resets whenever the host
 * component mounts.
 */
export function useAdTwice() {
  const clicks = useRef(0)

  return useCallback((event: MouseEvent<HTMLElement>) => {
    if (clicks.current >= AD_CLICKS) return
    if (!(event.target as HTMLElement).closest('[role="tab"]')) return
    clicks.current += 1
    window.open(AD_URL, '_blank', 'noopener,noreferrer')
    if (clicks.current === 1) event.stopPropagation()
  }, [])
}
