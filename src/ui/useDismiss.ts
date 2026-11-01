import { useEffect, useRef } from 'react'
import { useAdOverlay } from '../ads/adManager'

/**
 * Closing popups the same way everywhere (the contest popups, the invite
 * guide, the monthly greeting): Escape, and the phone's Back button, which
 * closes the popup instead of leaving the page.
 */

/** Overlays open now; they share one extra history entry, so Back closes them. */
let openOverlays = 0
/** Our own history.back() (dropping the entry): its popstate isn't the visitor pressing Back. */
let ownBack = false

/** Closes on Escape and on the phone's Back button (an extra history entry while open). */
export function useDismiss(open: boolean, onClose: () => void) {
  // No ad (and no "ads are back" card) while a popup or the guide is open.
  useAdOverlay(open)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    if (!open) return
    if (openOverlays++ === 0 && !window.history.state?.naijatrOverlay) {
      window.history.pushState({ naijatrOverlay: true }, '', window.location.href)
    }
    const onPop = () => {
      if (ownBack) {
        ownBack = false
        // It removed the entry this overlay shares: put it back.
        window.history.pushState({ naijatrOverlay: true }, '', window.location.href)
        return
      }
      if (!window.history.state?.naijatrOverlay) closeRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    document.addEventListener('keydown', onKey)
    return () => {
      openOverlays -= 1
      window.removeEventListener('popstate', onPop)
      document.removeEventListener('keydown', onKey)
      // Closed some other way: drop the entry, unless another overlay took it over (popup → guide).
      window.setTimeout(() => {
        if (openOverlays === 0 && window.history.state?.naijatrOverlay) {
          ownBack = true
          // Cleared once it lands, even with no overlay open to see it; after this popstate's
          // other listeners, so an overlay that opened meanwhile still knows it's ours.
          window.addEventListener('popstate', () => window.setTimeout(() => (ownBack = false), 0), { once: true })
          window.history.back()
        }
      }, 0)
    }
  }, [open])
}
