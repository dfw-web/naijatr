import './tv/polyfills'
// First, before any ad script can exist: auth taps never reach one (src/ads/authGuard.ts).
import { installAuthGuard } from './ads/authGuard'
installAuthGuard()
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
import { isDramasPath } from './dramas/format'
import { DramasRoot } from './dramas/DramasRoot'
import { installRemote } from './tv/remote'
import { isTvMode } from './tv/tvMode'
import { initAccount } from './account/account'
import { installQuietZones } from './ads/adManager'
import { isAuthPath } from './account/pages'
import { AuthRoot } from './account/AuthRoot'
import { startWelcomePopup } from './promo/welcomeStore'

listenForInstallPrompt()
registerServiceWorker()
// Optional accounts: signed in on this device before, or back from an email link? Then sync starts.
initAccount()
// Signed-out visitors: the welcome popup, ~1.5 s in; no ad script until 3 s after it closes (src/promo/welcomeStore.ts).
startWelcomePopup()
// Smart TVs (detected in index.html): arrow-key navigation and the Back key.
if (isTvMode()) installRemote()

const root = document.getElementById('root')!
const app = createRoot(root)
// After the React root, so React still sees every tap: taps on the football player never reach the Multitag.
installQuietZones(root)
app.render(
  <StrictMode>
    {/* The auth pages (/login, /signup, /auth/*) and the Football section (/football) are separate roots from the movie app. */}
    {isAuthPath(window.location.pathname) ? (
      <AuthRoot />
    ) : isFootballPath(window.location.pathname) ? (
      <FootballRoot />
    ) : isDramasPath(window.location.pathname) ? (
      <DramasRoot />
    ) : (
      <App />
    )}
  </StrictMode>,
)

// Live viewer counter (/admin/live): a heartbeat once a minute while the tab is visible.
if (!isDevHost()) startLiveHeartbeat()
