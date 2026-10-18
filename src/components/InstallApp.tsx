import { useEffect, useRef } from 'react'
import { Download, EllipsisVertical, Share, SquarePlus, X } from 'lucide-react'
import { useInstallOffer } from '../pwa'
import { closeInstallSteps, dismissInstallBar, startInstall, trackInstall, useInstallBarDismissed, useInstallStepsOpen } from '../installAppStore'
import { isTvMode } from '../tv/tvMode'
import './InstallApp.css'

/**
 * "Download app": a solid button in the header and a bar along the bottom of
 * the screen, for anyone who hasn't installed the app yet. Chrome/Edge open
 * the browser's install dialog; iPhone and iPad show how to add it from
 * Safari's Share menu, and other Android browsers (e.g. Telegram's) how to
 * add it from the menu, since neither has an install dialog. Neither shows inside the
 * installed app or on TVs. The bar's ✕ hides it for a few days; the header
 * button stays.
 */

/** The header's button. */
export function InstallAppButton({ className }: { className: string }) {
  const offer = useInstallOffer()
  if (!offer || isTvMode()) return null
  return (
    <button type="button" className={className} onClick={() => startInstall(offer, 'header')}>
      <Download aria-hidden="true" /> Download app
    </button>
  )
}

/** The bottom bar and the iPhone steps. Mount once per page (App, FootballRoot). */
export function InstallAppHost() {
  const offer = useInstallOffer()
  const stepsOpen = useInstallStepsOpen()
  const dismissed = useInstallBarDismissed()
  const showBar = offer !== null && !dismissed && !isTvMode()

  // Keep the page's last lines clear of the bar.
  useEffect(() => {
    document.documentElement.classList.toggle('has-install-bar', showBar)
    return () => document.documentElement.classList.remove('has-install-bar')
  }, [showBar])

  useEffect(() => {
    const onInstalled = () => trackInstall('/go/app-installed')
    window.addEventListener('appinstalled', onInstalled)
    return () => window.removeEventListener('appinstalled', onInstalled)
  }, [])

  return (
    <>
      {showBar && (
        <aside className="install-bar" aria-label="Download the NAIJA TR app">
          <img className="install-bar__icon" src="/icons/icon-192.png" alt="" width={44} height={44} />
          <p className="install-bar__text">
            <strong>NAIJA TR app</strong>
            <span>Free · opens full screen</span>
          </p>
          <button type="button" className="install-bar__button" onClick={() => startInstall(offer, 'bar')}>
            <Download aria-hidden="true" /> Download app
          </button>
          <button type="button" className="install-bar__close" aria-label="Not now" onClick={dismissInstallBar}>
            <X aria-hidden="true" />
          </button>
        </aside>
      )}
      {stepsOpen && <InstallSteps platform={stepsOpen} onClose={closeInstallSteps} />}
    </>
  )
}

function InstallSteps({ platform, onClose }: { platform: 'ios' | 'android'; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="install-steps" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="install-steps__panel" role="dialog" aria-modal="true" aria-labelledby="install-steps-title">
        <button ref={closeRef} type="button" className="install-steps__close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        <img className="install-steps__icon" src="/icons/icon-192.png" alt="" width={64} height={64} />
        <h2 id="install-steps-title" className="install-steps__title">
          Add NAIJA TR to your home screen
        </h2>
        {platform === 'ios' ? (
          <ol className="install-steps__list">
            <li>
              <span className="install-steps__num">1</span>
              <span>
                Tap the <Share aria-label="Share" className="install-steps__glyph" /> <strong>Share</strong> button in
                Safari&apos;s toolbar.
              </span>
            </li>
            <li>
              <span className="install-steps__num">2</span>
              <span>
                Scroll down and tap <SquarePlus aria-hidden="true" className="install-steps__glyph" />{' '}
                <strong>Add to Home Screen</strong>.
              </span>
            </li>
            <li>
              <span className="install-steps__num">3</span>
              <span>
                Tap <strong>Add</strong>. NAIJA TR is now on your home screen, like an app.
              </span>
            </li>
          </ol>
        ) : (
          <ol className="install-steps__list">
            <li>
              <span className="install-steps__num">1</span>
              <span>
                Opened from Telegram or another app? Tap its <EllipsisVertical aria-label="menu" className="install-steps__glyph" />{' '}
                menu and choose <strong>Open in Chrome</strong> first.
              </span>
            </li>
            <li>
              <span className="install-steps__num">2</span>
              <span>
                In Chrome, tap the <EllipsisVertical aria-label="menu" className="install-steps__glyph" /> menu at the top
                right.
              </span>
            </li>
            <li>
              <span className="install-steps__num">3</span>
              <span>
                Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>), then <strong>Install</strong>.
              </span>
            </li>
          </ol>
        )}
        <button type="button" className="install-steps__done" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  )
}

