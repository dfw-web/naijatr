import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccount, setAccountForTests, signupSource } from '../account/account'
import { AccountMenu } from '../account/AccountMenu'
import { AccountPage, MyListPage } from '../account/AccountPages'
import { AuthRoot } from '../account/AuthRoot'
import { authPageUrl, nextPage, pageLoad, safeNext } from '../account/pages'
import { SyncPromptHost } from '../account/SyncPrompt'
import { resetSync } from '../account/sync'
import { PromoWeekBanner } from '../promo/PromoWeek'
import { playAfterTrialPrompt, resetTrialPrompt } from '../promo/trialPrompt'
import { TrialPromptHost } from '../promo/WelcomeTrial'
import { resetReferralStatus, type ReferralStatus } from '../referral/status'
import { adLinkClicks } from '../test/ads'
import type { MediaItem } from '../types/media'
import { saveForLater } from '../utils/watchLater'
import { cardAd } from './adManager'
import { resetAuthGuard, shieldAuthPage, shieldRemoved } from './authGuard'
import { adsDisabled, openAd } from './directLink'
import { loadMultitag, useMultitag } from './monetag'
import vercelJson from '../../vercel.json?raw'

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

/** A tap on a title card, as the site's cards make. */
function tapCard(id = 'elsewhere') {
  const button = document.createElement('button')
  button.addEventListener('click', (event) => cardAd(event, { id }))
  document.body.append(button)
  button.click()
  button.remove()
}

const EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'] as const

/**
 * Stand-ins for an ad script that's already on the page, added after the app
 * started (as the Multitag is): a window capture listener, plus document ones.
 */
let adScript: ReturnType<typeof vi.fn<(event: Event) => void>>
beforeEach(() => {
  adScript = vi.fn<(event: Event) => void>()
  for (const type of EVENTS) {
    window.addEventListener(type, adScript, true)
    document.addEventListener(type, adScript, true)
    document.addEventListener(type, adScript)
  }
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test')
})

afterEach(() => {
  for (const type of EVENTS) {
    window.removeEventListener(type, adScript, true)
    document.removeEventListener(type, adScript, true)
    document.removeEventListener(type, adScript)
  }
  document.querySelectorAll('script[data-zone]').forEach((node) => node.remove())
  resetSync()
  resetAccount()
  resetTrialPrompt()
  vi.unstubAllEnvs()
})

const signedOut = () => setAccountForTests({ status: 'signedOut', user: null })
const signedIn = () => setAccountForTests({ status: 'signedIn', user: { id: 'u1', email: 'ada@gmail.com', passwordSet: true } })

/** Taps `button` like a phone does, and checks no ad script heard any of it, and the auth page opened with a full page load. */
async function expectAuthTap(button: HTMLElement, url: string) {
  const sameTap: boolean[] = []
  const trigger = (event: Event) => sameTap.push(cardAd(event, { id: 'same' }), openAd(event, 'same'))
  button.addEventListener('click', trigger)
  adScript.mockClear()
  vi.mocked(pageLoad.assign).mockClear()
  await userEvent.click(button)
  button.removeEventListener('click', trigger)
  expect(adScript, `an ad script heard the tap on "${button.textContent}"`).not.toHaveBeenCalled()
  expect(sameTap).not.toContain(true)
  expect(adLinkClicks()).toHaveLength(0)
  expect(pageLoad.assign).toHaveBeenCalledTimes(1)
  expect(pageLoad.assign).toHaveBeenCalledWith(url)
}

describe('auth buttons: the tap never reaches an ad script, and the auth page opens with a full page load', () => {
  beforeEach(() => window.history.replaceState(null, '', '/movies?genre=drama'))
  const next = '?next=%2Fmovies%3Fgenre%3Ddrama'

  it('Sign in to sync (header): /signup, or /login for a known device', async () => {
    signedOut()
    const { unmount } = render(<AccountMenu />)
    await expectAuthTap(screen.getByRole('button', { name: 'Sign in to sync' }), `/signup${next}`)
    unmount()
    localStorage.setItem('naijatr.sync.user', 'u1')
    render(<AccountMenu />)
    await expectAuthTap(screen.getByRole('button', { name: 'Sign in to sync' }), `/login${next}`)
  })

  it('the account/avatar button: /account (Sign out and the password live there, no ad script)', async () => {
    signedIn()
    render(<AccountMenu />)
    await expectAuthTap(screen.getByRole('button', { name: 'Account: ada@gmail.com' }), '/account')
  })

  it('My List’s Sign in to sync it', async () => {
    signedOut()
    render(<MyListPage onSelect={() => undefined} />)
    await expectAuthTap(screen.getByRole('button', { name: 'Sign in to sync it' }), `/signup${next}`)
  })

  it('the sync prompt’s Create free account', async () => {
    signedOut()
    saveForLater(film)
    render(<SyncPromptHost delayMs={0} />)
    await expectAuthTap(await screen.findByRole('button', { name: 'Create free account' }), `/signup${next}`)
  })

  it('the Play popup’s Sign up free (noted as from the Play popup)', async () => {
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
    render(<TrialPromptHost />)
    act(() => {
      const play = document.createElement('button')
      play.addEventListener('click', () => playAfterTrialPrompt(() => undefined))
      document.body.append(play)
      play.click()
      play.remove()
    })
    await expectAuthTap(screen.getByRole('button', { name: 'Sign up free' }), `/signup${next}`)
    expect(signupSource()).toBe('play-popup')
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
    render(<PromoWeekBanner />)
    await expectAuthTap(screen.getByRole('button', { name: 'Sign in' }), `/signup${next}`)
  })

  it('other taps still work as usual (a card still opens its ad)', () => {
    tapCard()
    expect(adLinkClicks()).toHaveLength(1)
    expect(adScript).toHaveBeenCalled()
  })
})

