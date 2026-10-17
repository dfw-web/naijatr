import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { OfficialBadge, TelegramIcon, TelegramLink } from '../components/Telegram'
import { TELEGRAM_CHANNEL_URL, TELEGRAM_USERNAME } from '../config/telegram'
import { QrCode } from '../tv/QrCode'
import { cancelGate, passGate, usePendingGate } from './gateStore'
import './TelegramGate.css'

/** Render once per root (App and Football). Shows the gate while a Play waits on it. */
export function TelegramGateHost() {
  const pending = usePendingGate()
  if (!pending) return null
  return createPortal(pending.tv ? <TvGate /> : <PhoneGate />, document.body)
}

const Brand = () => (
  <div className="tg-gate__brand">
    <img src="/favicon.svg" alt="" className="tg-gate__logo" />
    <TelegramIcon className="tg-gate__tg" />
    <span className="tg-gate__name">
      NAIJA TR <OfficialBadge />
    </span>
  </div>
)

const Title = () => (
  <h2 id="tg-gate-title" className="tg-gate__title">
    Follow the official NAIJA TR channel to start watching <span aria-hidden="true">🎬⚽</span>
  </h2>
)

/** Phones and tablets: one button. It opens the channel in a new tab and starts the video here. */
function PhoneGate() {
  const panelRef = useRef<HTMLDivElement>(null)
  useGateKeys(panelRef, cancelGate)
  return (
    <div
      className="tg-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tg-gate-title"
      aria-describedby="tg-gate-text"
      // React clicks bubble through the portal: keep them from the details panel's backdrop.
      onClick={(event) => event.stopPropagation()}
    >
      <div className="tg-gate__panel" ref={panelRef} tabIndex={-1}>
        <button type="button" className="tg-gate__close" aria-label="Not now" onClick={cancelGate}>
          <X aria-hidden="true" />
        </button>
        <Brand />
        <Title />
        <p id="tg-gate-text" className="tg-gate__text">
          Get the latest movies, series, match links and NAIJA TR news first.
        </p>
        <TelegramLink from="gate" className="tg-button tg-gate__button" newTab onClick={passGate}>
          <TelegramIcon /> Join @{TELEGRAM_USERNAME} on Telegram
        </TelegramLink>
        <p className="tg-gate__note">Your video starts as soon as you tap Join.</p>
      </div>
    </div>
  )
}

/** TVs: a QR code to the channel, then Continue. Shown once per TV. */
function TvGate() {
  const panelRef = useRef<HTMLDivElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  useEffect(() => continueRef.current?.focus(), [])
  useGateKeys(panelRef, cancelGate)
  return (
    <div className="tg-gate tg-gate--tv" role="dialog" aria-modal="true" aria-labelledby="tg-gate-title" onClick={(event) => event.stopPropagation()}>
      <div className="tg-gate__panel" ref={panelRef}>
        <Brand />
        <Title />
        <div className="tg-gate__qr">
          <QrCode url={TELEGRAM_CHANNEL_URL} label={`QR code: join @${TELEGRAM_USERNAME} on Telegram`} size="10em" />
          <p>
            <strong>Scan to join @{TELEGRAM_USERNAME}</strong>
            Get the latest movies, series, match links and NAIJA TR news first.
          </p>
        </div>
        <button ref={continueRef} type="button" className="tg-gate__continue" onClick={passGate}>
          Continue <span aria-hidden="true">▶</span>
        </button>
        <p className="tg-gate__note">Press Back to cancel</p>
      </div>
    </div>
  )
}

/** Escape closes the gate; Tab stays inside it (the details panel underneath has its own keys). */
function useGateKeys(panelRef: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    panelRef.current?.focus()
    window.addEventListener('popstate', onClose)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      event.stopImmediatePropagation()
      event.preventDefault()
      if (event.key === 'Escape') return onClose()
      const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? [])]
      const index = items.indexOf(document.activeElement as HTMLElement)
      items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('popstate', onClose)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [panelRef, onClose])
}
