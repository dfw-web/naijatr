import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { OfficialBadge, TelegramIcon, TelegramLink } from '../components/Telegram'
import { TELEGRAM_CHANNEL_URL, TELEGRAM_USERNAME } from '../config/telegram'
import { QrCode } from '../tv/QrCode'
import {
  cancelGate,
  passGate,
  resumeTelegramRedirect,
  usePendingGate,
  verifyLogin,
  type GateStatus,
  type TelegramAuthData,
} from './gateStore'
import './TelegramGate.css'

const WIDGET_SRC = 'https://telegram.org/js/telegram-widget.js?22'
/** Give up waiting for Telegram's script or our config after this long, and let the visitor through. */
const SETUP_TIMEOUT_MS = 10000

declare global {
  interface Window {
    Telegram?: {
      Login?: { auth: (options: { bot_id: number }, callback: (data: TelegramAuthData | false) => void) => void }
    }
  }
}

let widgetScript: Promise<void> | null = null

/** Telegram's official Login Widget script, loaded the first time the gate opens. */
function loadWidget(): Promise<void> {
  widgetScript ??= new Promise<void>((resolve, reject) => {
    if (window.Telegram?.Login) return resolve()
    const script = document.createElement('script')
    script.src = WIDGET_SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      widgetScript = null
      reject(new Error('Telegram widget failed to load'))
    }
    document.head.append(script)
  })
  return widgetScript
}

/** The bot's numeric id, from our server (it's derived from the bot token, which stays there). */
async function loadBotId(): Promise<number> {
  const response = await fetch('/api/telegram/config')
  const body = (await response.json()) as { botId?: number }
  if (!body.botId) throw new Error('Telegram gate not configured')
  return body.botId
}

/** Render once per root (App and Football). Shows the gate while a Play waits on it. */
export function TelegramGateHost() {
  const pending = usePendingGate()
  useEffect(resumeTelegramRedirect, [])
  if (!pending) return null
  return createPortal(
    pending.tv ? <TvGate /> : <PhoneGate initialStatus={pending.status} />,
    document.body,
  )
}

type Setup = { state: 'loading' } | { state: 'ready'; botId: number } | { state: 'failed' }
type Check = GateStatus | 'idle' | 'checking' | 'cancelled'

const MESSAGES: Partial<Record<Check, string>> = {
  'not-joined': 'We couldn’t find you in the channel yet. Join, then tap Verify again.',
  invalid: 'Telegram couldn’t confirm your login. Tap Verify to try again.',
  cancelled: 'Telegram login was closed. Tap Verify to try again.',
}

function PhoneGate({ initialStatus }: { initialStatus?: GateStatus }) {
  const [setup, setSetup] = useState<Setup>({ state: 'loading' })
  const [check, setCheck] = useState<Check>(initialStatus ?? 'idle')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    const timeout = new Promise<never>((_, reject) =>
      window.setTimeout(() => reject(new Error('Telegram setup timed out')), SETUP_TIMEOUT_MS),
    )
    Promise.race([Promise.all([loadBotId(), loadWidget()]), timeout])
      .then(([botId]) => live && setSetup({ state: 'ready', botId }))
      .catch(() => live && setSetup({ state: 'failed' }))
    return () => {
      live = false
    }
  }, [])

  useGateKeys(panelRef, cancelGate)

  const verify = () => {
    // Telegram (or our setup) is unavailable: never lock anyone out.
    if (setup.state === 'failed' || !window.Telegram?.Login) return passGate('unavailable')
    if (setup.state !== 'ready') return
    // Synchronous, inside the tap, so Safari allows Telegram's login popup.
    window.Telegram.Login.auth({ bot_id: setup.botId }, (data) => {
      if (!data) return setCheck('cancelled')
      setCheck('checking')
      void verifyLogin(data).then((status) => setCheck(status))
    })
  }

  const busy = setup.state === 'loading' || check === 'checking'
  const message = MESSAGES[check]

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
        <div className="tg-gate__brand">
          <img src="/favicon.svg" alt="" className="tg-gate__logo" />
          <TelegramIcon className="tg-gate__tg" />
          <span className="tg-gate__name">
            NAIJA TR <OfficialBadge />
          </span>
        </div>
        <h2 id="tg-gate-title" className="tg-gate__title">
          Follow the official NAIJA TR channel to start watching <span aria-hidden="true">🎬⚽</span>
        </h2>
        <p id="tg-gate-text" className="tg-gate__text">
          Get the latest movies, series, match links and NAIJA TR news first.
        </p>

        <ol className="tg-gate__steps">
          <li>
            <span className="tg-gate__step">Step 1</span>
            <TelegramLink from="gate" className="tg-button tg-gate__button" newTab>
              <TelegramIcon /> Join @{TELEGRAM_USERNAME} on Telegram
            </TelegramLink>
          </li>
          <li>
            <span className="tg-gate__step">Step 2</span>
            <button type="button" className="tg-gate__verify" onClick={verify} disabled={busy} aria-busy={busy}>
              {check === 'checking' ? 'Checking…' : setup.state === 'loading' ? 'Connecting to Telegram…' : 'I’ve joined – Verify'}
            </button>
          </li>
        </ol>

        {message && (
          <p className="tg-gate__message" role="alert">
            {message}
          </p>
        )}
        <p className="tg-gate__note">We only check that you joined our channel. We don’t post or message you.</p>
      </div>
    </div>
  )
}

/** TVs can't log in to Telegram: a QR code to the channel, then Continue. Shown once per TV. */
function TvGate() {
  const panelRef = useRef<HTMLDivElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  useEffect(() => continueRef.current?.focus(), [])
  useGateKeys(panelRef, cancelGate)
  return (
    <div className="tg-gate tg-gate--tv" role="dialog" aria-modal="true" aria-labelledby="tg-gate-title" onClick={(event) => event.stopPropagation()}>
      <div className="tg-gate__panel" ref={panelRef}>
        <div className="tg-gate__brand">
          <img src="/favicon.svg" alt="" className="tg-gate__logo" />
          <TelegramIcon className="tg-gate__tg" />
          <span className="tg-gate__name">
            NAIJA TR <OfficialBadge />
          </span>
        </div>
        <h2 id="tg-gate-title" className="tg-gate__title">
          Follow the official NAIJA TR channel to start watching <span aria-hidden="true">🎬⚽</span>
        </h2>
        <div className="tg-gate__qr">
          <QrCode url={TELEGRAM_CHANNEL_URL} label={`QR code: join @${TELEGRAM_USERNAME} on Telegram`} size="10em" />
          <p>
            <strong>Scan to join @{TELEGRAM_USERNAME}</strong>
            Get the latest movies, series, match links and NAIJA TR news first.
          </p>
        </div>
        <button ref={continueRef} type="button" className="tg-gate__verify" onClick={() => passGate('tv')}>
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
