import { useEffect, useState } from 'react'
import { ADS_ENABLED } from '../config/ads'
import { isTvMode } from '../tv/tvMode'
import { useOverlayOpen } from './adManager'
import { adsDisabled } from './directLink'
import './AdsBackNotice.css'

const SEEN_KEY = 'naijatr.ads.backNotice'
/** Gives the contest popup a moment to open first; the card waits until it's closed. */
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
 * ads. It waits while the Telegram gate, the invite guide or a contest popup is
 * open, and goes away after 8 seconds or on OK.
 */
export function AdsBackNotice() {
  const [due, setDue] = useState(noticeDue)
  const [ready, setReady] = useState(false)
  const overlayOpen = useOverlayOpen()
  const visible = due && ready && !overlayOpen

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
        📢 Ads are back on NAIJA TR. They help keep the site free for everyone 🙏 Thanks for your support! ❤️
      </p>
      <button type="button" className="ads-back__ok" onClick={() => setDue(false)}>
        OK 👍
      </button>
    </div>
  )
}
