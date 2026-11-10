import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { openSignIn, useAccount, useSignInSheet } from '../account/account'
import { goToPage } from '../account/pages'
import { holdAdsThisTap, isPlaybackOpen, lagosDay, useAdOverlay, useOverlayOpen } from '../ads/adManager'
import { FROM_PRICE, naira } from '../config/adFree'
import { isTvMode } from '../tv/tvMode'
import { useHoldNotices, useNoticesHeld } from '../ui/noticeQueue'
import { goalNow, serverTime, useActivationDue, useAdFree, usePromo, usePromoState, useReferralStatus, useUnlockDue } from '../referral/status'
import '../referral/referral.css'
import { countdownText, promoEndText, promoWeekTiming } from './promoText'
import './PromoWeek.css'

/**
 * The Free Ad-Free Week's messages (the rule itself is on the server:
 * server/promo.ts). Times come from the server, and countdowns run on its
 * clock (serverTime), never the device's.
 *
 * - Signed out, during the week: a popup once a day per device ("Register
 *   free" / "Not now") and a slim banner along the top, both counting down.
 * - Signed in and ad-free through the week only: "✅ You're watching ad-free
 *   this week!" once per account per device.
 * - After it, signed in without ad-free of their own: "The free ad-free week
 *   has ended 🙏" once per account per device (for two weeks).
 *
 * Popups wait for a free moment: never over another popup or sheet, never
 * while a player is open.
 */

const POPUP_DAY_KEY = 'naijatr.promoWeek.day'
const WELCOME_KEY = 'naijatr.promoWeek.welcome'
const ENDED_KEY = 'naijatr.promoWeek.ended'
/** The ended message only shows this long after the week. */
const ENDED_NOTICE_FOR_MS = 14 * 24 * 60 * 60 * 1000

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // This visit only.
  }
}

/** Seen by this account (or device) already: a list of ids under one key. */
const seenBy = (key: string, id: string) => (read(key) ?? '').split(',').includes(id)
const markSeenBy = (key: string, id: string) => write(key, [...new Set([...(read(key) ?? '').split(',').filter(Boolean), id])].join(','))

/** Time left until `iso` on the server's clock, ticking every second while shown. */
function useTimeLeft(iso: string | null): number {
  const [now, setNow] = useState(() => serverTime())
  useEffect(() => {
    if (!iso) return
    const timer = window.setInterval(() => setNow(serverTime()), 1000)
    return () => window.clearInterval(timer)
  }, [iso])
  return iso ? Date.parse(iso) - now : 0
}

/** Another popup, sheet or a player is on screen: the popup waits. */
const somethingOpen = () => isPlaybackOpen() || document.querySelector('[role="dialog"], [aria-modal="true"]') !== null

/**
 * Opens once `eligible` and `unseen` have held for the delay and the screen
 * is free; `show` marks it seen at that moment (false: seen meanwhile, on
 * another tab). Open, it stays until closed or no longer `eligible` (the
 * promo ended, or they signed in): being seen now doesn't close it.
 */
