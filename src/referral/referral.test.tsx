import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccount, setAccountForTests } from '../account/account'
import { STORAGE_KEY } from '../account/client'
import { cardAd, lagosDay } from '../ads/adManager'
import { AdsBackNotice } from '../ads/AdsBackNotice'
import { adsDisabled } from '../ads/directLink'
import { loadMultitag } from '../ads/monetag'
import { adLinkClicks } from '../test/ads'
import { captureReferral, readRef, REF_TTL_MS } from './capture'
import { PROMO_DAY_KEY, progressText, promoTiming, shareMessage } from './copy'
import { ActivationNoticeHost, AdFreeCard, DailyPromoHost, GoAdFreeButton, InvitePage, InviteCard, RenewReminderHost } from './Invite'
import { adFreeReady, isAdFreeNow, refreshReferralStatus, resetReferralStatus } from './status'

const AD_FREE = { goal: 5, signedIn: true, userId: 'u1', adFree: true, permanent: false, adFreeUntil: new Date(Date.now() + 86_400_000).toISOString(), rewards: 1 }

/** A real click, as the site's buttons make. */
function tap(fn: (event: Event) => void) {
  const button = document.createElement('button')
  button.addEventListener('click', fn)
  document.body.append(button)
  button.click()
  button.remove()
}

afterEach(() => {
  resetAccount()
  document.querySelectorAll('script[data-zone], .player__frame').forEach((node) => node.remove())
  vi.unstubAllGlobals()
})

describe('no ads for ad-free accounts', () => {
  it('shows ads to normal visitors', () => {
    expect(isAdFreeNow()).toBe(false)
    expect(adsDisabled()).toBe(false)
    tap((event) => cardAd(event, { id: 'a' }))
    expect(adLinkClicks()).toHaveLength(1)
    expect(loadMultitag()).toBe(true)
  })

  it('shows no Multitag, no direct link and no "ads are back" card once the server says ad-free', () => {
    localStorage.removeItem('naijatr.ads.backNotice')
    resetReferralStatus(AD_FREE)
    expect(adsDisabled()).toBe(true)
    tap((event) => cardAd(event, { id: 'a' }))
    expect(adLinkClicks()).toHaveLength(0)
    expect(loadMultitag()).toBe(false)
    expect(document.querySelector('script[data-zone]')).toBeNull()
    vi.useFakeTimers()
    render(<AdsBackNotice />)
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('ads come back when the ad-free time is over', () => {
    resetReferralStatus({ ...AD_FREE, adFreeUntil: new Date(Date.now() - 1000).toISOString() })
    expect(isAdFreeNow()).toBe(false)
    expect(adsDisabled()).toBe(false)
  })

  it('trusts the last answer on this device only with a signed-in session, and only until it ends', () => {
    const cache = (until: number) =>
      localStorage.setItem('naijatr.adFree', JSON.stringify({ userId: 'u1', adFree: true, until: new Date(until).toISOString(), permanent: false, at: Date.now() }))
    cache(Date.now() + 86_400_000)
    // No session: a hand-written cache does nothing.
    expect(isAdFreeNow()).toBe(false)
    localStorage.setItem(STORAGE_KEY, '{}')
    expect(isAdFreeNow()).toBe(true)
    cache(Date.now() - 1000)
    expect(isAdFreeNow()).toBe(false)
  })

  it('makes a signed-in device wait for the server before loading the Multitag', async () => {
    // Signed out: no wait.
    await adFreeReady()
    localStorage.setItem(STORAGE_KEY, '{}')
    let answer!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))))
    let ready = false
    void adFreeReady(5000).then(() => (ready = true))
    await Promise.resolve()
    expect(ready).toBe(false)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    answer(new Response(JSON.stringify(AD_FREE)))
    await vi.waitFor(() => expect(ready).toBe(true))
    expect(isAdFreeNow()).toBe(true)
  })
})

describe('invite links', () => {
  it('keeps the code of /r/CODE for 7 days and moves to the home page', () => {
    const now = Date.now()
    captureReferral('/r/abc234', now)
    expect(readRef(now)).toEqual({ code: 'ABC234', at: now })
    expect(window.location.pathname + window.location.search).toBe('/?ref=ABC234')
    // The first link wins.
    captureReferral('/r/ZZZ999', now + 1000)
    expect(readRef(now + 1000)?.code).toBe('ABC234')
    expect(readRef(now + REF_TTL_MS + 1)).toBeNull()
  })

  it('shares the message with the link', () => {
    expect(shareMessage('https://www.naijatr.com/r/ABC234')).toBe(
      'Join me on NAIJA TR 🍿⚽ Movies, series & live football. Sign up with my link 👉 https://www.naijatr.com/r/ABC234',
    )
    expect(progressText(3, 5)).toBe('3/5 friends joined. 2 more to unlock ad-free!')
    expect(progressText(7, 5)).toBe('2/5 friends joined. 3 more to unlock ad-free!')
  })
})

