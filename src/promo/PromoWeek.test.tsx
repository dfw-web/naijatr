import { useEffect } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccount, setAccountForTests, useSignInSheet } from '../account/account'
import { cardAd } from '../ads/adManager'
import { AdsBackNotice } from '../ads/AdsBackNotice'
import { adsDisabled } from '../ads/directLink'
import { loadMultitag } from '../ads/monetag'
import { adLinkClicks } from '../test/ads'
import { PROMO_DAY_KEY, promoTiming } from '../referral/copy'
import { AdFreeCard, DailyPromoHost, RenewReminderHost } from '../referral/Invite'
import { isAdFreeNow, isServerAdFree, promoStateNow, resetReferralStatus, type ReferralStatus } from '../referral/status'
import { PromoWeekBanner, PromoWeekEndedHost, PromoWeekPopupHost, PromoWeekWelcomeHost } from './PromoWeek'
import { countdownText, promoEndText, promoWeekTiming } from './promoText'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

/** The promo as the server describes it: started `sinceMs` ago, ending in `leftMs`. */
const promoFor = (sinceMs: number, leftMs: number, now = Date.now()) => ({
  start: iso(now - sinceMs),
  end: iso(now + leftMs),
  state: (sinceMs < 0 ? 'upcoming' : leftMs < 0 ? 'ended' : 'active') as 'upcoming' | 'active' | 'ended',
})
const ACTIVE = () => promoFor(DAY, 6 * DAY)

const signedOut = (promo = ACTIVE()): ReferralStatus => ({ goal: 5, signedIn: false, adFree: false, promo, serverNow: Date.now() })
/** Signed in, no ad-free of their own: ad-free through the week only (the server's answer during it). */
const promoUser = (promo = ACTIVE()): ReferralStatus => ({
  goal: 5,
  signedIn: true,
  userId: 'u1',
  adFree: true,
  adFreeUntil: promo.end,
  permanent: false,
  ownAdFree: false,
  promoAdFree: true,
  promo,
  serverNow: Date.now(),
})

/** A real click, as the site's buttons make. */
function tap(fn: (event: Event) => void) {
  const button = document.createElement('button')
  button.addEventListener('click', fn)
  document.body.append(button)
  button.click()
  button.remove()
}

const timing = { ...promoWeekTiming }
const dailyTiming = { ...promoTiming }
beforeEach(() => {
  promoWeekTiming.delayMs = 0
  promoWeekTiming.pollMs = 20
  // The server is never asked in these tests (a promo timer may try).
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in tests'))))
})
afterEach(() => {
  Object.assign(promoWeekTiming, timing)
  Object.assign(promoTiming, dailyTiming)
  resetAccount()
  resetReferralStatus(null)
  document.querySelectorAll('script[data-zone], .player__frame').forEach((node) => node.remove())
  document.documentElement.classList.remove('has-promo-banner')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the wording', () => {
  it('says when it ends in Lagos time, and counts down', () => {
    expect(promoEndText('2026-11-17T23:59:59+01:00')).toBe('Tuesday, 17 Nov at 11:59 PM')
    expect(countdownText(6 * DAY + 23 * HOUR + 59 * 60_000 + 12_000)).toBe('6d 23h 59m 12s')
    expect(countdownText(5 * 60_000 + 3000, false)).toBe('5m')
    expect(countdownText(-5000)).toBe('0m 0s')
  })
})

