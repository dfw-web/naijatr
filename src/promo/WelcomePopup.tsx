import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useAccount } from '../account/account'
import { authButton, NO_AD_ATTR, onAuthTap } from '../ads/authGuard'
import { useDismiss } from '../ui/useDismiss'
import { useHoldNotices } from '../ui/noticeQueue'
import { useReferralStatus } from '../referral/status'
import { closeWelcomePopup, reportWelcome, useWelcomePopupOpen, welcomeWording } from './welcomeStore'
import './WelcomePopup.css'

/** The source a sign-up from this popup is counted under (profiles.signup_source, /admin/live). */
export const WELCOME_SOURCE = 'welcome-popup'

const noAd = { [NO_AD_ATTR]: '' }

/**
 * The welcome popup for signed-out visitors (the rules: welcomeStore.ts).
 * Everything in it is data-no-ad; no ad script is on the page while it's
 * open (src/ads/adGate.ts). Its two auth buttons are handled by the auth
 * guard before anything else hears the tap: a full page load to /signup or
 * /login (?next= this page).
 */
export function WelcomePopupHost() {
  const open = useWelcomePopupOpen()
  const account = useAccount()
  const status = useReferralStatus()
  const primary = useRef<HTMLButtonElement>(null)
  // Escape and the phone's Back button close it; no ad and no other popup meanwhile.
  useDismiss(open, () => closeWelcomePopup())
  useHoldNotices(open)

  // Signed in meanwhile (another tab): gone, uncounted.
  useEffect(() => {
    if (open && account.status === 'signedIn') closeWelcomePopup(false)
  }, [open, account.status])

  // Its own taps, counted as the auth guard opens the page.
  useEffect(() => {
    if (!open) return
    return onAuthTap((button) => {
      const event = button.dataset.welcomeEvent
      if (event === 'welcome-signup' || event === 'welcome-login') reportWelcome(event)
    })
  }, [open])

  useEffect(() => {
    if (open) primary.current?.focus({ preventScroll: true })
  }, [open])

  if (!open) return null
  const { promo, trial } = welcomeWording(status)
  return (
    <div
      className="welcome"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      aria-describedby="welcome-text"
      {...noAd}
      onClick={(event) => {
        // A tap outside the card.
        if (event.target === event.currentTarget) closeWelcomePopup()
      }}
    >
      <div className="welcome__card" {...noAd}>
        <button type="button" className="welcome__close" aria-label="Close" {...noAd} onClick={() => closeWelcomePopup()}>
          <X aria-hidden="true" />
        </button>
        <p className="welcome__logo" {...noAd}>
          <img src="/favicon.svg" alt="" className="brand-mark" /> NAIJA TR
        </p>
        {promo ? (
          <>
            <h2 id="welcome-title" className="welcome__title" {...noAd}>
              🎉 NAIJA TR is <span className="welcome__nowrap">ad-free</span> this week!
            </h2>
            <p id="welcome-text" className="welcome__text" {...noAd}>
              {trial
                ? 'Sign up free now and stay 👑 Premium (ad-free) for 2 extra days after the promo ends. Plus Continue Watching and My List on all your devices.'
                : 'Sign up free now and watch ad-free all week. Plus Continue Watching and My List on all your devices.'}
            </p>
          </>
        ) : (
          <>
            <h2 id="welcome-title" className="welcome__title" {...noAd}>
              😩 Tired of ads?
            </h2>
            <p id="welcome-text" className="welcome__text" {...noAd}>
              {trial
                ? 'Sign up free and enjoy 👑 NAIJA TR Premium, ad-free, for 2 days. Plus Continue Watching and My List on all your devices.'
                : 'Sign up free and get Continue Watching and My List on all your devices.'}
            </p>
          </>
        )}
        <div className="welcome__actions" {...noAd}>
          <button ref={primary} type="button" className="welcome__primary" data-welcome-event="welcome-signup" {...authButton('signup', WELCOME_SOURCE)}>
            Sign up free
          </button>
          <button type="button" className="welcome__link" data-welcome-event="welcome-login" {...authButton('login')}>
            I already have an account, <span className="welcome__link-strong">Log in</span>
          </button>
          <button type="button" className="welcome__ghost" {...noAd} onClick={() => closeWelcomePopup()}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
