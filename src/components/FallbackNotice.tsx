import { useState, useSyncExternalStore } from 'react'
import { RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useCatalogProvider } from '../data/provider'
import type { FallbackStatus } from '../types/media'
import './FallbackNotice.css'

const INACTIVE: FallbackStatus = { active: false, reason: null }
const noopSubscribe = () => () => {}

interface FallbackNoticeProps {
  onRetry: () => void
}

/** Explains when the live catalogue is down and sample titles are shown instead. */
export function FallbackNotice({ onRetry }: FallbackNoticeProps) {
  const store = useCatalogProvider().fallback
  const status = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getStatus ?? (() => INACTIVE),
  )
  const [dismissed, setDismissed] = useState<FallbackStatus | null>(null)

  if (!status.active || dismissed === status) return null

  return (
    <div className="fallback-notice" role="status">
      <TriangleAlert className="fallback-notice__icon" aria-hidden="true" />
      <p className="fallback-notice__text">
        <strong>Live catalogue unavailable.</strong> Showing sample titles instead.
        {status.reason && <span className="fallback-notice__reason"> {status.reason}</span>}
      </p>
      <div className="fallback-notice__actions">
        <button type="button" className="fallback-notice__retry" onClick={onRetry}>
          <RefreshCw aria-hidden="true" /> Try again
        </button>
        <button
          type="button"
          className="fallback-notice__dismiss"
          aria-label="Dismiss notice"
          onClick={() => setDismissed(status)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
