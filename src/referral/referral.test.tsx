import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureReferral, readRef, REF_KEY } from './capture'
import { formatCountdown, reportReferralPlay } from './api'
import { saveSession } from './session'

const HOUR = 3_600_000
const live = { phase: 'live', start: Date.now() - HOUR, end: Date.now() + 2 * 24 * HOUR, prizes: [30000, 20000, 10000], winners: null }

let fetchMock: ReturnType<typeof vi.fn>
const posts = (action: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === `/api/referral/${action}`).map(([, init]) => JSON.parse(String((init as RequestInit).body)))

function mockApi(contest: object = live) {
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/referral/contest') return Response.json(contest)
    if (url === '/api/referral/me') return Response.json({ user: { code: 'BRUNO23', nickname: '@bruno', hidden: false, link: 'https://www.naijatr.com/r/BRUNO23' }, total: 2, points: 2, rank: 1 })
    return Response.json({ ok: true, outcome: 'counted' })
  })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  document.cookie = 'naijatr_ref=; Max-Age=0; Path=/'
  document.cookie = 'naijatr_gate_joined=; Max-Age=0; Path=/'
  mockApi()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  saveSession(null)
})

describe('invite links', () => {
  it('keeps the code of a new device, tells the server, and goes to the home page', () => {
    window.history.replaceState(null, '', '/r/bruno23')
    captureReferral()
    expect(readRef()).toMatchObject({ code: 'BRUNO23', newDevice: true, reported: false })
    expect(document.cookie).toContain('naijatr_ref=BRUNO23')
    expect(posts('arrive')[0]).toMatchObject({ code: 'BRUNO23', newDevice: true })
    expect(window.location.pathname).toBe('/')
  })

  it('knows a device that visited before', () => {
    window.localStorage.setItem('naijatr:continueWatching', '[]')
    window.history.replaceState(null, '', '/r/BRUNO23')
    captureReferral()
    expect(readRef()?.newDevice).toBe(false)
  })

  it('keeps the first link a device opened', () => {
    captureReferral('/r/FIRST1')
    captureReferral('/r/SECOND2')
    expect(readRef()?.code).toBe('FIRST1')
    expect(posts('arrive')).toHaveLength(1)
  })

  it('reports the first play once, and again only after a network failure', async () => {
    captureReferral('/r/BRUNO23')
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    reportReferralPlay()
    await vi.waitFor(() => expect(readRef()?.reported).toBe(false))
    // The failed try, then the retry on the next play; after that, never again.
    reportReferralPlay()
    await vi.waitFor(() => expect(posts('count')).toHaveLength(2))
    reportReferralPlay()
    expect(readRef()?.reported).toBe(true)
    expect(posts('count')).toHaveLength(2)
  })

  it('never reports for a returning device', () => {
    window.localStorage.setItem(REF_KEY, JSON.stringify({ code: 'BRUNO23', at: Date.now(), newDevice: false, reported: false }))
    reportReferralPlay()
    expect(posts('count')).toHaveLength(0)
  })

  it('counts down', () => {
    expect(formatCountdown(26 * HOUR + 61_000)).toBe('1d 02h 01m 01s')
    expect(formatCountdown(-5)).toBe('00h 00m 00s')
  })
})

describe('contest popup, banner and guide', () => {
  async function host() {
    const { ContestHost } = await import('./Invite')
    return render(<ContestHost />)
  }

  it('shows the popup once per session, then the banner', async () => {
    const user = userEvent.setup()
    const { unmount } = await host()
    expect(await screen.findByRole('dialog', { name: /Invite friends & win up to ₦30,000!/ })).toBeInTheDocument()
    expect(screen.getByText('🥇₦30k · 🥈₦20k · 🥉₦10k')).toBeInTheDocument()
    expect(screen.queryByText('Your friend invited you 👋')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Maybe later' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Invite and win' })).toBeInTheDocument()
    unmount()
    await host()
    await screen.findByRole('region', { name: 'Invite and win' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('greets invited visitors, and closes on Escape', async () => {
    window.sessionStorage.setItem('naijatr.ref.invited', '1')
    await host()
    expect(await screen.findByText('Your friend invited you 👋')).toBeInTheDocument()
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('walks through the guide and remembers the step', async () => {
    const user = userEvent.setup()
    const { unmount } = await host()
    await user.click(await screen.findByRole('button', { name: /I'm interested/ }))
    expect(screen.getByRole('heading', { name: 'The Prizes 🏆' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByRole('heading', { name: 'How it works 🔗' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    unmount()
    await host()
    const { openInviteGuide } = await import('./guide')
    act(() => openInviteGuide())
    expect(await screen.findByRole('heading', { name: 'How it works 🔗' })).toBeInTheDocument()
  })

  it('skips straight to the link once joined', async () => {
    saveSession({ token: 't', user: { code: 'BRUNO23', nickname: '@bruno', hidden: false, link: 'https://www.naijatr.com/r/BRUNO23' } })
    window.sessionStorage.setItem('naijatr.contest.popup', '1')
    await host()
    const { openInviteGuide } = await import('./guide')
    await screen.findByRole('region', { name: 'Invite and win' })
    act(() => openInviteGuide())
    expect(screen.getByRole('heading', { name: 'Get started 🚀' })).toBeInTheDocument()
    expect(screen.getByText('https://www.naijatr.com/r/BRUNO23')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toContain(
      encodeURIComponent('I watch movies, series & live football on NAIJA TR 🍿⚽ Join with my link 👉 https://www.naijatr.com/r/BRUNO23'),
    )
    expect(await screen.findByText('#1')).toBeInTheDocument()
  })

  it('shows nothing about prizes when no contest runs', async () => {
    mockApi({ phase: 'ended', start: 1, end: 2, prizes: null, winners: ['@a', '@b', '@c'] })
    await host()
    expect(await screen.findByRole('region', { name: 'Challenge winners' })).toHaveTextContent('🏆 Challenge winners: 🥇@a · 🥈@b · 🥉@c. Thanks to everyone who joined! 🙏')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument()
  })
})
