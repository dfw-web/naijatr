import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { closeSignIn, openSignIn, resetAccount, setAccountForTests } from '../account/account'
import { AccountMenu } from '../account/AccountMenu'
import { AccountPage, AuthConfirmPage, AuthResetPage, MyListPage } from '../account/AccountPages'
import { resetClient } from '../account/client'
import { SignInHost } from '../account/SignInSheet'
import { SyncPromptHost } from '../account/SyncPrompt'
import { resetSync } from '../account/sync'
import { PromoWeekBanner } from '../promo/PromoWeek'
import { playAfterTrialPrompt, resetTrialPrompt } from '../promo/trialPrompt'
import { TrialPromptHost } from '../promo/WelcomeTrial'
import { InvitePage } from '../referral/Invite'
import { resetReferralStatus, type ReferralStatus } from '../referral/status'
import { adLinkClicks } from '../test/ads'
import type { MediaItem } from '../types/media'
import { saveForLater } from '../utils/watchLater'
import { adClock, cardAd, installQuietZones, playbackAd, searchAd } from './adManager'
import { AUTH_QUIET_MS, isAuthInProgress } from './authQuiet'
import { adsDisabled, openAd } from './directLink'
import { loadMultitag } from './monetag'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

const film: MediaItem = {
  id: 'tmdb-movie-1',
  tmdbId: 1,
  title: 'Film 1',
  type: 'movie',
  year: 2020,
  releaseDate: null,
  genres: [],
  score: 7,
  voteCount: 1,
  popularity: 1,
  description: '',
  poster: null,
  backdrop: null,
}

/** A tap somewhere else on the page (a title card), as the site's cards make. */
function tapCard(id = 'elsewhere') {
  const button = document.createElement('button')
  button.addEventListener('click', (event) => cardAd(event, { id }))
  document.body.append(button)
  button.click()
  button.remove()
}

const START = Date.parse('2026-11-15T12:00:00Z')
const at = (ms: number) => (adClock.now = () => START + ms)

/** Everything listening on the whole page, as the Monetag Multitag does. */
let pageWide: ReturnType<typeof vi.fn<(event: Event) => void>>
const PAGE_EVENTS = ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'submit'] as const

function renderApp(ui: React.ReactElement) {
  const result = render(ui)
  installQuietZones(result.container)
  return result
}

/**
 * Taps `button` and checks no ad of any kind came of it: no direct-link ad
 * (even from an ad trigger on the same tap), nothing reached the page-wide ad
 * listeners, and no ad on another tap within the next 10 seconds.
 */
async function expectNoAdFrom(button: HTMLElement, name = button.textContent) {
  const sameTap: boolean[] = []
  // An ad trigger on the very same tap (a card around the button, a Play behind it).
  const trigger = (event: Event) => sameTap.push(cardAd(event, { id: 'same-tap' }), openAd(event, 'same-tap'))
  button.addEventListener('click', trigger)
  pageWide.mockClear()
  const before = adLinkClicks().length
  await userEvent.click(button)
  button.removeEventListener('click', trigger)
  expect(sameTap, `same tap: ${name}`).not.toContain(true)
  expect(pageWide, `page-wide listeners heard: ${name}`).not.toHaveBeenCalled()
  expect(adLinkClicks().length, `direct link: ${name}`).toBe(before)
  // Within 10 seconds of it: still no ad anywhere.
  at(AUTH_QUIET_MS - 1000)
  tapCard()
  expect(adLinkClicks().length, `next tap: ${name}`).toBe(before)
}

const fakeClient = {
  auth: {
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: { user: null, session: null }, error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 } })),
    getSession: vi.fn(async () => ({ data: { session: null } })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
    signOut: vi.fn(async () => ({ error: null })),
  },
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test')
  resetClient(Promise.resolve(fakeClient as unknown as SupabaseClient))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'new' }))))
  at(0)
  pageWide = vi.fn<(event: Event) => void>()
  for (const type of PAGE_EVENTS) document.addEventListener(type, pageWide)
})

