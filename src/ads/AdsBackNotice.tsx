import { useEffect, useState } from 'react'
import { ADS_ENABLED } from '../config/ads'
import { isTvMode } from '../tv/tvMode'
import { useHoldNotices } from '../ui/noticeQueue'
import { holdAdsThisTap, useOverlayOpen } from './adManager'
import { goToPage } from '../account/pages'
import { goalNow } from '../referral/status'
import { requestBuyOption } from '../referral/copy'
import { FROM_PRICE, naira } from '../config/adFree'
import '../referral/referral.css'
import { adsDisabled } from './directLink'
import './AdsBackNotice.css'

const SEEN_KEY = 'naijatr.ads.backNotice'
/** Gives other popups a moment to open first; the card waits until they're closed. */
const SHOW_AFTER_MS = 1500
const VISIBLE_MS = 8000

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Storage blocked: seen() already says yes.
  }
}

const noticeDue = () => ADS_ENABLED && !adsDisabled() && !isTvMode() && !seen()

/**
 * "Ads are back": a slim card at the bottom, once per device, on a visit with
 * ads (not for ad-free accounts). It waits while another popup is open, and
 * goes away after 8 seconds or on OK. "Learn more" opens /invite.
 */
export function AdsBackNotice() {
  const [due, setDue] = useState(noticeDue)
  const [ready, setReady] = useState(false)
  const overlayOpen = useOverlayOpen()
  const visible = due && ready && !overlayOpen
  // Later cards (the monthly greeting) wait until this one is done.
  useHoldNotices(due)

  useEffect(() => {
    if (!due) return
    const timer = window.setTimeout(() => setReady(true), SHOW_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [due])

  useEffect(() => {
    if (!visible) return
    markSeen()
    const timer = window.setTimeout(() => setDue(false), VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  if (!visible) return null
  return (
    <div className="ads-back" role="status">
      <p className="ads-back__text">
        📢 Ads are back on NAIJA TR to keep it free. Want it ad-free? Invite {goalNow()} friends 👉{' '}
        <a
          href="/invite"
          className="ads-back__link"
          onClick={(event) => {
            event.preventDefault()
            holdAdsThisTap()
            setDue(false)
            goToPage('invite')
          }}
        >
          Learn more
        </a>{' '}
        <a
          href="/invite"
          className="ads-back__link"
          onClick={(event) => {
            event.preventDefault()
            holdAdsThisTap()
            setDue(false)
            requestBuyOption()
            goToPage('invite')
          }}
        >
          …or buy ad-free from {naira(FROM_PRICE)}
        </a>
      </p>
      <button type="button" className="ads-back__ok" onClick={() => setDue(false)}>
        OK 👍
      </button>
    </div>
  )
}
