import { isTvMode } from '../tv/tvMode'
import { authButton } from '../ads/authGuard'
import { defaultAuthPage, openSignIn, useAccount } from './account'
import { goToAuthPage } from './pages'
import { PremiumAvatar } from './PremiumAvatar'
import { usePremium } from '../referral/status'
import './account.css'

/**
 * The header's account corner: "Sign in to sync" while signed out (/login or
 * /signup); the account's initial while signed in (/account, with My List,
 * the password and Sign out). Both open their page with a full page load, and
 * the tap never reaches an ad script (src/ads/authGuard.ts). Nothing while
 * accounts are off, or on TVs.
 */
export function AccountMenu() {
  const { status, user } = useAccount()
  const premium = usePremium()

  if (status === 'disabled' || isTvMode()) return null
  if (status === 'signedOut') {
    return (
      <button type="button" className="account-signin" {...authButton(defaultAuthPage())} onClick={() => openSignIn()}>
        Sign in to sync
      </button>
    )
  }
  if (status === 'checking' || !user) return <span className="account-avatar account-avatar--loading" aria-hidden="true" />

  return (
    <div className="account-menu">
      <button
        type="button"
        className="account-avatar"
        {...authButton('account')}
        aria-label={`Account: ${user.email}${premium ? ' (Premium)' : ''}`}
        onClick={() => goToAuthPage('account')}
      >
        <PremiumAvatar email={user.email} premium={premium} />
      </button>
    </div>
  )
}
