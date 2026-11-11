import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AccountMenu } from '../account/AccountMenu'
import { resetClient, STORAGE_KEY } from '../account/client'
import { PremiumAvatar } from '../account/PremiumAvatar'
import { resetAccount, setAccountForTests, signupSource, useSignInSheet } from '../account/account'
import { isAdFreeNow, isPremiumNow, isServerAdFree, refreshReferralStatus, resetReferralStatus, type ReferralStatus } from '../referral/status'
import { promoWeekTiming } from './promoText'
import { playAfterTrialPrompt, resetTrialPrompt, trialPromptShownToday } from './trialPrompt'
import { TrialEndedHost, TrialPromptHost, TrialWelcomeHost } from './WelcomeTrial'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

const base = (over: Partial<ReferralStatus> = {}): ReferralStatus => ({
  goal: 5,
  signedIn: true,
  userId: 'u1',
  adFree: false,
  adFreeUntil: null,
  permanent: false,
  ownAdFree: false,
  promoAdFree: false,
  premium: false,
  trialUntil: null,
  trialOnly: false,
  promo: null,
  trial: { start: iso(Date.now() - DAY), live: true },
  serverNow: Date.now(),
  ...over,
})
const paid = (untilMs = Date.now() + 30 * DAY) => base({ adFree: true, ownAdFree: true, premium: true, adFreeUntil: iso(untilMs) })
const trialUser = (untilMs = Date.now() + 47 * HOUR) =>
  base({ adFree: true, ownAdFree: true, premium: true, trialOnly: true, adFreeUntil: iso(untilMs), trialUntil: iso(untilMs) })
const promoOnly = () =>
  base({
    adFree: true,
    ownAdFree: false,
    promoAdFree: true,
    premium: false,
    adFreeUntil: iso(Date.now() + 3 * DAY),
    promo: { start: iso(Date.now() - DAY), end: iso(Date.now() + 3 * DAY), state: 'active' },
    trial: { start: iso(Date.now() + 3 * DAY), live: false },
  })
const signedOutStatus = (live = true): ReferralStatus => ({
  goal: 5,
  signedIn: false,
  adFree: false,
  premium: false,
  promo: null,
  trial: { start: iso(Date.now() + (live ? -HOUR : HOUR)), live },
  serverNow: Date.now(),
})

const signIn = () => setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'ada@gmail.com', passwordSet: true } })
const crown = () => document.querySelector('.premium-crown')

/** A real click, as the site's buttons make. */
function tap(fn: (event: Event) => void) {
  const button = document.createElement('button')
  button.addEventListener('click', fn)
  document.body.append(button)
  button.click()
  button.remove()
}