function useFreeMoment(eligible: boolean, unseen: boolean, show: () => boolean) {
  const due = eligible && unseen
  const overlayOpen = useOverlayOpen()
  const noticesHeld = useNoticesHeld()
  const sheet = useSignInSheet()
  const unlock = useUnlockDue()
  const activation = useActivationDue()
  const [waited, setWaited] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!due) return
    const timer = window.setTimeout(() => setWaited(true), promoWeekTiming.delayMs)
    return () => window.clearTimeout(timer)
  }, [due])
  const blocked = overlayOpen || noticesHeld || sheet !== null || unlock || activation
  useEffect(() => {
    if (!due || !waited || blocked || open) return
    const tryShow = () => {
      if (somethingOpen() || !show()) return false
      setOpen(true)
      return true
    }
    if (tryShow()) return
    const timer = window.setInterval(() => {
      if (tryShow()) window.clearInterval(timer)
    }, promoWeekTiming.pollMs)
    return () => window.clearInterval(timer)
    // `show` is read when it's time; a new one each render doesn't restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due, waited, blocked, open])
  return [open && eligible, () => setOpen(false)] as const
}

const onPromoPages = () => /^\/(auth|admin)(\/|$)/.test(window.location.pathname)

/** Signed out during the week: once a day per device. */
export function PromoWeekPopupHost() {
  const { status: account } = useAccount()
  const state = usePromoState()
  const promo = usePromo()
  const eligible = state === 'active' && account === 'signedOut' && !isTvMode() && !onPromoPages()
  const [open, close] = useFreeMoment(eligible, read(POPUP_DAY_KEY) !== lagosDay(serverTime()), () => {
    if (read(POPUP_DAY_KEY) === lagosDay(serverTime())) return false
    write(POPUP_DAY_KEY, lagosDay(serverTime()))
    return true
  })
  const left = useTimeLeft(open && promo ? promo.end : null)
  useAdOverlay(open)
  useHoldNotices(open)
  if (!open || !promo) return null
  const dismiss = () => {
    holdAdsThisTap()
    close()
  }
  return (
    <div className="promo promo-week" role="dialog" aria-modal="true" aria-labelledby="promo-week-title">
      <div className="promo__panel">
        <button type="button" className="promo__close" aria-label="Close" onClick={dismiss}>
          <X aria-hidden="true" />
        </button>
        <p id="promo-week-title" className="promo__title">
          🎉 FREE AD-FREE WEEK!
        </p>
        <p className="promo__text">
          Register now and watch NAIJA TR with NO ADS until {promoEndText(promo.end)}. ⏳ This offer is for one week only.
        </p>
        <p className="promo-week__countdown" aria-label="Time left">
          {countdownText(left)}
        </p>
        <div className="promo__actions">
          <button
            type="button"
            className="promo__primary"
            onClick={() => {
              dismiss()
              openSignIn('create')
            }}
          >
            Register free
          </button>
          <button type="button" className="promo__ghost" onClick={dismiss}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}

/** Signed out during the week: a slim banner along the top (not a popup: it blocks nothing). */
export function PromoWeekBanner() {
  const { status: account } = useAccount()
  const state = usePromoState()
  const promo = usePromo()
  const shown = state === 'active' && account === 'signedOut' && !isTvMode() && !onPromoPages() && promo !== null
  const left = useTimeLeft(shown ? promo.end : null)
  // The navbar moves down under it (PromoWeek.css).
  useEffect(() => {
    if (!shown) return
    document.documentElement.classList.add('has-promo-banner')
    return () => document.documentElement.classList.remove('has-promo-banner')
  }, [shown])
  if (!shown) return null
  return (
    <button
      type="button"
      className="promo-week-banner"
      onClick={() => {
        holdAdsThisTap()
        openSignIn('create')
      }}
    >
      🎉 Ad-free week: register free and watch with no ads, ends in {countdownText(left, false)}
    </button>
  )
}

/** Signed in, ad-free through the week: told once per account on this device. */
export function PromoWeekWelcomeHost() {
  const status = useReferralStatus()
  const state = usePromoState()
  const userId = status?.signedIn ? (status.userId ?? null) : null
  const eligible = state === 'active' && userId !== null && status?.promoAdFree === true && !isTvMode()
  const [open, close] = useFreeMoment(eligible, userId !== null && !seenBy(WELCOME_KEY, userId), () => {
    if (!userId || seenBy(WELCOME_KEY, userId)) return false
    markSeenBy(WELCOME_KEY, userId)
    return true
  })
  useAdOverlay(open)
  useHoldNotices(open)
  if (!open || !status?.promo) return null
  return (
    <div className="promo" role="dialog" aria-modal="true" aria-labelledby="promo-week-welcome">
      <div className="promo__panel">
        <p id="promo-week-welcome" className="promo__title">
          ✅ You're watching ad-free this week!
        </p>
        <p className="promo__text">Ends {promoEndText(status.promo.end)}.</p>
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

/** After the week, signed in without ad-free of their own: told once per account on this device. */
export function PromoWeekEndedHost() {
  const status = useReferralStatus()
  const state = usePromoState()
  const userId = status?.signedIn ? (status.userId ?? null) : null
  const adFree = useAdFree()
  const recent = status?.promo ? serverTime() - Date.parse(status.promo.end) < ENDED_NOTICE_FOR_MS : false
  const eligible = state === 'ended' && recent && userId !== null && !adFree && !isTvMode()
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
    <div className="promo" role="dialog" aria-modal="true" aria-labelledby="promo-week-ended">
      <div className="promo__panel">
        <button type="button" className="promo__close" aria-label="Close" onClick={dismiss}>
          <X aria-hidden="true" />
        </button>
        <p id="promo-week-ended" className="promo__title">
          The free ad-free week has ended 🙏
        </p>
        <p className="promo__text">
          Keep NAIJA TR ad-free by inviting {goalNow()} friends or from {naira(FROM_PRICE)}.
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
            Go ad-free
          </button>
          <button type="button" className="promo__ghost" onClick={dismiss}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