describe('signed out during the week', () => {
  beforeEach(() => setAccountForTests({ status: 'signedOut' }))

  it('shows the popup once a day per device, with a live countdown and "Register free"', async () => {
    resetReferralStatus(signedOut(promoFor(DAY, 2 * DAY)))
    let sheet: ReturnType<typeof useSignInSheet> = null
    function Sheet() {
      const open = useSignInSheet()
      useEffect(() => {
        sheet = open
      }, [open])
      return null
    }
    const { unmount } = render(
      <>
        <PromoWeekPopupHost />
        <Sheet />
      </>,
    )
    const popup = await screen.findByRole('dialog', { name: '🎉 FREE AD-FREE WEEK!' })
    expect(popup).toHaveTextContent(
      `Register now and watch NAIJA TR with NO ADS until ${promoEndText(signedOut(promoFor(DAY, 2 * DAY)).promo!.end)}. ⏳ This offer is for one week only.`,
    )
    const countdown = screen.getByLabelText('Time left')
    expect(countdown.textContent).toMatch(/^(2d 0h 0m 0s|1d 23h 59m 5\ds)$/)
    const before = countdown.textContent
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)))
    expect(screen.getByLabelText('Time left').textContent).not.toBe(before)
    await userEvent.click(screen.getByRole('button', { name: 'Register free' }))
    expect(screen.queryByRole('dialog', { name: /FREE AD-FREE WEEK/ })).not.toBeInTheDocument()
    expect(sheet).toBe('create')
    unmount()
    // Same day, a new page: not again.
    render(<PromoWeekPopupHost />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog', { name: /FREE AD-FREE WEEK/ })).not.toBeInTheDocument()
  })

  it('"Not now" closes it; it never shows over another popup or while a video plays', async () => {
    resetReferralStatus(signedOut())
    const frame = document.createElement('div')
    frame.className = 'player__frame'
    document.body.append(frame)
    render(<PromoWeekPopupHost />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    frame.remove()
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the banner along the top, counting down; it opens sign-up', async () => {
    resetReferralStatus(signedOut(promoFor(DAY, 3 * HOUR + 30 * 60_000)))
    render(<PromoWeekBanner />)
    const banner = screen.getByRole('button', { name: /Ad-free week/ })
    expect(banner.textContent).toMatch(/^🎉 Ad-free week: register free and watch with no ads, ends in 3h (30|29)m$/)
    expect(document.documentElement).toHaveClass('has-promo-banner')
  })

  it('pauses the daily invite popup and the "Ads are back" card, and keeps ads for signed-out visitors', async () => {
    resetReferralStatus(signedOut())
    localStorage.removeItem(PROMO_DAY_KEY)
    localStorage.removeItem('naijatr.ads.backNotice')
    promoTiming.delayMs = 0
    promoTiming.pollMs = 20
    render(
      <>
        <DailyPromoHost />
        <AdsBackNotice />
      </>,
    )
    await new Promise((resolve) => setTimeout(resolve, 1800))
    expect(screen.queryByRole('dialog', { name: /Want NAIJA TR ad-free/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Ads are back/)).not.toBeInTheDocument()
    // Paused, not used up: it can still show after the week.
    expect(localStorage.getItem('naijatr.ads.backNotice')).toBeNull()
    expect(isAdFreeNow()).toBe(false)
    expect(isServerAdFree()).toBe(false)
    expect(adsDisabled()).toBe(false)
  })

  it('before the week: a "starts in" banner (last 2 days only), no popup; nothing after it', async () => {
    resetReferralStatus(signedOut(promoFor(-(HOUR + 45 * 60_000), 7 * DAY)))
    const { unmount } = render(
      <>
        <PromoWeekPopupHost />
        <PromoWeekBanner />
      </>,
    )
    expect(screen.getByRole('button', { name: /starts in/ }).textContent).toMatch(
      /^🎉 Free ad-free week starts in 1h (45|44)m: register free and watch with no ads all week$/,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()
    resetReferralStatus(signedOut(promoFor(-3 * DAY, 7 * DAY)))
    const later = render(<PromoWeekBanner />)
    expect(screen.queryByRole('button', { name: /Ad-free week|starts in/ })).not.toBeInTheDocument()
    later.unmount()
    resetReferralStatus(signedOut(promoFor(8 * DAY, -DAY)))
    render(<PromoWeekBanner />)
    expect(screen.queryByRole('button', { name: /Ad-free week/ })).not.toBeInTheDocument()
  })
})

describe('signed in during the week', () => {
  beforeEach(() => setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'a@b.c', passwordSet: true } }))

  it('no ads at all: no Multitag, no direct link', () => {
    resetReferralStatus(promoUser())
    expect(isAdFreeNow()).toBe(true)
    expect(isServerAdFree()).toBe(true)
    expect(adsDisabled()).toBe(true)
    tap((event) => cardAd(event, { id: 'a' }))
    expect(adLinkClicks()).toHaveLength(0)
    expect(loadMultitag()).toBe(false)
  })

  it('says once per account "You’re watching ad-free this week!", and no popup or banner', async () => {
    resetReferralStatus(promoUser())
    const { unmount } = render(
      <>
        <PromoWeekWelcomeHost />
        <PromoWeekPopupHost />
        <PromoWeekBanner />
      </>,
    )
    const notice = await screen.findByRole('dialog', { name: "✅ You're watching ad-free this week!" })
    expect(notice).toHaveTextContent(`Ends ${promoEndText(promoUser().promo!.end)}.`)
    expect(screen.queryByRole('dialog', { name: /FREE AD-FREE WEEK/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ad-free week/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Enjoy 🍿' }))
    unmount()
    render(<PromoWeekWelcomeHost />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('before the week: "starts in" for accounts without ad-free of their own, nothing for paid ones', () => {
    const upcoming = promoFor(-HOUR, 7 * DAY)
    resetReferralStatus({ goal: 5, signedIn: true, userId: 'u1', adFree: false, ownAdFree: false, promoAdFree: false, promo: upcoming, serverNow: Date.now() })
    const { unmount } = render(<PromoWeekBanner />)
    const text = screen.getByRole('status').textContent
    expect(text).toMatch(/^🎉 Free ad-free week starts in (1h 0m|59m): no ads for you all week, until /)
    expect(text!.endsWith(promoEndText(upcoming.end))).toBe(true)
    unmount()
    resetReferralStatus({ goal: 5, signedIn: true, userId: 'u1', adFree: true, adFreeUntil: iso(Date.now() + 30 * DAY), ownAdFree: true, promo: upcoming, serverNow: Date.now() })
    render(<PromoWeekBanner />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('no "Renew" reminder in its last days; the account page offers both ways to keep it', () => {
    resetReferralStatus(promoUser(promoFor(6 * DAY, DAY)))
    render(
      <>
        <RenewReminderHost />
        <AdFreeCard />
      </>,
    )
    expect(screen.queryByText(/Renew/)).not.toBeInTheDocument()
    expect(screen.getByText(/Free ad-free week: ends/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Buy ad-free from ₦2,000/ })).toBeInTheDocument()
  })

  it('goes by the server’s clock, not the device’s', () => {
    // This device's clock is two days behind: by it, the week hasn't started.
    const serverNow = Date.now() + 2 * DAY
    const promo = { start: iso(serverNow - HOUR), end: iso(serverNow + 5 * DAY), state: 'active' as const }
    resetReferralStatus({ ...promoUser(promo), serverNow })
    expect(promoStateNow()).toBe('active')
    expect(isAdFreeNow()).toBe(true)
    expect(isServerAdFree()).toBe(true)
  })
})

describe('when the week ends', () => {
  beforeEach(() => setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'a@b.c', passwordSet: true } }))

  it('ads come back at once for accounts without ad-free of their own', async () => {
    resetReferralStatus(promoUser(promoFor(7 * DAY, 300)))
    expect(isAdFreeNow()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(promoStateNow()).toBe('ended')
    expect(isAdFreeNow()).toBe(false)
    expect(isServerAdFree()).toBe(false)
    expect(adsDisabled()).toBe(false)
  })

  it('paid and allowlisted accounts stay ad-free', async () => {
    const promo = promoFor(7 * DAY, 300)
    resetReferralStatus({ ...promoUser(promo), adFreeUntil: iso(Date.now() + 30 * DAY), ownAdFree: true, promoAdFree: false })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(isServerAdFree()).toBe(true)
    resetReferralStatus({ ...promoUser(promo), adFreeUntil: null, permanent: true, ownAdFree: true, promoAdFree: false })
    expect(isServerAdFree()).toBe(true)
  })

  it('says once "The free ad-free week has ended 🙏" to those without ad-free of their own', async () => {
    const ended = promoFor(8 * DAY, -DAY)
    resetReferralStatus({ goal: 5, signedIn: true, userId: 'u1', adFree: false, ownAdFree: false, promoAdFree: false, promo: ended, serverNow: Date.now() })
    const { unmount } = render(<PromoWeekEndedHost />)
    const notice = await screen.findByRole('dialog', { name: 'The free ad-free week has ended 🙏' })
    expect(notice).toHaveTextContent('Keep NAIJA TR ad-free by inviting 5 friends or from ₦2,000.')
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    unmount()
    render(<PromoWeekEndedHost />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says nothing to paid accounts, or to signed-out visitors', async () => {
    const ended = promoFor(8 * DAY, -DAY)
    resetReferralStatus({ goal: 5, signedIn: true, userId: 'u1', adFree: true, adFreeUntil: iso(Date.now() + 9 * DAY), ownAdFree: true, promo: ended, serverNow: Date.now() })
    const { unmount } = render(<PromoWeekEndedHost />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()
    setAccountForTests({ status: 'signedOut' })
    resetReferralStatus(signedOut(ended))
    render(<PromoWeekEndedHost />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