describe('promotion', () => {
  const delay = { ...promoTiming }
  beforeEach(() => {
    localStorage.removeItem(PROMO_DAY_KEY)
    promoTiming.delayMs = 0
    promoTiming.pollMs = 20
    setAccountForTests({ status: 'signedOut' })
  })
  afterEach(() => Object.assign(promoTiming, delay))

  const popup = () => screen.queryByRole('dialog', { name: /Want NAIJA TR ad-free/ })

  it('shows the daily popup once per day per device', async () => {
    const { unmount } = render(<DailyPromoHost />)
    expect(await screen.findByRole('dialog', { name: /Want NAIJA TR ad-free/ })).toHaveTextContent(
      '🚫 Want NAIJA TR ad-free?Invite 5 friends and get the ad-free version! 🏆 Bonus: invite the most people this week and win a mystery prize 🎁',
    )
    expect(screen.getByRole('button', { name: 'Create a free account to start inviting' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(popup()).not.toBeInTheDocument()
    expect(localStorage.getItem(PROMO_DAY_KEY)).toBe(lagosDay(Date.now()))
    unmount()
    // Same day, a new page: not again.
    render(<DailyPromoHost />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(popup()).not.toBeInTheDocument()
  })

  it('shows again the next day', async () => {
    localStorage.setItem(PROMO_DAY_KEY, lagosDay(Date.now() - 86_400_000))
    render(<DailyPromoHost />)
    expect(await screen.findByRole('dialog', { name: /Want NAIJA TR ad-free/ })).toBeInTheDocument()
  })

  it('says "Invite friends" when signed in', async () => {
    setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'a@b.c', passwordSet: true } })
    resetReferralStatus({ goal: 5, signedIn: true, userId: 'u1', adFree: false, counted: 3 })
    render(<DailyPromoHost />)
    expect(await screen.findByRole('button', { name: 'Invite friends' })).toBeInTheDocument()
  })

  it('waits while a video is playing or another popup is open', async () => {
    const frame = document.createElement('div')
    frame.className = 'player__frame'
    document.body.append(frame)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    render(<DailyPromoHost />)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(popup()).not.toBeInTheDocument()
    frame.remove()
    document.body.append(dialog)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(popup()).not.toBeInTheDocument()
    expect(localStorage.getItem(PROMO_DAY_KEY)).toBeNull()
    dialog.remove()
    expect(await screen.findByRole('dialog', { name: /Want NAIJA TR ad-free/ })).toBeInTheDocument()
  })

  it('hides the popup, the header button and the home card for ad-free accounts', async () => {
    setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'a@b.c', passwordSet: true } })
    resetReferralStatus(AD_FREE)
    render(
      <>
        <DailyPromoHost />
        <GoAdFreeButton />
        <InviteCard />
      </>,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(popup()).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Go ad-free/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Invite friends' })).not.toBeInTheDocument()
  })

  it('shows the header button and the home card to everyone else', () => {
    render(
      <>
        <GoAdFreeButton />
        <InviteCard />
      </>,
    )
    expect(screen.getByRole('button', { name: /Go ad-free/ })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Invite friends' })).toHaveTextContent('Want NAIJA TR ad-free? Invite 5 friends!')
  })

  it('shows nothing where accounts aren’t set up', () => {
    setAccountForTests({ status: 'disabled' })
    render(<GoAdFreeButton />)
    expect(screen.queryByRole('button', { name: /Go ad-free/ })).not.toBeInTheDocument()
  })
})