afterEach(() => {
  for (const type of PAGE_EVENTS) document.removeEventListener(type, pageWide)
  document.querySelectorAll('script[data-zone]').forEach((node) => node.remove())
  resetSync()
  resetAccount()
  resetClient()
  resetTrialPrompt()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const signedOut = () => setAccountForTests({ status: 'signedOut', user: null })
const signedIn = () => setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'ada@gmail.com', passwordSet: true } })

describe('no ads from auth buttons', () => {
  it('the header’s Sign in to sync', async () => {
    signedOut()
    renderApp(<AccountMenu />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Sign in to sync' }))
  })

  it('the account/avatar button, and Log out in its menu', async () => {
    signedIn()
    renderApp(<AccountMenu />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Account: ada@gmail.com' }))
    at(AUTH_QUIET_MS * 3)
    await expectNoAdFrom(screen.getByRole('menuitem', { name: 'Sign out' }))
  })

  it('the Account page’s Sign in, and its Log out', async () => {
    signedOut()
    const { unmount } = renderApp(<AccountPage />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Sign in' }))
    unmount()
    act(() => closeSignIn())
    at(AUTH_QUIET_MS * 3)
    signedIn()
    renderApp(<AccountPage />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Sign out' }))
  })

  it('My List’s Sign in to sync it', async () => {
    signedOut()
    renderApp(<MyListPage onSelect={() => undefined} />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Sign in to sync it' }))
  })

  it('the email pages’ Send a new link and Log in or reset again', async () => {
    signedOut()
    const { unmount } = renderApp(<AuthConfirmPage />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Send a new link' }))
    unmount()
    at(AUTH_QUIET_MS * 3)
    renderApp(<AuthResetPage />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Log in or reset again' }))
  })

  it('the sync prompt’s Create free account', async () => {
    signedOut()
    saveForLater(film)
    renderApp(<SyncPromptHost delayMs={0} />)
    await expectNoAdFrom(await screen.findByRole('button', { name: 'Create free account' }))
  })

  it('the Play popup’s Sign up free', async () => {
    signedOut()
    resetReferralStatus({
      goal: 5,
      signedIn: false,
      adFree: false,
      premium: false,
      promo: null,
      trial: { start: iso(Date.now() - HOUR), live: true },
      serverNow: Date.now(),
    } as ReferralStatus)
    renderApp(<TrialPromptHost />)
    act(() => {
      const play = document.createElement('button')
      play.addEventListener('click', () => playAfterTrialPrompt(() => undefined))
      document.body.append(play)
      play.click()
      play.remove()
    })
    await expectNoAdFrom(screen.getByRole('button', { name: 'Sign up free' }))
  })

  it('the Free Ad-Free Week banner’s Sign in', async () => {
    signedOut()
    resetReferralStatus({
      goal: 5,
      signedIn: false,
      adFree: false,
      promo: { start: iso(Date.now() - DAY), end: iso(Date.now() + 6 * DAY), state: 'active' },
      serverNow: Date.now(),
    } as ReferralStatus)
    renderApp(<PromoWeekBanner />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Sign in' }))
  })

  it('the invite page’s Create account and Log in', async () => {
    signedOut()
    renderApp(<InvitePage />)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Create a free account to start inviting' }))
    act(() => closeSignIn())
    at(AUTH_QUIET_MS * 3)
    await expectNoAdFrom(screen.getByRole('button', { name: 'Log in' }))
  })
})

describe('no ads in the sign-in sheet', () => {
  it('every button and input in it, and none for 10 seconds after it closes', async () => {
    signedOut()
    renderApp(<SignInHost />)
    act(() => openSignIn('login'))
    const sheet = () => screen.getByRole('dialog', { name: 'Your NAIJA TR account' })
    expect(sheet()).toHaveAttribute('data-no-ad')
    expect(isAuthInProgress()).toBe(true)

    // Log in tab: inputs, show password, Forgot password?, Log in.
    await expectNoAdFrom(within(sheet()).getByLabelText('Email'), 'login email')
    await userEvent.type(within(sheet()).getByLabelText('Email'), 'ada@example.com')
    await expectNoAdFrom(within(sheet()).getByLabelText('Password'), 'password')
    await userEvent.type(within(sheet()).getByLabelText('Password'), 'wrong-password')
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: 'Show password' }))
    await expectNoAdFrom(within(sheet()).getAllByRole('button', { name: 'Log in' }).at(-1)!, 'Log in (submit)')
    expect(await within(sheet()).findByText('Wrong email or password.')).toBeInTheDocument()
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: /Never set a password/ }), 'Resend / finish setup')
    // That sent a link: "Check your email" with Send it again / Use a different email.
    await expectNoAdFrom(await within(sheet()).findByRole('button', { name: /Send it again/ }), 'Send it again')
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: 'Use a different email' }))

    // Forgot password → Send reset link → Back to Log in.
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: 'Forgot password?' }))
    await expectNoAdFrom(within(sheet()).getByLabelText('Email'), 'reset email')
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: /Send reset link/ }), 'Send reset link')
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: 'Back to Log in' }))

    // Create account tab and its button.
    await expectNoAdFrom(within(sheet()).getByRole('tab', { name: 'Create account' }))
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: /Create free account/ }), 'Create free account')
    await expectNoAdFrom(within(sheet()).getByRole('tab', { name: 'Log in' }))
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: 'Privacy' }))
    // (That went to /privacy, which never shows ads: back home.)
    window.history.replaceState(null, '', '/')

    // Close: no ad on that tap…
    act(() => openSignIn('login'))
    await expectNoAdFrom(within(sheet()).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // …nor for 10 seconds after (expectNoAdFrom checked 9 s); then ads as usual.
    const closedAt = adClock.now() - START
    at(closedAt + AUTH_QUIET_MS + 1)
    tapCard()
    expect(adLinkClicks()).toHaveLength(1)
  })

  it('"Not now" closes it with no ad either', async () => {
    signedOut()
    renderApp(<SignInHost />)
    act(() => openSignIn('create'))
    await expectNoAdFrom(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('blocks every trigger while it’s open: cards, Play, search', () => {
    signedOut()
    render(<SignInHost />)
    act(() => openSignIn('create'))
    const tap = (fn: (event: Event) => boolean) => {
      const button = document.createElement('button')
      let opened = false
      button.addEventListener('click', (event) => (opened = fn(event)))
      document.body.append(button)
      button.click()
      button.remove()
      return opened
    }
    expect(tap((event) => cardAd(event, film))).toBe(false)
    expect(tap(() => playbackAd('title:tmdb-movie-1'))).toBe(false)
    expect(tap(() => playbackAd('match:1'))).toBe(false)
    expect(tap((event) => searchAd(event))).toBe(false)
    expect(tap((event) => openAd(event, 'x'))).toBe(false)
    expect(adLinkClicks()).toHaveLength(0)
  })

  it('the Multitag waits while it’s open, and loads 10 seconds after it closes', () => {
    vi.useFakeTimers({ now: START })
    adClock.now = () => Date.now()
    signedOut()
    render(<SignInHost />)
    act(() => openSignIn('create'))
    expect(loadMultitag()).toBe(false)
    expect(document.querySelector('script[data-zone]')).toBeNull()
    act(() => closeSignIn())
    act(() => vi.advanceTimersByTime(AUTH_QUIET_MS - 1000))
    expect(document.querySelector('script[data-zone]')).toBeNull()
    act(() => vi.advanceTimersByTime(3000))
    expect(document.querySelector('script[data-zone]')).not.toBeNull()
  })
})

describe('no ads on the auth and invite pages', () => {
  it.each(['/auth/confirm', '/auth/reset', '/invite', '/invite/rules', '/invite/AB12CD'])('%s', (path) => {
    expect(adsDisabled(`https://www.naijatr.com${path}`)).toBe(true)
    window.history.replaceState(null, '', path)
    expect(loadMultitag()).toBe(false)
    tapCard()
    expect(adLinkClicks()).toHaveLength(0)
  })
})
