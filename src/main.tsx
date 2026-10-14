import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { listenForInstallPrompt, registerServiceWorker } from './pwa'
import { isFootballPath } from './football/format'
import { FootballRoot } from './football/FootballRoot'

listenForInstallPrompt()
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The Football section (/football) is a separate root from the movie app. */}
    {isFootballPath(window.location.pathname) ? <FootballRoot /> : <App />}
  </StrictMode>,
)
