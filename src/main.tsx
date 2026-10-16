import './tv/polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './tv/tv.css'
import App from './App.tsx'
import { loadMonetagTags } from './ads/monetag'
import { listenForInstallPrompt, registerServiceWorker } from './pwa'
import { isFootballPath } from './football/format'
import { FootballRoot } from './football/FootballRoot'
import { installRemote } from './tv/remote'
import { isTvMode } from './tv/tvMode'

listenForInstallPrompt()
registerServiceWorker()
// Smart TVs (detected in index.html): arrow-key navigation and the Back key.
if (isTvMode()) installRemote()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The Football section (/football) is a separate root from the movie app. */}
    {isFootballPath(window.location.pathname) ? <FootballRoot /> : <App />}
  </StrictMode>,
)

// The Vignette / In-Page Push tags: only while ADS_ENABLED (src/config/ads.ts).
loadMonetagTags()
