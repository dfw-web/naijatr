import { useEffect, useRef, useState } from 'react'
import { Bookmark, LogOut, UserRound } from 'lucide-react'
import { isTvMode } from '../tv/tvMode'
import { openSignIn, signOut, useAccount } from './account'
import { goToPage } from './pages'
import { PremiumAvatar } from './PremiumAvatar'
import { usePremium } from '../referral/status'
import './account.css'

/**
 * The header's account corner: "Sign in to sync" while signed out; the
 * account's initial, with My List, Account and Sign out, while signed in.
 * Nothing while accounts are off, or on TVs.
 */
export function AccountMenu() {
  const { status, user } = useAccount()
  const premium = usePremium()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (status === 'disabled' || isTvMode()) return null
  if (status === 'signedOut') {
    return (
      <button type="button" className="account-signin" onClick={() => openSignIn()}>
        Sign in to sync
      </button>
    )
  }
  if (status === 'checking' || !user) return <span className="account-avatar account-avatar--loading" aria-hidden="true" />

  const go = (page: 'my-list' | 'account') => {
    setOpen(false)
    goToPage(page)
  }
  return (
    <div ref={ref} className="account-menu">
      <button
        type="button"
        className="account-avatar"
        aria-label={`Account: ${user.email}${premium ? ' (Premium)' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        <PremiumAvatar email={user.email} premium={premium} />
      </button>
      {open && (
        <div className="account-menu__list" role="menu">
          <div className="account-menu__head">
            <PremiumAvatar email={user.email} premium={premium} size={34} />
            <div className="account-menu__who">
              <p className="account-menu__email">{user.email}</p>
              {premium && <span className="premium-label">👑 Premium</span>}
            </div>
          </div>
          <button type="button" role="menuitem" onClick={() => go('my-list')}>
            <Bookmark aria-hidden="true" /> My List
          </button>
          <button type="button" role="menuitem" onClick={() => go('account')}>
            <UserRound aria-hidden="true" /> Account
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
          >
            <LogOut aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}
