import { useId } from 'react'
import { usePremium } from '../referral/status'
import './PremiumAvatar.css'

/**
 * The account's round avatar (the first letter of its email), with a gold
 * crown and a gold ring for 👑 Premium accounts: their own ad-free (paid,
 * referral, AD_FREE_EMAILS) or the welcome trial, by the server's answer
 * (src/referral/status.ts). The promo week alone doesn't count.
 *
 * The crown is drawn over the circle (absolutely placed), so it never moves
 * or resizes anything around the avatar; it comes and goes live with the
 * status.
 */
export interface PremiumAvatarProps {
  email: string
  /** The circle's size in px (the header's is 36). */
  size?: number
  /** Premium or not; by default, the signed-in account's own status. */
  premium?: boolean
  className?: string
}

export function PremiumAvatar({ email, size = 36, premium, className }: PremiumAvatarProps) {
  const own = usePremium()
  const crowned = premium ?? own
  const initial = (email.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      className={['premium-avatar', crowned ? 'premium-avatar--premium' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ '--avatar-size': `${size}px` } as React.CSSProperties}
      data-premium={crowned ? 'true' : undefined}
    >
      <span className="premium-avatar__circle" aria-hidden="true">
        {initial}
      </span>
      {crowned && <PremiumCrown />}
    </span>
  )
}

/** The avatar (👑 crowned for Premium), the email and "👑 Premium": the account and invite pages. */
export function AccountIdentity({ email }: { email: string }) {
  const premium = usePremium()
  return (
    <div className="account-identity">
      <PremiumAvatar email={email} premium={premium} size={44} />
      <div className="account-identity__who">
        <p className="account-card__value">{email}</p>
        {premium && <span className="premium-label">👑 Premium (ad-free)</span>}
      </div>
    </div>
  )
}

/** The crown: five points with round jewels, a band with three gems (red, green, white), gold, with one shine on load. */
export function PremiumCrown({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '')
  const gold = `crown-gold-${id}`
  const jewel = `crown-jewel-${id}`
  const shine = `crown-shine-${id}`
  const clip = `crown-clip-${id}`
  const body = 'M9 39 L6.5 16 L15 27.5 L19.5 10 L26.5 25.5 L32 4.5 L37.5 25.5 L44.5 10 L49 27.5 L57.5 16 L55 39 Z'
  return (
    <svg className={['premium-crown', className ?? ''].filter(Boolean).join(' ')} viewBox="0 0 64 52" role="img" aria-label="Premium">
      <defs>
        <linearGradient id={gold} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE680" />
          <stop offset="0.5" stopColor="#F5C518" />
          <stop offset="1" stopColor="#C9971A" />
        </linearGradient>
        <radialGradient id={jewel} cx="0.35" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#FFF6CC" />
          <stop offset="0.55" stopColor="#F5C518" />
          <stop offset="1" stopColor="#C9971A" />
        </radialGradient>
        <linearGradient id={shine} x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clip}>
          <path d={body} />
          <rect x="7" y="37" width="50" height="11" rx="2.5" />
        </clipPath>
      </defs>
      <g stroke="#8A6410" strokeWidth="1.6" strokeLinejoin="round">
        <path d={body} fill={`url(#${gold})`} />
        <rect x="7" y="37" width="50" height="11" rx="2.5" fill={`url(#${gold})`} />
        {[
          [6.5, 16],
          [19.5, 10],
          [32, 4.5],
          [44.5, 10],
          [57.5, 16],
        ].map(([cx, cy]) => (
          <circle key={cx} cx={cx} cy={cy} r="3.4" fill={`url(#${jewel})`} />
        ))}
      </g>
      {/* Naija: red, green, white. */}
      <g strokeWidth="1" stroke="#5C420A">
        <circle cx="20" cy="42.5" r="2.7" fill="#E0242F" />
        <circle cx="32" cy="42.5" r="2.7" fill="#008751" />
        <circle cx="44" cy="42.5" r="2.7" fill="#FFFFFF" />
      </g>
      <g clipPath={`url(#${clip})`}>
        <rect className="premium-crown__shine" x="-34" y="0" width="26" height="52" fill={`url(#${shine})`} />
      </g>
    </svg>
  )
}
