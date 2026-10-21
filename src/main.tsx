import './tv/polyfills'
// Next, before anything writes to storage: tells a new device from a returning one, and handles /r/CODE invite links.
import './referral/capture'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './tv/tv.css'
import App from './App.tsx'
import { loadMonetagTags } from './ads/monetag'
import { isDevHost } from './ads/directLink'
import { startLiveHeartbeat } from './live/heartbeat'
import { listenForInstallPrompt, registerServiceWorker } from './pwa'
import { isFootballPath } from './football/format'
import { FootballRoot } from './football/FootballRoot'
import { installRemote } from './tv/remote'
import { isTvMode } from './tv/tvMode'
import { isChallengePath } from './referral/guide'
import { ChallengeRoot } from './referral/ChallengeRoot'

listenForInstallPrompt()
registerServiceWorker()
// Smart TVs (detected in index.html): arrow-key navigation and the Back key.
if (isTvMode()) installRemote()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The Football section (/football) is a separate root from the movie app. */}
    {isFootballPath(window.location.pathname) ? (
      <FootballRoot />
    ) : isChallengePath(window.location.pathname) ? (
      <ChallengeRoot />
    ) : (
      <App />
    )}
  </StrictMode>,
)

// Live viewer counter (/admin/live): a heartbeat once a minute while the tab is visible.
if (!isDevHost()) startLiveHeartbeat()

// The Vignette / In-Page Push tags: only while ADS_ENABLED (src/config/ads.ts).
loadMonetagTags()
