import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ADS_ENABLED } from '../config/ads'
import { TV_AD_BREAK_SECONDS, TV_BANNER_ZONE } from '../config/tvAds'
import { AdSlot } from './AdSlot'
import { QrCode } from './QrCode'
import { cancelAdBreak, continueAfterAdBreak, usePendingAdBreak } from './tvAdBreakStore'

/**
 * The TV ad break (see tvAdBreakStore): full screen, an ad (or, until a TV
 * banner zone is set up, a "watch on your phone" QR code), a countdown, then
 * a focused "Continue" button. Back closes it at any time, so the remote is
 * never stuck. Render once per root (App and Football).
 */
export function TvAdBreakHost() {
  const pending = usePendingAdBreak()
  if (!ADS_ENABLED || !pending) return null
  return createPortal(<TvAdBreak key={pending.key} phoneUrl={pending.phoneUrl} />, document.body)
}

function TvAdBreak({ phoneUrl }: { phoneUrl?: string }) {
  const [secondsLeft, setSecondsLeft] = useState(TV_AD_BREAK_SECONDS)
  const panelRef = useRef<HTMLDivElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  const ready = secondsLeft <= 0

  useEffect(() => {
    if (ready) return
    const timer = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [ready, secondsLeft])

  useEffect(() => {
    if (ready) continueRef.current?.focus()
    else panelRef.current?.focus()
  }, [ready])

  // Back/Escape closes the break, and keeps the key from the details panel underneath.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      event.preventDefault()
      cancelAdBreak()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <div
      className="tv-ad-break"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tv-ad-break-title"
      // React clicks bubble through the portal: keep them from the details panel's backdrop.
      onClick={(event) => event.stopPropagation()}
    >
      <div className="tv-ad-break__panel" ref={panelRef} tabIndex={-1}>
        <p className="tv-ad-break__eyebrow" id="tv-ad-break-title">
          Ad break
        </p>
        {TV_BANNER_ZONE ? (
          <AdSlot zone={TV_BANNER_ZONE} className="tv-ad-break__ad" />
        ) : (
          phoneUrl && (
            <div className="tv-ad-break__promo">
              <QrCode url={phoneUrl} label="QR code: watch this on your phone" size="9em" />
              <p>
                <strong>Scan to watch on your phone</strong>
                Same title, wherever you are.
              </p>
            </div>
          )
        )}
        {ready ? (
          <button ref={continueRef} type="button" className="tv-ad-break__continue" onClick={continueAfterAdBreak}>
            Continue <span aria-hidden="true">▶</span>
          </button>
        ) : (
          <p className="tv-ad-break__countdown" aria-live="polite">
            Your video starts in {secondsLeft}…
          </p>
        )}
        <p className="tv-ad-break__hint">Press Back to cancel</p>
      </div>
    </div>
  )
}
