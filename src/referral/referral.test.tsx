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
  // An invite leaves ?ref=CODE in the address bar: start each test on a plain home page.
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
  window.sessionStorage.clear()
  document.cookie = 'naijatr_ref=; Max-Age=0; Path=/'
  document.cookie = 'naijatr_gate_joined=; Max-Age=0; Path=/'
  mockApi()
})
afterEach(async () => {
  // A closed popup drops its Back-button entry a moment later: let it land before the next test.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
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

  it('shows the popup on every visit, and the banner once closed', async () => {
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
    expect(await screen.findByRole('dialog', { name: /Invite friends & win/ })).toBeInTheDocument()
  })

  it('announces the contest before it starts, counting down to the start', async () => {
    mockApi({ ...live, phase: 'upcoming', start: Date.now() + 2 * HOUR })
    await host()
    expect(await screen.findByRole('dialog', { name: /Invite friends & win up to ₦30,000!/ })).toBeInTheDocument()
    expect(screen.getByText(/^⏳ Starts in 01h 59m/)).toBeInTheDocument()
    expect(screen.getByText(/^Starts .* · ends /)).toBeInTheDocument()
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
    await host()
    const { openInviteGuide } = await import('./guide')
    await screen.findByRole('dialog')
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    act(() => openInviteGuide())
    expect(screen.getByRole('heading', { name: 'Get started 🚀' })).toBeInTheDocument()
    expect(screen.getByText('https://www.naijatr.com/r/BRUNO23')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toContain(
      encodeURIComponent('I watch movies, series & live football on NAIJA TR 🍿⚽ Join with my link 👉 https://www.naijatr.com/r/BRUNO23'),
    )
    expect(await screen.findByText('#1')).toBeInTheDocument()
  })

  it('previews the contest on this device only, with share buttons to try', async () => {
    const user = userEvent.setup()
    mockApi({ phase: 'off', start: null, end: null, prizes: null, winners: null })
    window.history.replaceState(null, '', '/?preview=contest')
    captureReferral()
    await host()
    expect(await screen.findByText('Preview: only you see this. The challenge isn’t running yet.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /I'm interested/ }))
    act(() => window.localStorage.setItem('naijatr.invite.step', '4'))
    for (let i = 0; i < 4; i += 1) await user.click(screen.getByRole('button', { name: /Next/ }))
    expect(screen.getByRole('heading', { name: 'Get started 🚀' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', expect.stringContaining('r%2FPREVIEW'))
    window.history.replaceState(null, '', '/')
  })

  it('opens the apps themselves on phones', async () => {
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14) Mobile')
    saveSession({ token: 't', user: { code: 'BRUNO23', nickname: '@bruno', hidden: false, link: 'https://www.naijatr.com/r/BRUNO23' } })
    await host()
    const { openInviteGuide } = await import('./guide')
    await screen.findByRole('dialog')
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    act(() => openInviteGuide())
    const whatsapp = screen.getByRole('link', { name: 'WhatsApp' })
    expect(whatsapp.getAttribute('href')).toMatch(/^whatsapp:\/\/send\?text=I%20watch/)
    expect(whatsapp).not.toHaveAttribute('target')
    expect(screen.getByRole('link', { name: 'Telegram' }).getAttribute('href')).toMatch(/^tg:\/\/msg_url\?url=https%3A%2F%2Fwww.naijatr.com%2Fr%2FBRUNO23/)
    agent.mockRestore()
  })

  it('shows nothing about prizes when no contest runs', async () => {
    mockApi({ phase: 'ended', start: 1, end: 2, prizes: null, winners: ['@a', '@b', '@c'] })
    await host()
    expect(await screen.findByRole('region', { name: 'Challenge winners' })).toHaveTextContent('🏆 Challenge winners: 🥇@a · 🥈@b · 🥉@c. Thanks to everyone who joined! 🙏')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument()
  })
})

describe('"You can win too" popup for invited visitors', () => {
  const WIN_TOO = /You too can win cash prizes!/

  /** Fresh modules, so the popup's state starts over in each test. */
  async function visit({ invited = true, outcome = 'counted' } = {}) {
    if (invited) captureReferral('/r/BRUNO23')
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/referral/contest' ? Response.json(live) : Response.json({ ok: true, outcome }),
    )
    const [{ ContestHost }, api, invitee] = await Promise.all([import('./Invite'), import('./api'), import('./invitee')])
    const view = render(<ContestHost />)
    const user = userEvent.setup()
    // The arrival popup, as before.
    await user.click(await screen.findByRole('button', { name: 'Maybe later' }))
    // Its Back-button entry is dropped a moment later (the visitor is watching a movie by then).
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    /** Plays a movie, then closes the player. */
    const watchAndClose = async () => {
      await act(async () => {
        await api.reportReferralPlay()
        await invitee.playerClosed()
      })
    }
    return { view, user, watchAndClose, invitee }
  }

  it('leaves the arrival popup as it is', async () => {
    await visit()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(WIN_TOO)).not.toBeInTheDocument()
  })

  it('shows once the player closes after the first counted watch, and only once per device', async () => {
    const { user, watchAndClose, view, invitee } = await visit()
    await watchAndClose()
    const dialog = await screen.findByRole('dialog', { name: WIN_TOO })
    expect(dialog).toHaveTextContent('👋 Your friend invited you to NAIJA TR!')
    expect(dialog).toHaveTextContent('🥇 ₦30,000 · 🥈 ₦20,000 · 🥉 ₦10,000')
    expect(dialog).toHaveTextContent(/Invite your own friends and climb the leaderboard\. Ends \w+day \d+ \w{3}, \d+:\d\d [AP]M\./)
    expect(dialog).toHaveTextContent(/⏳ Ends in/)
    await user.click(screen.getByRole('button', { name: 'Maybe later' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Another movie, another close: not again.
    await watchAndClose()
    expect(screen.queryByRole('dialog', { name: WIN_TOO })).not.toBeInTheDocument()
    view.unmount()
    await act(() => invitee.playerClosed())
    expect(window.localStorage.getItem(invitee.INVITEE_SHOWN_KEY)).toBe('1')
  })

  it('opens the step-by-step guide on "Yes, I\'m interested"', async () => {
    const { user, watchAndClose } = await visit()
    await watchAndClose()
    await user.click(await screen.findByRole('button', { name: "Yes, I'm interested 👀" }))
    expect(screen.getByRole('dialog', { name: 'The Prizes 🏆' })).toBeInTheDocument()
  })

  it('closes on Escape (like Back)', async () => {
    const { watchAndClose } = await visit()
    await watchAndClose()
    await screen.findByRole('dialog', { name: WIN_TOO })
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('never shows to visitors who came without an invite link', async () => {
    const { watchAndClose } = await visit({ invited: false })
    await watchAndClose()
    expect(screen.queryByText(WIN_TOO)).not.toBeInTheDocument()
    expect(posts('count')).toHaveLength(0)
  })

  it('waits for a watch that counted for the friend', async () => {
    const { watchAndClose } = await visit({ outcome: 'ip-cap' })
    await watchAndClose()
    expect(screen.queryByText(WIN_TOO)).not.toBeInTheDocument()
  })

  it('skips visitors who already joined the challenge', async () => {
    saveSession({ token: 't', user: { code: 'ADA11', nickname: '@ada', hidden: false, link: 'https://www.naijatr.com/r/ADA11' } })
    captureReferral('/r/BRUNO23')
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/referral/contest' ? Response.json(live) : url === '/api/referral/me' ? Response.json(null) : Response.json({ ok: true, outcome: 'counted' }),
    )
    const [{ ContestHost }, api, invitee] = await Promise.all([import('./Invite'), import('./api'), import('./invitee')])
    render(<ContestHost />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Maybe later' }))
    await act(async () => {
      await api.reportReferralPlay()
      await invitee.playerClosed()
    })
    expect(screen.queryByText(WIN_TOO)).not.toBeInTheDocument()
  })

  it('is hidden once the contest has ended', async () => {
    captureReferral('/r/BRUNO23')
    mockApi({ phase: 'ended', start: Date.now() - 3 * HOUR, end: Date.now() - HOUR, prizes: null, winners: null })
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/referral/contest' ? Response.json({ phase: 'ended', start: 1, end: 2, prizes: null, winners: null }) : Response.json({ ok: true, outcome: 'counted' }),
    )
    const [{ ContestHost }, api, invitee] = await Promise.all([import('./Invite'), import('./api'), import('./invitee')])
    render(<ContestHost />)
    await act(async () => {
      await api.reportReferralPlay()
      await invitee.playerClosed()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('goes away by itself when the contest ends while it is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      captureReferral('/r/BRUNO23')
      const endingSoon = { ...live, end: Date.now() + 60_000 }
      fetchMock.mockImplementation(async (url: string) =>
        url === '/api/referral/contest' ? Response.json(endingSoon) : Response.json({ ok: true, outcome: 'counted' }),
      )
      const [{ ContestHost }, api, invitee] = await Promise.all([import('./Invite'), import('./api'), import('./invitee')])
      render(<ContestHost />)
      fireClick(await screen.findByRole('button', { name: 'Maybe later' }))
      await act(async () => {
        await api.reportReferralPlay()
        await invitee.playerClosed()
      })
      expect(await screen.findByRole('dialog', { name: WIN_TOO })).toBeInTheDocument()
      act(() => void vi.advanceTimersByTime(61_000))
      expect(screen.queryByRole('dialog', { name: WIN_TOO })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

const fireClick = (element: HTMLElement) => act(() => element.click())
