import './tv/polyfills'
// Next: keeps the code of a /r/CODE invite link (src/referral/capture.ts).
import './referral/capture'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './tv/tv.css'
import App from './App.tsx'
import { isDevHost } from './ads/directLink'
import { startLiveHeartbeat } from './live/heartbeat'
import { listenForInstallPrompt, registerServiceWorker } from './pwa'
import { isFootballPath } from './football/format'
import { FootballRoot } from './football/FootballRoot'
import { installRemote } from './tv/remote'
import { isTvMode } from './tv/tvMode'
import { initAccount } from './account/account'
import { installQuietZones } from './ads/adManager'

listenForInstallPrompt()
registerServiceWorker()
// Optional accounts: signed in on this device before, or back from an email link? Then sync starts.
initAccount()
// Smart TVs (detected in index.html): arrow-key navigation and the Back key.
if (isTvMode()) installRemote()

const root = document.getElementById('root')!
const app = createRoot(root)
// After the React root, so React still sees every tap: taps in the sign-in sheet and password forms never reach the Multitag.
installQuietZones(root)
app.render(
  <StrictMode>
    {/* The Football section (/football) is a separate root from the movie app. */}
    {isFootballPath(window.location.pathname) ? (
      <FootballRoot />
    ) : (
      <App />
    )}
  </StrictMode>,
)

// Live viewer counter (/admin/live): a heartbeat once a minute while the tab is visible.
if (!isDevHost()) startLiveHeartbeat()