describe('the Multitag loads only after the first tap that isn’t an auth button', () => {
  function Tag() {
    useMultitag()
    return null
  }
  const tagOnPage = () => document.querySelector('script[data-zone]') !== null

  it('nothing before the first tap; a first tap on Sign in loads nothing; the next tap elsewhere loads it', async () => {
    resetAuthGuard({ interacted: false })
    signedOut()
    render(
      <>
        <Tag />
        <AccountMenu />
        <button type="button">Elsewhere</button>
      </>,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tagOnPage()).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to sync' }))
    expect(pageLoad.assign).toHaveBeenCalledWith('/signup')
    expect(tagOnPage()).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(tagOnPage()).toBe(true)
  })
})

describe('the auth pages never have an ad script', () => {
  const AUTH = ['/login', '/signup', '/auth/confirm', '/auth/reset', '/auth/set-password', '/account']

  it.each(AUTH)('%s: no Multitag, no direct-link ad', (path) => {
    expect(adsDisabled(`https://www.naijatr.com${path}`)).toBe(true)
    expect(adsDisabled(`https://www.naijatr.com${path}?next=%2Fmovies`)).toBe(true)
    window.history.replaceState(null, '', path)
    expect(loadMultitag()).toBe(false)
    expect(document.querySelector('script[data-zone]')).toBeNull()
    tapCard()
    expect(adLinkClicks()).toHaveLength(0)
  })

  it('their buttons and inputs work as usual there (no ad script to keep out)', async () => {
    window.history.replaceState(null, '', '/login?next=%2Fmovies')
    signedOut()
    render(<AuthRoot />)
    await userEvent.click(screen.getByRole('tab', { name: 'Create account' }))
    expect(window.location.pathname + window.location.search).toBe('/signup?next=%2Fmovies')
    expect(screen.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true')
    expect(pageLoad.assign).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(pageLoad.assign).toHaveBeenCalledWith('/movies')
  })

  it('the Account page’s Sign in goes to the auth page, coming back to /account', async () => {
    window.history.replaceState(null, '', '/account')
    signedOut()
    render(<AccountPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(pageLoad.assign).toHaveBeenCalledWith('/signup?next=%2Faccount')
  })

  it('the shield removes any ad script, ad frame or banner that turns up anyway', async () => {
    window.history.replaceState(null, '', '/login')
    const before = shieldRemoved()
    const tag = document.createElement('script')
    tag.src = 'https://quge5.com/88/tag.min.js'
    tag.dataset.zone = '302667'
    document.body.append(tag)
    shieldAuthPage()
    expect(tag.isConnected).toBe(false)
    const banner = document.createElement('div')
    banner.innerHTML = '<iframe src="https://ads.example-network.com/push"></iframe><script src="https://uplcm.com/x.js"></script>'
    document.body.append(banner)
    const own = document.createElement('script')
    own.src = '/assets/app.js'
    document.body.append(own)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(banner.querySelector('iframe, script')).toBeNull()
    expect(own.isConnected).toBe(true)
    expect(shieldRemoved() - before).toBe(3)
    banner.remove()
    own.remove()
  })

  it('vercel.json sends a CSP on every auth page that only allows this site’s scripts', () => {
    const config = JSON.parse(vercelJson) as { headers: { source: string; headers: { key: string; value: string }[] }[] }
    const csp = (source: string) => config.headers.find((h) => h.source === source)?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? ''
    for (const source of ['/:page(login|signup|account)', '/auth/:path*']) {
      const policy = csp(source)
      const scripts = /script-src ([^;]+)/.exec(policy)?.[1] ?? ''
      expect(scripts.split(' ').sort()).toEqual(["'self'", "'unsafe-inline'", 'https://va.vercel-scripts.com'].sort())
      expect(policy).toMatch(/default-src 'self'/)
      expect(policy).toMatch(/frame-src 'none'/)
      expect(policy).not.toMatch(/quge5|uplcm|monetag|adsterra/i)
    }
  })
})

describe('?next=', () => {
  it('comes back to the page they were on, never another site or an auth page', () => {
    expect(authPageUrl('login', '/movies?genre=drama#/movies')).toBe('/login?next=%2Fmovies%3Fgenre%3Ddrama%23%2Fmovies')
    expect(authPageUrl('signup', '/')).toBe('/signup')
    expect(safeNext('/football/match/1')).toBe('/football/match/1')
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/login', '/auth/reset', '', null]) {
      expect(safeNext(bad)).toBe('/')
    }
    expect(nextPage('https://www.naijatr.com/login?next=%2Fmy-list')).toBe('/my-list')
  })
})
