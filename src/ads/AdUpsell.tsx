import { useEffect } from 'react'
import { goToPage } from '../account/pages'
import { FROM_PRICE, naira } from '../config/adFree'
import { goalNow } from '../referral/status'
import { closeUpsell, holdAdsThisTap, useUpsellOpen } from './adManager'
import './AdsBackNotice.css'

/** How long the banner stays up by itself. */
export const UPSELL_VISIBLE_MS = 12_000

/**
 * "Too many ads? 😅": a small banner along the bottom after every 5th
 * direct-link ad of the day, at most twice a day (AD_UPSELL in
 * src/config/ads.ts). It blocks nothing, goes away by itself, and its link
 * opens the Go ad-free page without an ad on that tap.
 */
export function AdUpsell() {
  const open = useUpsellOpen()
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(closeUpsell, UPSELL_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [open])
  if (!open) return null
  return (
    <div className="ads-back ads-upsell" role="status">
      <p className="ads-back__text">
        Too many ads? 😅 Go ad-free from {naira(FROM_PRICE)}, or invite {goalNow()} friends free{' '}
        <a
          href="/invite"
          className="ads-back__link"
          onClick={(event) => {
            event.preventDefault()
            holdAdsThisTap()
            closeUpsell()
            goToPage('invite')
          }}
        >
          👉 Go ad-free
        </a>
      </p>
      <button
        type="button"
        className="ads-back__ok"
        aria-label="Close"
        onClick={() => {
          holdAdsThisTap()
          closeUpsell()
        }}
      >
        ✕
      </button>
    </div>
  )
}
