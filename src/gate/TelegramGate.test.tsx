import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { isPhoneOrTablet, playAfterGate, resetGate } from './gateStore'
import { TelegramGateHost } from './TelegramGate'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'

let userAgent: MockInstance
let va: ReturnType<typeof vi.fn>
const tracked = () => va.mock.calls.filter(([type]) => type === 'pageview').map(([, data]) => data.path)

function firstPlay() {
  const action = vi.fn()
  render(<TelegramGateHost />)
  act(() => playAfterGate(action))
  return action
}

/** The Join link opens a new tab, which jsdom can't: keep the click, skip the navigation. */
const noNavigation = (event: MouseEvent) => event.preventDefault()

beforeEach(() => {
  // Off for the other tests (vite.config.ts): on here.
  vi.stubEnv('VITE_TELEGRAM_GATE_ENABLED', 'true')
  userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
  va = vi.fn()
  window.va = va as unknown as typeof window.va
  document.addEventListener('click', noNavigation)
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetGate()
  userAgent.mockRestore()
  delete window.va
  document.removeEventListener('click', noNavigation)
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
  it('asks computers too', () => {
    userAgent.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')
    expect(firstPlay()).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('never forces it: Continue without joining plays, and doesn’t ask again this visit', async () => {
    const action = firstPlay()
    await userEvent.click(screen.getByRole('button', { name: 'Continue without joining' }))
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tracked()).toEqual(['/go/gate-shown', '/go/gate-skipped'])
    expect(localStorage.getItem('naijatr.gate.joined')).toBeNull()
    const next = vi.fn()
    act(() => playAfterGate(next))
    expect(next).toHaveBeenCalledTimes(1)
    // A new visit asks again.
    sessionStorage.clear()
    act(() => playAfterGate(vi.fn()))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('asks a phone once: Join opens Telegram and starts the video, with no check', async () => {
    const fetchFn = vi.fn()
    vi.stubGlobal('fetch', fetchFn)
    const action = firstPlay()
    expect(action).not.toHaveBeenCalled()

    const gate = screen.getByRole('dialog', { name: /Follow the official NAIJA TR channel before you watch/ })
    expect(gate).toHaveTextContent('It’s where we post important NAIJA TR updates: how everything works, and what to do if a movie or match gives you an error.')
    expect(gate).toHaveTextContent('What to do if a movie or match shows an error')
    expect(within(gate).getByText('Official')).toHaveClass('tg-official')
    expect(within(gate).queryByRole('button', { name: /Verify/ })).not.toBeInTheDocument()
    expect(tracked()).toEqual(['/go/gate-shown'])

    const join = within(gate).getByRole('link', { name: /Join @naijatr on Telegram/ })
    expect(join).toHaveAttribute('href', '/go/telegram?from=gate')
    expect(join).toHaveAttribute('target', '_blank')
    await userEvent.click(join)

    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tracked()).toEqual(['/go/gate-shown', '/go/gate-joined'])
    expect(fetchFn).not.toHaveBeenCalled()
    expect(localStorage.getItem('naijatr.gate.joined')).toBe('1')
    expect(document.cookie).toContain('naijatr_gate_joined=1')

    // Never again on this device.
    const next = vi.fn()
    act(() => playAfterGate(next))
    expect(next).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('remembers it in the cookie when localStorage is cleared', () => {
    document.cookie = 'naijatr_gate_joined=1; Path=/'
    expect(firstPlay()).toHaveBeenCalledTimes(1)
  })

  it('skips visitors who verified with the earlier gate', () => {
    localStorage.setItem('naijatr.gate.token', 'old-token')
    expect(firstPlay()).toHaveBeenCalledTimes(1)
  })

  it('Not now closes the gate without playing, and asks again next time', async () => {
    const action = firstPlay()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(action).not.toHaveBeenCalled()
    act(() => playAfterGate(vi.fn()))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
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