const timing = { ...promoWeekTiming }
beforeEach(() => {
  promoWeekTiming.delayMs = 0
  promoWeekTiming.pollMs = 20
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in tests'))))
  localStorage.clear()
})
afterEach(() => {
  Object.assign(promoWeekTiming, timing)
  resetAccount()
  resetReferralStatus(null)
  resetTrialPrompt()
  resetClient(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('👑 the crown', () => {
  it('shows for Premium accounts now (paid, referral, allowlist, trial), with "👑 Premium" in the menu', async () => {
    signIn()
    resetReferralStatus(paid())
    render(<AccountMenu />)
    const button = screen.getByRole('button', { name: /Account: ada@gmail.com \(Premium\)/ })
    expect(button.querySelector('.premium-crown')).not.toBeNull()
    expect(button.querySelector('.premium-avatar--premium')).not.toBeNull()
    expect(button).toHaveTextContent('A')
    await userEvent.click(button)
    expect(screen.getByText('👑 Premium')).toBeInTheDocument()
    act(() => resetReferralStatus(base({ adFree: true, ownAdFree: true, premium: true, permanent: true })))
    expect(document.querySelectorAll('.premium-crown').length).toBe(2)
    act(() => resetReferralStatus(trialUser()))
    expect(document.querySelectorAll('.premium-crown').length).toBe(2)
  })

  it('never for normal accounts, or accounts ad-free through the promo week only', async () => {
    signIn()
    resetReferralStatus(base())
    render(<AccountMenu />)
    expect(crown()).toBeNull()
    act(() => resetReferralStatus(promoOnly()))
    expect(isAdFreeNow()).toBe(true)
    expect(isPremiumNow()).toBe(false)
    expect(crown()).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Account: ada@gmail.com' }))
    expect(screen.queryByText('👑 Premium')).toBeNull()
  })

  it('never from this device’s cached copy alone, before the server has answered', () => {
    localStorage.setItem('naijatr.adFree', JSON.stringify({ userId: 'u1', adFree: true, until: iso(Date.now() + DAY), permanent: false, at: Date.now() }))
    localStorage.setItem(STORAGE_KEY, '{}')
    resetReferralStatus(null)
    render(<PremiumAvatar email="ada@gmail.com" />)
    expect(isPremiumNow()).toBe(false)
    expect(crown()).toBeNull()
  })

  it('draws a 5-point SVG crown with 5 jewels, 3 gems (red, green, white), gold, and one shine', () => {
    render(<PremiumAvatar email="ada@gmail.com" premium />)
    const svg = crown()!
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg.textContent).toBe('')
    const fills = [...svg.querySelectorAll('circle')].map((c) => c.getAttribute('fill'))
    expect(fills.filter((f) => f?.startsWith('url(#crown-jewel')).length).toBe(5)
    expect(fills).toEqual(expect.arrayContaining(['#E0242F', '#008751', '#FFFFFF']))
    const stops = [...svg.querySelectorAll('linearGradient')][0].querySelectorAll('stop')
    expect([...stops].map((s) => s.getAttribute('stop-color'))).toEqual(['#FFE680', '#F5C518', '#C9971A'])
    expect(svg.querySelectorAll('.premium-crown__shine').length).toBe(1)
  })

  it('appears and disappears live, with no reload: when the server says so, and the moment it ends', async () => {
    signIn()
    resetReferralStatus(base())
    render(<AccountMenu />)
    expect(crown()).toBeNull()
    // Given Premium meanwhile: the next status check brings the crown.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const soon = Date.now() + 5000
    localStorage.setItem(STORAGE_KEY, '{}')
    resetClient(Promise.resolve({ auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } } as unknown as SupabaseClient))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(paid(soon)), { status: 200 })))
    await act(async () => {
      await refreshReferralStatus()
    })
    expect(crown()).not.toBeNull()
    // It runs out: gone by itself (the status timer), and ads and Server 1 are back.
    await act(async () => {
      vi.advanceTimersByTime(7000)
    })
    expect(crown()).toBeNull()
    expect(isPremiumNow()).toBe(false)
    expect(isServerAdFree()).toBe(false)
    expect(isAdFreeNow()).toBe(false)
  })
})

