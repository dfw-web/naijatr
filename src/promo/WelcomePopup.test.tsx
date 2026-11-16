import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccount, setAccountForTests, signupSource } from '../account/account'
import { pageLoad } from '../account/pages'
import { adsAllowedNow, resetAdGate } from '../ads/adGate'
import { cardAd } from '../ads/adManager'
import { loadMultitag } from '../ads/monetag'
import { MULTITAG } from '../config/ads'
import { resetReferralStatus, type ReferralStatus } from '../referral/status'
import { playAfterTrialPrompt, resetTrialPrompt, trialPromptDue } from './trialPrompt'
import { WelcomePopupHost } from './WelcomePopup'
import { resetWelcomePopup, startWelcomePopup, WELCOME_TIMING, welcomePathAllowed, welcomePopupShown } from './welcomeStore'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

/** A signed-out visitor's status: during the promo, or after it (the trial live). */
const signedOut = (when: 'promo' | 'after', trial = true): ReferralStatus => ({
  goal: 5,
  signedIn: false,
  adFree: false,
  premium: false,
  promo:
    when === 'promo'
      ? { start: iso(Date.now() - 5 * DAY), end: iso(Date.now() + DAY), state: 'active' }
      : { start: iso(Date.now() - 8 * DAY), end: iso(Date.now() - HOUR), state: 'ended' },
  trial: trial ? { start: iso(when === 'promo' ? Date.now() + DAY : Date.now() - HOUR), live: when === 'after' } : null,
  serverNow: Date.now(),
})

const timing = { ...WELCOME_TIMING }
beforeEach(() => {
  WELCOME_TIMING.delayMs = 10
  WELCOME_TIMING.pollMs = 10
  WELCOME_TIMING.adsAfterMs = 60
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in tests'))))
  setAccountForTests({ status: 'signedOut', user: null })
  vi.mocked(pageLoad.assign).mockClear()
})
afterEach(() => {
  Object.assign(WELCOME_TIMING, timing)
  resetWelcomePopup()
  resetAdGate()
  resetAccount()
  resetTrialPrompt()
  resetReferralStatus()
  document.getElementById(MULTITAG.id)?.remove()
  vi.unstubAllGlobals()
})

async function showPopup(status: ReferralStatus | null = signedOut('promo')) {
  resetReferralStatus(status)
  render(<WelcomePopupHost />)
  act(() => startWelcomePopup())
  return screen.findByRole('dialog')
}

describe('the welcome popup: when', () => {
  it('shows ~1.5 s after the page loads for a signed-out visitor, with no ad of any kind until then', async () => {
    expect(timing.delayMs).toBe(1500)
    resetReferralStatus(signedOut('promo'))
    render(<WelcomePopupHost />)
    act(() => startWelcomePopup())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(adsAllowedNow()).toBe(false)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(adsAllowedNow()).toBe(false)
    // No Multitag, no direct-link ad while it's up.
    expect(loadMultitag()).toBe(false)
    expect(document.querySelector('script[data-zone]')).toBeNull()
    const button = document.createElement('button')
    document.body.append(button)
    let opened = true
    button.addEventListener('click', (event) => (opened = cardAd(event, { id: 'x' })))
    button.click()
    button.remove()
    expect(opened).toBe(false)
  })

  it('never shows to a signed-in account, and ads aren’t held for it', async () => {
    setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'a@gmail.com', passwordSet: true } })
    resetReferralStatus(signedOut('promo'))
    render(<WelcomePopupHost />)
    act(() => startWelcomePopup())
    expect(adsAllowedNow()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits for a device that is still checking its session, and skips it once it turns out signed in', async () => {
    setAccountForTests({ status: 'checking' })
    resetReferralStatus(signedOut('promo'))
    render(<WelcomePopupHost />)
    act(() => startWelcomePopup())
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(adsAllowedNow()).toBe(false)
    act(() => setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'a@gmail.com', passwordSet: true } }))
    await waitFor(() => expect(adsAllowedNow()).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('not on /login, /signup, /auth/*, /admin/*, /privacy, /invite/rules or /account', () => {
    for (const path of ['/login', '/signup', '/auth/confirm', '/auth/reset', '/auth/set-password', '/admin/live', '/admin', '/privacy', '/invite/rules', '/account']) {
      expect(welcomePathAllowed(path), path).toBe(false)
    }
    for (const path of ['/', '/my-list', '/invite', '/football', '/football/match/1']) expect(welcomePathAllowed(path), path).toBe(true)
  })

  it('on an excluded page: nothing, and ads aren’t held', () => {
    window.history.replaceState(null, '', '/privacy')
    act(() => startWelcomePopup())
    expect(adsAllowedNow()).toBe(true)
  })

  it('once per page load: closed, it doesn’t come back on a client-side navigation', async () => {
    await showPopup()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    act(() => startWelcomePopup())
    window.history.pushState(null, '', '/my-list')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the Play popup stays away on a visit that showed it', async () => {
    resetReferralStatus(signedOut('after'))
    expect(welcomePopupShown()).toBe(false)
    // Due on this Play otherwise.
    expect(trialPromptDue()).toBe(true)
    await showPopup(signedOut('after'))
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(welcomePopupShown()).toBe(true)
    const play = vi.fn()
    playAfterTrialPrompt(play)
    expect(play).toHaveBeenCalledOnce()
  })
})