describe('buying ad-free', () => {
  const user = { id: 'u1', email: 'ada@gmail.com', passwordSet: true }
  const notAdFree = { goal: 5, signedIn: true, userId: 'u1', adFree: false, counted: 2, link: 'https://www.naijatr.com/r/ABC234', code: 'ABC234' }
  const serve = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))

  it('offers "Buy ad-free" next to inviting, with the prices and a Telegram chat that says who it is', async () => {
    setAccountForTests({ status: 'signedIn', user })
    resetReferralStatus(notAdFree)
    serve(notAdFree)
    render(<InvitePage />)
    expect(screen.getByRole('button', { name: '🤝 Invite 5 friends (free)' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: '💳 Buy ad-free' }))
    expect(screen.getByText('🚫 Tired of ads? Get NAIJA TR AD-FREE! 🍿⚽')).toBeInTheDocument()
    expect(screen.getByText(/Watch movies, series, anime, K-drama & live football with no ads, no pop-ups, no interruptions 😎/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '✅ 1 Month: ₦2,000' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '✅ 3 Months: ₦5,000 🔥 (save ₦1,000)' })).toBeInTheDocument()
    expect(screen.getByText(/Your account email:/)).toHaveTextContent('Your account email: ada@gmail.com. Send this to us on Telegram so we can activate it.')
    const chat = () => screen.getByRole('link', { name: 'Chat on Telegram to buy' })
    expect(chat()).toHaveAttribute('href', `https://t.me/Dfw_Brun0?text=${encodeURIComponent('Hi, I want NAIJA TR ad-free (1 Month). My account email is ada@gmail.com')}`)
    expect(chat()).toHaveAttribute('target', '_blank')
    await userEvent.click(screen.getByRole('radio', { name: /3 Months/ }))
    expect(chat().getAttribute('href')).toContain(encodeURIComponent('(3 Months)'))
  })

  it('asks signed-out visitors to sign up first', async () => {
    setAccountForTests({ status: 'signedOut' })
    render(<InvitePage />)
    await userEvent.click(screen.getByRole('button', { name: '💳 Buy ad-free' }))
    expect(screen.getByText('Create a free account first, so we can activate ad-free on it.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign up' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Chat on Telegram to buy' })).not.toBeInTheDocument()
  })

  it('hides the buy option for ad-free accounts; the account page shows the date and Renew', () => {
    setAccountForTests({ status: 'signedIn', user })
    const until = new Date(Date.UTC(2026, 11, 2, 12)).toISOString()
    const paid = { ...notAdFree, adFree: true, adFreeUntil: until, permanent: false }
    resetReferralStatus(paid)
    serve(paid)
    render(
      <>
        <InvitePage />
        <AdFreeCard />
      </>,
    )
    expect(screen.queryByRole('button', { name: '💳 Buy ad-free' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Tired of ads/)).not.toBeInTheDocument()
    expect(screen.getByText(/Ad-free until 2 December 2026/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Renew' }).getAttribute('href')).toContain('https://t.me/Dfw_Brun0')
    expect(screen.queryByRole('button', { name: /Buy ad-free from/ })).not.toBeInTheDocument()
  })

  it('offers both ways on the account page when not ad-free', () => {
    setAccountForTests({ status: 'signedIn', user })
    resetReferralStatus(notAdFree)
    serve(notAdFree)
    render(<AdFreeCard />)
    expect(screen.getByRole('button', { name: /Invite 5 friends \(free\)/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '💳 Buy ad-free from ₦2,000' })).toBeInTheDocument()
  })

  it('after a paid grant: no ads, and "active until" once per grant', async () => {
    const until = new Date(Date.UTC(2026, 11, 2, 12)).toISOString()
    const granted = { ...notAdFree, adFree: true, adFreeUntil: until, lastGrant: { id: 7, at: new Date().toISOString() } }
    localStorage.setItem(STORAGE_KEY, '{}')
    serve(granted)
    render(<ActivationNoticeHost />)
    await act(() => refreshReferralStatus())
    expect(adsDisabled()).toBe(true)
    expect(screen.getByRole('dialog')).toHaveTextContent('🎉 NAIJA TR ad-free is active until 2 December 2026.Thank you! ❤️')
    await userEvent.click(screen.getByRole('button', { name: 'Enjoy 🍿' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The same grant on the next visit: not again. A new one (a renewal): again.
    const nextVisit = () => act(() => (resetReferralStatus(), refreshReferralStatus()))
    await nextVisit()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    serve({ ...granted, lastGrant: { id: 8, at: new Date().toISOString() } })
    await nextVisit()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('reminds to renew in the last 3 days only', () => {
    setAccountForTests({ status: 'signedIn', user })
    const ending = (days: number, extra = {}) => ({ ...notAdFree, adFree: true, adFreeUntil: new Date(Date.now() + days * 86_400_000).toISOString(), ...extra })
    resetReferralStatus(ending(5))
    const { unmount } = render(<RenewReminderHost />)
    expect(screen.queryByText(/Your ad-free ends on/)).not.toBeInTheDocument()
    unmount()
    resetReferralStatus(ending(2, { permanent: true }))
    const second = render(<RenewReminderHost />)
    expect(screen.queryByText(/Your ad-free ends on/)).not.toBeInTheDocument()
    second.unmount()
    resetReferralStatus(ending(2))
    render(<RenewReminderHost />)
    expect(screen.getByText(/Your ad-free ends on .*\. Renew to keep watching without ads\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Renew' }).getAttribute('href')).toContain('https://t.me/Dfw_Brun0')
  })
})
