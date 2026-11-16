import { useEffect, useRef } from 'react'
import { adsDisabled } from '../ads/directLink'
import { whenAdsAllowed } from '../ads/adGate'
import type { AdZone } from '../config/tvAds'

interface AdSlotProps {
  zone: AdZone
  className?: string
}

/**
 * A Monetag zone loaded into this box (TV only). Nothing in it is focusable
 * from our side, so the remote moves straight past it. Test visits (localhost,
 * ?noads=1) load nothing, so no impressions are wasted.
 */
export function AdSlot({ zone, className = '' }: AdSlotProps) {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box || adsDisabled()) return
    // Not while the welcome popup is due or open, nor in the 3 seconds after (src/ads/adGate.ts).
    const cancel = whenAdsAllowed(() => {
      const script = document.createElement('script')
      script.dataset.zone = zone.zone
      script.src = zone.src
      script.async = true
      box.append(script)
    })
    return () => {
      cancel()
      box.replaceChildren()
    }
  }, [zone.zone, zone.src])

  return (
    <aside className={`tv-ad-slot ${className}`} aria-label="Advertisement">
      <span className="tv-ad-slot__label">Advertisement</span>
      <div ref={boxRef} className="tv-ad-slot__box" />
    </aside>
  )
}
