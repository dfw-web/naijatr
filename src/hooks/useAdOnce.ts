import { useCallback } from 'react'

const AD_URL = 'https://uplcm.com/4/12033849'

/**
 * Returns a function that opens the ad in a new tab, once per call. Call it
 * synchronously inside the click handler (before anything async), or mobile
 * browsers treat it as an unprompted popup and block it. It never touches the
 * current tab, so the click's own action carries on as normal.
 */
export function useAdOnce() {
  return useCallback(() => {
    window.open(AD_URL, '_blank', 'noopener,noreferrer')
  }, [])
}
