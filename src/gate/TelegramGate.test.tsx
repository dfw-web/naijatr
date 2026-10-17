import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { isPhoneOrTablet, playAfterGate, readGateToken } from './gateStore'
import { TelegramGateHost } from './TelegramGate'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
const DAY_S = 24 * 60 * 60

/** A gate token as the server makes it (the browser only reads the payload). */
const gateToken = (iat = Math.floor(Date.now() / 1000)) =>
  `${btoa(JSON.stringify({ uid: 42, iat })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.signature`

let userAgent: MockInstance
let va: ReturnType<typeof vi.fn>
const tracked = () => va.mock.calls.filter(([type]) => type === 'pageview').map(([, data]) => data.path)

/** Stubs /api/telegram/*: `verify` and `recheck` answer with the given bodies. */
function stubApi(answers: { verify?: object; recheck?: object; config?: object | 'fail' } = {}) {
  const fetchFn = vi.fn(async (url: string) => {
    if (url === '/api/telegram/config') {
      if (answers.config === 'fail') throw new Error('offline')
      return new Response(JSON.stringify(answers.config ?? { botId: 123 }))
    }
    if (url === '/api/telegram/verify') return new Response(JSON.stringify(answers.verify ?? { status: 'joined', token: gateToken() }))
    if (url === '/api/telegram/recheck') return new Response(JSON.stringify(answers.recheck ?? { status: 'joined', token: gateToken() }))
    throw new Error(`unexpected ${url}`)
  })
  vi.stubGlobal('fetch', fetchFn)
  return fetchFn
}

/** Telegram's widget: logs in as user 42 straight away (or is closed, with `false`). */
function stubTelegramLogin(result: object | false = { id: 42, first_name: 'Ada', auth_date: 1, hash: 'abc' }) {
  const auth = vi.fn((_options: { bot_id: number }, callback: (data: object | false) => void) => callback(result))
  window.Telegram = { Login: { auth } } as unknown as Window['Telegram']
  return auth
}

function firstPlay() {
  const action = vi.fn()
  render(<TelegramGateHost />)
  act(() => playAfterGate(action))
  return action
}

beforeEach(() => {
  userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
  va = vi.fn()
  window.va = va as unknown as typeof window.va
})

afterEach(() => {
  userAgent.mockRestore()
  vi.unstubAllGlobals()
  delete window.Telegram
  delete window.va
})

describe('isPhoneOrTablet', () => {
  it('gates phones and tablets, not laptops or desktops', () => {
    expect(isPhoneOrTablet(IPHONE, 5)).toBe(true)
    expect(isPhoneOrTablet('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36', 5)).toBe(true)
    expect(isPhoneOrTablet('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 5)).toBe(true)
    // iPadOS asks for the desktop site: a Mac with a touch screen.
    expect(isPhoneOrTablet('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5)).toBe(true)
    expect(isPhoneOrTablet('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 0)).toBe(false)
    expect(isPhoneOrTablet('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', 10)).toBe(false)
    expect(isPhoneOrTablet('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0', 0)).toBe(false)
    expect(isPhoneOrTablet('Mozilla/5.0 (X11; CrOS x86_64) Chrome/130.0', 10)).toBe(false)
  })
})

describe('Telegram gate', () => {
  it('lets desktops play straight away', () => {
    userAgent.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')
    const action = firstPlay()
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks a phone to join and verify on the first Play, then never again', async () => {
    const fetchFn = stubApi()
    const auth = stubTelegramLogin()
    const action = firstPlay()
    expect(action).not.toHaveBeenCalled()

    const gate = screen.getByRole('dialog', { name: /Follow the official NAIJA TR channel to start watching/ })
    expect(gate).toHaveTextContent('Get the latest movies, series, match links and NAIJA TR news first.')
    expect(gate).toHaveTextContent('We only check that you joined our channel. We don’t post or message you.')
    expect(within(gate).getByText('Official')).toHaveClass('tg-official')
    const join = within(gate).getByRole('link', { name: /Join @naijatr on Telegram/ })
    expect(join).toHaveAttribute('href', '/go/telegram?from=gate')
    expect(join).toHaveAttribute('target', '_blank')
    expect(tracked()).toEqual(['/go/gate-shown'])

    const verify = await within(gate).findByRole('button', { name: 'I’ve joined – Verify' })
    await userEvent.click(verify)
    expect(auth).toHaveBeenCalledWith({ bot_id: 123 }, expect.any(Function))
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(fetchFn).toHaveBeenCalledWith('/api/telegram/verify', expect.objectContaining({ method: 'POST' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tracked()).toEqual(['/go/gate-shown', '/go/gate-verified'])
    expect(readGateToken()).toBe(localStorage.getItem('naijatr.gate.token'))
    expect(document.cookie).toContain('naijatr_gate=')

    const next = vi.fn()
    act(() => playAfterGate(next))
    expect(next).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks again when the visitor is not in the channel yet', async () => {
    stubApi({ verify: { status: 'not-joined' } })
    stubTelegramLogin()
    const action = firstPlay()
    await userEvent.click(await screen.findByRole('button', { name: 'I’ve joined – Verify' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t find you in the channel yet. Join, then tap Verify again.',
    )
    expect(action).not.toHaveBeenCalled()
    expect(readGateToken()).toBeNull()

    stubApi()
    await userEvent.click(screen.getByRole('button', { name: 'I’ve joined – Verify' }))
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
  })

  it('never locks anyone out when Telegram is down', async () => {
    stubApi({ verify: { status: 'unavailable' } })
    stubTelegramLogin()
    const action = firstPlay()
    await userEvent.click(await screen.findByRole('button', { name: 'I’ve joined – Verify' }))
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(readGateToken()).toBeNull()
    // Free for the rest of this visit; verified again on a later one.
    const next = vi.fn()
    act(() => playAfterGate(next))
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('lets the visitor through when Telegram’s login can’t load', async () => {
    stubApi({ config: 'fail' })
    const action = firstPlay()
    const verify = screen.getByRole('button', { name: /Connecting to Telegram|Verify/ })
    await waitFor(() => expect(verify).toBeEnabled())
    await userEvent.click(verify)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('Not now closes the gate without playing', async () => {
    stubApi()
    const action = firstPlay()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(action).not.toHaveBeenCalled()
  })

  it('re-checks silently after 30 days, and asks again if they left', async () => {
    localStorage.setItem('naijatr.gate.token', gateToken(Math.floor(Date.now() / 1000) - 31 * DAY_S))
    const fetchFn = stubApi({ recheck: { status: 'not-joined' } })
    const action = firstPlay()
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetchFn).toHaveBeenCalledWith('/api/telegram/recheck', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(readGateToken()).toBeNull())

    act(() => playAfterGate(vi.fn()))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('doesn’t re-check a recent token', () => {
    localStorage.setItem('naijatr.gate.token', gateToken(Math.floor(Date.now() / 1000) - 5 * DAY_S))
    const fetchFn = stubApi()
    expect(firstPlay()).toHaveBeenCalledTimes(1)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('shows TVs a QR code to the channel, once', async () => {
    document.documentElement.classList.add('tv-mode')
    const action = firstPlay()
    const gate = screen.getByRole('dialog')
    expect(within(gate).getByRole('img', { name: 'QR code: join @naijatr on Telegram' })).toBeInTheDocument()
    await userEvent.click(within(gate).getByRole('button', { name: /Continue/ }))
    expect(action).toHaveBeenCalledTimes(1)
    const next = vi.fn()
    act(() => playAfterGate(next))
    expect(next).toHaveBeenCalledTimes(1)
  })
})
