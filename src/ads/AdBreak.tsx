import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { closeAdBreak, useAdBreak } from './adBreakStore'
import { setAdStatus } from './adStatus'
import { openAdFromAdBreak } from './directLink'
import './AdBreak.css'

const SKIP_AFTER_S = 5

interface AdBreakProps {
  /** This page's ad key (title or match). The break shows only if this page's ad was blocked. */
  adKey: string
}

/**
 * Shown once per page when the browser blocked the ad tab (Safari on iPhone):
 * "Continue" opens the ad from a fresh tap, which Safari allows, and closes the
 * break. "Skip" appears after a few seconds. Either way the page underneath
 * keeps working; Back also closes it.
 */
export function AdBreak({ adKey }: AdBreakProps) {
  const open = useAdBreak(adKey)
  if (!open) return null
  return createPortal(<AdBreakPanel onClose={closeAdBreak} />, document.body)
}

function AdBreakPanel({ onClose }: { onClose: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(SKIP_AFTER_S)
  const panelRef = useRef<HTMLDivElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  const canSkip = secondsLeft === 0

  useEffect(() => {
    if (canSkip) return
    const timer = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [canSkip, secondsLeft])

  useEffect(() => {
    continueRef.current?.focus()
    // Back closes the break instead of trapping the visitor.
    window.addEventListener('popstate', onClose)
    return () => window.removeEventListener('popstate', onClose)
  }, [onClose])

  // Keys stay with the break (the details panel underneath would close on Escape).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        if (canSkip) skip()
        return
      }
      const buttons = [...(panelRef.current?.querySelectorAll<HTMLElement>('button') ?? [])]
      const index = buttons.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
    }
    const skip = () => {
      setAdStatus('fallback-skip')
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [canSkip, onClose])

  return (
    <div
      className="ad-break"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ad-break-title"
      // React clicks bubble through the portal: keep them from the details panel's backdrop, which closes it.
      onClick={(event) => event.stopPropagation()}
    >
      <div className="ad-break__panel" ref={panelRef}>
        <p className="ad-break__eyebrow">Ad break</p>
        <h2 id="ad-break-title" className="ad-break__title">
          Ads keep NAIJA TR free
        </h2>
        <p className="ad-break__text">Continue opens a sponsor page in a new tab, then you’re straight back here.</p>
        <button
          ref={continueRef}
          type="button"
          className="ad-break__continue"
          onClick={() => {
            // Synchronous, inside this tap: Safari allows the new tab.
            openAdFromAdBreak()
            setAdStatus('fallback-continue')
            onClose()
          }}
        >
          Continue <span aria-hidden="true">▶</span>
        </button>
        {canSkip ? (
          <button
            type="button"
            className="ad-break__skip"
            onClick={() => {
              setAdStatus('fallback-skip')
              onClose()
            }}
          >
            Skip
          </button>
        ) : (
          <p className="ad-break__wait" aria-live="polite">
            Skip in {secondsLeft}s
          </p>
        )}
      </div>
    </div>
  )
}
