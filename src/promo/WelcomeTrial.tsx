import { X } from 'lucide-react'
import { openSignUpFrom } from '../account/account'
import { goToPage } from '../account/pages'
import { holdAdsThisTap, useAdOverlay } from '../ads/adManager'
import { FROM_PRICE, naira } from '../config/adFree'
import { goalNow, serverTime, usePremium, useReferralStatus } from '../referral/status'
import { isTvMode } from '../tv/tvMode'
import { useHoldNotices } from '../ui/noticeQueue'
import { markSeenBy, seenBy, useFreeMoment } from './freeMoment'
import { closeTrialPrompt, continueWithAds, useTrialPromptOpen } from './trialPrompt'
import '../referral/referral.css'
import './PromoWeek.css'

/**
 * The 48-hour Premium welcome trial's messages (the rule itself is on the
 * server: server/trial.ts). No countdown or timer anywhere.
 *
 * - TrialPromptHost: the Play popup for signed-out visitors (trialPrompt.ts).
 * - TrialWelcomeHost: "🎉 Welcome! You're 👑 Premium (ad-free) for 2 days." once.
 * - TrialEndedHost: "Your 2-day Premium has ended 🙏" once, when it's over
 *   (not for accounts that are Premium some other way).
 */

const WELCOME_KEY = 'naijatr.trial.welcome'
const ENDED_KEY = 'naijatr.trial.ended'
/** The ended message only shows this long after the trial. */
const ENDED_NOTICE_FOR_MS = 14 * 24 * 60 * 60 * 1000

export function TrialPromptHost() {
  const open = useTrialPromptOpen()
  useAdOverlay(open)
  useHoldNotices(open)
  if (!open) return null
  return (
    <div className="promo" role="dialog" aria-modal="true" aria-labelledby="trial-prompt-title">
      <div className="promo__panel">
        <button type="button" className="promo__close" aria-label="Close" onClick={continueWithAds}>
          <X aria-hidden="true" />
        </button>
        <p id="trial-prompt-title" className="promo__title">
          😩 Tired of ads?
        </p>
        <p className="promo__text">Sign up free and get 👑 Premium (ad-free) for 2 days!</p>
        <div className="promo__actions">
          <button
            type="button"
            className="promo__primary"
            onClick={() => {
              closeTrialPrompt()
              openSignUpFrom('play-popup')
            }}
          >
            Sign up free
          </button>
          <button type="button" className="promo__ghost" onClick={continueWithAds}>
            Continue with ads
          </button>
        </div>
      </div>
    </div>
  )
}

/** Their trial is running: told once per account on this device, right after they've confirmed their email. */
export function TrialWelcomeHost() {
  const status = useReferralStatus()
  const premium = usePremium()
  const userId = status?.signedIn ? (status.userId ?? null) : null
  const eligible = userId !== null && premium && status?.trialOnly === true && !isTvMode()
  const [open, close] = useFreeMoment(eligible, userId !== null && !seenBy(WELCOME_KEY, userId), () => {
    if (!userId || seenBy(WELCOME_KEY, userId)) return false
    markSeenBy(WELCOME_KEY, userId)
    return true
  })
  useAdOverlay(open)
  useHoldNotices(open)
  if (!open) return null
  return (
    <div className="promo" role="dialog" aria-modal="true" aria-labelledby="trial-welcome-title">
      <div className="promo__panel">
        <p id="trial-welcome-title" className="promo__title">
          🎉 Welcome! You're 👑 Premium (ad-free) for 2 days.
        </p>
        <div className="promo__actions">
          <button
            type="button"
            className="promo__primary"
            onClick={() => {
              holdAdsThisTap()
              close()
            }}
          >
            Enjoy 🍿
          </button>
        </div>
      </div>
    </div>
  )
}

/** The trial is over and they're not Premium otherwise: told once per account on this device. */
export function TrialEndedHost() {
  const status = useReferralStatus()
  const premium = usePremium()
  const userId = status?.signedIn ? (status.userId ?? null) : null
  const until = status?.signedIn && status.trialUntil ? Date.parse(status.trialUntil) : NaN
  const now = serverTime()
  const ended = until <= now && now - until < ENDED_NOTICE_FOR_MS
  const eligible = userId !== null && ended && !premium && !isTvMode()
  const [open, close] = useFreeMoment(eligible, userId !== null && !seenBy(ENDED_KEY, userId), () => {
    if (!userId || seenBy(ENDED_KEY, userId)) return false
    markSeenBy(ENDED_KEY, userId)
    return true
  })
  useAdOverlay(open)
  useHoldNotices(open)
  if (!open) return null
  const dismiss = () => {
    holdAdsThisTap()
    close()
  }
  return (
    <div className="promo" role="dialog" aria-modal="true" aria-labelledby="trial-ended-title">
      <div className="promo__panel">
        <button type="button" className="promo__close" aria-label="Close" onClick={dismiss}>
          <X aria-hidden="true" />
        </button>
        <p id="trial-ended-title" className="promo__title">
          Your 2-day Premium has ended 🙏
        </p>
        <p className="promo__text">
          Stay ad-free by inviting {goalNow()} friends or from {naira(FROM_PRICE)}.
        </p>
        <div className="promo__actions">
          <button
            type="button"
            className="promo__primary"
            onClick={() => {
              dismiss()
              goToPage('invite')
            }}
          >
            Stay ad-free
          </button>
          <button type="button" className="promo__ghost" onClick={dismiss}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