describe('the welcome trial on this device', () => {
  it('ends on time: ads back, Server 1, no crown, and "Your 2-day Premium has ended" once', async () => {
    signIn()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const end = Date.now() + 10_000
    resetReferralStatus(trialUser(end))
    render(
      <>
        <AccountMenu />
        <TrialEndedHost />
      </>,
    )
    expect(isServerAdFree()).toBe(true)
    expect(isAdFreeNow()).toBe(true)
    expect(crown()).not.toBeNull()
    expect(screen.queryByText(/Your 2-day Premium has ended/)).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(12_000)
    })
    expect(isServerAdFree()).toBe(false)
    expect(isAdFreeNow()).toBe(false)
    expect(crown()).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByText('Your 2-day Premium has ended 🙏')).toBeInTheDocument()
    expect(screen.getByText(/Stay ad-free by inviting 5 friends or from ₦2,000/)).toBeInTheDocument()
    expect(localStorage.getItem('naijatr.trial.ended')).toContain('u1')
  })

  it('says "🎉 Welcome! You\'re 👑 Premium (ad-free) for 2 days." once, with no timer', async () => {
    signIn()
    resetReferralStatus(trialUser())
    const { unmount } = render(<TrialWelcomeHost />)
    const title = await screen.findByText("🎉 Welcome! You're 👑 Premium (ad-free) for 2 days.")
    expect(title.closest('[role="dialog"]')?.textContent).not.toMatch(/\d+h|\d+m|left|until/i)
    await userEvent.click(screen.getByRole('button', { name: 'Enjoy 🍿' }))
    unmount()
    render(<TrialWelcomeHost />)
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByText(/Welcome! You're/)).toBeNull()
  })

  it('no ended message for paid accounts that also had the trial', async () => {
    signIn()
    resetReferralStatus(base({ ...paid(), trialUntil: iso(Date.now() - HOUR) }))
    render(<TrialEndedHost />)
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByText(/2-day Premium has ended/)).toBeNull()
  })
})

describe('the Play popup (signed out)', () => {
  function Sheet() {
    return <p data-testid="sheet">{useSignInSheet() ?? 'closed'}</p>
  }

  it('does nothing before PROMO_END: Play just plays', () => {
    setAccountForTests({ status: 'signedOut', user: null })
    resetReferralStatus(signedOutStatus(false))
    render(<TrialPromptHost />)
    const play = vi.fn()
    tap(() => playAfterTrialPrompt(play))
    expect(play).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows at most once a day per device; "Continue with ads" plays; the next day it may show again', async () => {
    setAccountForTests({ status: 'signedOut', user: null })
    resetReferralStatus(signedOutStatus())
    render(<TrialPromptHost />)
    const play = vi.fn()
    act(() => tap(() => playAfterTrialPrompt(play)))
    expect(play).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent('😩 Tired of ads?Sign up free and get 👑 Premium (ad-free) for 2 days!')
    expect(screen.getByRole('dialog').textContent).not.toMatch(/server|premium player/i)
    await userEvent.click(screen.getByRole('button', { name: 'Continue with ads' }))
    expect(play).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Same day: straight to the video.
    act(() => tap(() => playAfterTrialPrompt(play)))
    expect(play).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trialPromptShownToday()).toBe(true)
    // Tomorrow (Lagos): once more.
    expect(trialPromptShownToday(Date.now() + DAY)).toBe(false)
    resetTrialPrompt()
    localStorage.setItem('naijatr.trialPrompt.day', '2000-01-01')
    act(() => tap(() => playAfterTrialPrompt(play)))
    expect(play).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('"Sign up free" opens the sign-up sheet, noted as from the Play popup', async () => {
    setAccountForTests({ status: 'signedOut', user: null })
    resetReferralStatus(signedOutStatus())
    render(
      <>
        <TrialPromptHost />
        <Sheet />
      </>,
    )
    const play = vi.fn()
    act(() => tap(() => playAfterTrialPrompt(play)))
    await userEvent.click(screen.getByRole('button', { name: 'Sign up free' }))
    expect(screen.getByTestId('sheet')).toHaveTextContent('create')
    expect(signupSource()).toBe('play-popup')
    expect(play).not.toHaveBeenCalled()
  })

  it('never for signed-in accounts, and never on top of another popup', () => {
    signIn()
    resetReferralStatus(signedOutStatus())
    const play = vi.fn()
    tap(() => playAfterTrialPrompt(play))
    expect(play).toHaveBeenCalledTimes(1)
    setAccountForTests({ status: 'signedOut', user: null })
    const other = document.createElement('div')
    other.setAttribute('role', 'dialog')
    document.body.append(other)
    tap(() => playAfterTrialPrompt(play))
    expect(play).toHaveBeenCalledTimes(2)
    other.remove()
    expect(trialPromptShownToday()).toBe(false)
  })
})