describe('the welcome popup: wording', () => {
  it('during the promo', async () => {
    await showPopup(signedOut('promo'))
    expect(screen.getByText('NAIJA TR')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '🎉 NAIJA TR is ad-free this week!' })).toBeInTheDocument()
    expect(
      screen.getByText('Sign up free now and stay 👑 Premium (ad-free) for 2 extra days after the promo ends. Plus Continue Watching and My List on all your devices.'),
    ).toBeInTheDocument()
  })

  it('after PROMO_END', async () => {
    await showPopup(signedOut('after'))
    expect(screen.getByRole('heading', { name: '😩 Tired of ads?' })).toBeInTheDocument()
    expect(
      screen.getByText('Sign up free and enjoy 👑 NAIJA TR Premium, ad-free, for 2 days. Plus Continue Watching and My List on all your devices.'),
    ).toBeInTheDocument()
  })

  it('after PROMO_END with TRIAL_ENABLED=false: no Premium line', async () => {
    await showPopup(signedOut('after', false))
    expect(screen.getByRole('heading', { name: '😩 Tired of ads?' })).toBeInTheDocument()
    expect(screen.queryByText(/Premium/)).toBeNull()
    expect(screen.getByText('Sign up free and get Continue Watching and My List on all your devices.')).toBeInTheDocument()
  })

  it('the buttons, all marked data-no-ad', async () => {
    const dialog = await showPopup()
    expect(screen.getByRole('button', { name: 'Sign up free' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'I already have an account, Log in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument()
    expect(dialog).toHaveAttribute('data-no-ad')
    for (const button of dialog.querySelectorAll('button')) expect(button.closest('[data-no-ad]')).not.toBeNull()
    for (const button of dialog.querySelectorAll('button')) expect(button).toHaveAttribute('data-no-ad')
  })
})

describe('the welcome popup: closing, and ads after', () => {
  const ways: [string, () => Promise<void> | void][] = [
    ['✕', () => userEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Not now', () => userEvent.click(screen.getByRole('button', { name: 'Not now' }))],
    ['a tap outside', () => userEvent.click(screen.getByRole('dialog'))],
    ['Esc', async () => void (await userEvent.keyboard('{Escape}'))],
  ]
  for (const [way, close] of ways) {
    it(`closes with ${way}; ads only 3 seconds later`, async () => {
      expect(timing.adsAfterMs).toBe(3000)
      await showPopup()
      await close()
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(adsAllowedNow()).toBe(false)
      expect(loadMultitag()).toBe(false)
      await waitFor(() => expect(adsAllowedNow()).toBe(true))
      expect(pageLoad.assign).not.toHaveBeenCalled()
    })
  }

  it('a tap inside the card doesn’t close it', async () => {
    await showPopup()
    fireEvent.click(screen.getByRole('heading'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('"Sign up free": a full page load to /signup?next=<this page>, counted as the welcome popup’s; ads stay off', async () => {
    window.history.replaceState(null, '', '/?genre=comedy#/movies')
    await showPopup()
    await userEvent.click(screen.getByRole('button', { name: 'Sign up free' }))
    expect(pageLoad.assign).toHaveBeenCalledWith(`/signup?next=${encodeURIComponent('/?genre=comedy#/movies')}`)
    expect(signupSource()).toBe('welcome-popup')
    expect(adsAllowedNow()).toBe(false)
  })

  it('"Log in": a full page load to /login?next=<this page>', async () => {
    window.history.replaceState(null, '', '/my-list')
    await showPopup()
    await userEvent.click(screen.getByRole('button', { name: 'I already have an account, Log in' }))
    expect(pageLoad.assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/my-list')}`)
    expect(adsAllowedNow()).toBe(false)
  })
})
