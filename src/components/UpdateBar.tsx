import { RefreshCw } from 'lucide-react'
import { applyUpdate, useUpdateReady } from '../pwa'
import './UpdateBar.css'

/**
 * "New update available, tap to refresh": shown once a new version has been
 * deployed and its service worker has taken over (src/pwa.ts). Tapping reloads
 * the app; nothing reloads by itself, so a playing film is never cut off.
 * Mount once per page (App, FootballRoot).
 */
export function UpdateBar() {
  const ready = useUpdateReady()
  if (!ready) return null
  return (
    <div role="status">
      <button type="button" className="update-bar" onClick={applyUpdate}>
        <RefreshCw aria-hidden="true" />
        <span>New update available, tap to refresh</span>
      </button>
    </div>
  )
}
