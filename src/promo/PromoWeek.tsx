import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { openSignIn, useAccount, useSignInSheet } from '../account/account'
import { goToPage } from '../account/pages'
import { holdAdsThisTap, isPlaybackOpen, useAdOverlay, useOverlayOpen } from '../ads/adManager'
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
 * - Signed out: a banner along the top on every visit, easy to close
 *   (PromoWeekBanner). No popup.
 * - Signed in and ad-free through the week only: "✅ You're watching ad-free
 *   this week!" once per account per device.
 * - After it, signed in without ad-free of their own: "The free ad-free week
 *   has ended 🙏" once per account per device (for two weeks).
 *
 * Popups wait for a free moment: never over another popup or sheet, never
 * while a player is open.
 */

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

/** Signed-in accounts: their "starts in…" line shows this long before the start. */
const SOON_MS = 2 * 24 * 60 * 60 * 1000

/**
 * A slim banner along the top (it blocks nothing).
 *
 * - Signed out: "Too many ads? 😅 Sign in now and get NAIJA TR ad-free", on
 *   every visit (each page load) while the offer stands (from before the start
 *   to its end), with Sign in and an easy ✕ that hides it for this visit.
 * - Signed in without ad-free of their own, before the start: when it starts.
 */
export function PromoWeekBanner() {
  const { status: account } = useAccount()
  const state = usePromoState()
  const promo = usePromo()
  const status = useReferralStatus()
  const [closed, setClosed] = useState(false)
  const signedOut = account === 'signedOut'
  // Ad-free of their own already: nothing changes for them.
  const ownAdFree = status?.signedIn === true && (status.ownAdFree ?? status.adFree)
  const soon = state === 'upcoming' && promo !== null && Date.parse(promo.start) - serverTime() <= SOON_MS
  const mode =
    closed || isTvMode() || onPromoPages() || !promo
      ? null
      : signedOut && (state === 'active' || state === 'upcoming')
        ? 'sign-in'
        : soon && account === 'signedIn' && !ownAdFree
          ? 'starts'
          : null
  const left = useTimeLeft(mode === 'starts' ? promo!.start : null)
  // The navbar moves down under it (PromoWeek.css).
  useEffect(() => {
    if (!mode) return
    document.documentElement.classList.add('has-promo-banner')
    return () => document.documentElement.classList.remove('has-promo-banner')
  }, [mode])
  if (!mode) return null
  if (mode === 'starts') {
    return (
      <p className="promo-week-banner" role="status">
        🎉 Ad-free NAIJA TR starts in {countdownText(left, false)}: no ads for you until {promoEndText(promo!.end)}
      </p>
    )
  }
  return (
    <div className="promo-week-banner promo-week-banner--sign-in" role="region" aria-label="Go ad-free">
      <p className="promo-week-banner__text">
        Too many ads? 😅 Sign in now and get NAIJA TR ad-free{state === 'upcoming' ? ' from midnight' : ''}
      </p>
      <button
        type="button"
        className="promo-week-banner__action"
        onClick={() => {
          holdAdsThisTap()
          openSignIn()
        }}
      >
        Sign in
      </button>
      <button
        type="button"
        className="promo-week-banner__close"
        aria-label="Close"
        onClick={() => {
          holdAdsThisTap()
          setClosed(true)
        }}
      >
        <X aria-hidden="true" />
      </button>
    </div>
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
