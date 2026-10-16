import { useState } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import {
  OFFICIAL_SITE,
  TELEGRAM_PITCH,
  TELEGRAM_USERNAME,
  telegramGoPath,
  type TelegramPlacement,
} from '../config/telegram'
import { useMediaQuery } from '../hooks/useMediaQuery'
import './Telegram.css'

/** Telegram's logo: a white paper plane on a blue circle. */
export function TelegramIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`tg-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="11" fill="#fff" />
      <path
        fill="#229ED9"
        d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
      />
    </svg>
  )
}

export const OfficialBadge = () => <span className="tg-official">Official</span>

/** NT logo + Telegram logo, side by side: ours, on Telegram. */
export const TelegramMarks = () => (
  <span className="tg-marks" aria-hidden="true">
    <img src="/favicon.svg" alt="" className="tg-marks__nt" />
    <TelegramIcon />
  </span>
)

/** "NAIJA TR Official Channel" with the OFFICIAL pill. */
export const OfficialChannelName = () => (
  <span className="tg-name">
    NAIJA TR Official Channel <OfficialBadge />
  </span>
)

interface TelegramLinkProps {
  from: TelegramPlacement
  className?: string
  children: ReactNode
  'aria-label'?: string
}

/**
 * A link to the channel through /go/telegram (which records the visit). A new
 * tab on desktop; on phones the same tab, so the hand-over to the Telegram app
 * doesn't leave an empty tab behind.
 */
export function TelegramLink({ from, className, children, ...rest }: TelegramLinkProps) {
  const touch = useMediaQuery('(pointer: coarse)')
  return (
    <a
      href={telegramGoPath(from)}
      className={className}
      target={touch ? undefined : '_blank'}
      rel="noopener"
      aria-label={rest['aria-label']}
    >
      {children}
    </a>
  )
}

const DISMISS_KEY = 'naijatr.telegramBanner.dismissedAt'
const DISMISS_DAYS = 7

function bannerDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY))
    return at > 0 && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

/** Home page: a slim banner under the hero. The X hides it for a week. */
export function TelegramBanner() {
  const [hidden, setHidden] = useState(bannerDismissed)
  if (hidden) return null
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
    } catch {
      // Storage blocked: hidden for this visit only.
    }
    setHidden(true)
  }
  return (
    <aside className="tg-banner" aria-label="NAIJA TR Official Channel on Telegram">
      <TelegramMarks />
      <div className="tg-banner__text">
        <OfficialChannelName />
        <p>{TELEGRAM_PITCH}</p>
      </div>
      <TelegramLink from="home-banner" className="tg-button">
        <TelegramIcon /> Join Channel
      </TelegramLink>
      <button type="button" className="tg-banner__close" aria-label="Dismiss for a week" onClick={dismiss}>
        <X aria-hidden="true" />
      </button>
    </aside>
  )
}

/** Details and match pages: a small card offering alerts. */
export function TelegramCard({ from }: { from: 'details' | 'match' }) {
  return (
    <aside className="tg-card" aria-label="NAIJA TR Official Channel on Telegram">
      <TelegramMarks />
      <div className="tg-card__text">
        <OfficialChannelName />
        <p>Get alerts from the official NAIJA TR channel when new episodes and matches drop, and for daily news updates.</p>
      </div>
      <TelegramLink from={from} className="tg-button">
        <TelegramIcon /> Join Channel
      </TelegramLink>
    </aside>
  )
}

/** Header: "Join our channel" on every page. */
export function TelegramHeaderLink() {
  return (
    <TelegramLink
      from="header"
      className="tg-header-link"
      aria-label="Join our channel: NAIJA TR Official Channel on Telegram"
    >
      <img src="/favicon.svg" alt="" className="tg-marks__nt tg-header-link__nt" />
      <TelegramIcon />
      <span>Join our channel</span>
      <OfficialBadge />
    </TelegramLink>
  )
}

/** Mobile menu: the full name, logo and badge. */
export function TelegramMenuLink() {
  return (
    <TelegramLink from="menu" className="tg-menu-link">
      <TelegramMarks />
      <OfficialChannelName />
    </TelegramLink>
  )
}

/** Footer: the handle, and our only website. */
export function TelegramFooter() {
  return (
    <div className="tg-footer">
      <p>
        <TelegramIcon /> Official Telegram:{' '}
        <TelegramLink from="footer" className="tg-footer__link">
          @{TELEGRAM_USERNAME}
        </TelegramLink>{' '}
        <OfficialBadge />
      </p>
      <p>Our only website is {OFFICIAL_SITE}</p>
    </div>
  )
}
