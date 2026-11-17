import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { installQuietZones } from '../ads/adManager'
import { resetAccount, setAccountForTests } from './account'
import { AuthRoot } from './AuthRoot'
import { resetClient } from './client'
import { RESEND_LIMIT, recordResend, resendLimitWait, RESEND_WINDOW_MS, resetResends } from './resendLimit'
import { resetSync } from './sync'

/**
 * "📩 Email sent to …" under every email the site sends: sign-up
 * confirmation, the link to finish setup, "Resend confirmation", "Resend
 * email" (registered, not confirmed) and the password reset link. Resend
 * waits 60 seconds ("Resend in 45s") and allows 3 an hour; "Wrong email?
 * Change it" goes back to the form with the email filled in.
 */

let emailStatus: Record<string, unknown>
const otp = vi.fn(async (_args: unknown): Promise<{ data: unknown; error: unknown }> => ({ data: { user: null, session: null }, error: null }))
const reset = vi.fn(async (_email: string, _options: unknown) => ({ data: {}, error: null }))
const client = {
  auth: {
    signInWithOtp: otp,
    resetPasswordForEmail: reset,
    signInWithPassword: vi.fn(async () => ({ data: { user: null, session: null }, error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 } })),
    getSession: vi.fn(async () => ({ data: { session: null } })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
  },
}

let user: ReturnType<typeof userEvent.setup>

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test')
  resetClient(Promise.resolve(client as unknown as SupabaseClient))
  otp.mockClear()
  reset.mockClear()
  resetResends()
  emailStatus = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/account/email-status') throw new Error(url)
      const { email } = JSON.parse(String(init?.body)) as { email: string }
      return new Response(JSON.stringify(emailStatus[email] ?? { status: 'new' }))
    }),
  )
  setAccountForTests({ status: 'signedOut', user: null })
})

afterEach(() => {
  resetSync()
  resetAccount()
  resetClient()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const sheet = () => screen.getByRole('region', { name: 'Your NAIJA TR account' })
const NOTE = /^📩 Email sent to (.+)\. Can’t find it\? Check your Spam or Promotions folder, and tap ‘Not spam’ so future emails reach your inbox\.$/

/** The note's text, and the address in it. */
function note() {
  const text = sheet().querySelector('.email-sent__note')?.textContent ?? ''
  return { text, email: NOTE.exec(text)?.[1] ?? null }
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))

function open(path: string) {
  window.history.replaceState(null, '', path)
  return render(<AuthRoot />)
}

describe('the "Email sent" note', () => {
  it('sign-up confirmation: the note, Resend after 60 s, and Wrong email? Change it', async () => {
    open('/signup')
    await user.type(within(sheet()).getByLabelText('Email'), 'new.person@example.com')
    await user.click(within(sheet()).getByRole('button', { name: 'Create free account' }))
    expect(await within(sheet()).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
    // Under the success message.
    expect(within(sheet()).getByRole('status')).toHaveTextContent('Open the link we sent on this device to finish.')
    expect(note()).toEqual({ text: expect.stringMatching(NOTE), email: 'new.person@example.com' })
    expect(otp).toHaveBeenCalledTimes(1)

    // 60 seconds before it can be sent again, counting down.
    expect(within(sheet()).getByRole('button', { name: 'Resend in 60s' })).toBeDisabled()
    await wait(15_000)
    expect(within(sheet()).getByRole('button', { name: 'Resend in 45s' })).toBeDisabled()
    await wait(46_000)
    const resend = within(sheet()).getByRole('button', { name: 'Resend email' })
    expect(resend).toBeEnabled()
    await user.click(resend)
    expect(await within(sheet()).findByText('Sent again. It can take a minute to arrive.')).toBeInTheDocument()
    expect(otp).toHaveBeenCalledTimes(2)
    expect(otp).toHaveBeenLastCalledWith({ email: 'new.person@example.com', options: { emailRedirectTo: 'http://localhost:3000/auth/confirm', shouldCreateUser: true } })
    expect(within(sheet()).getByRole('button', { name: /^Resend in \d+s$/ })).toBeDisabled()

    // Wrong email: back to Create account with the address filled in.
    expect(within(sheet()).getByText(/Wrong email\?/)).toBeInTheDocument()
    await user.click(within(sheet()).getByRole('button', { name: 'Change it' }))
    expect(within(sheet()).getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true')
    expect(within(sheet()).getByLabelText('Email')).toHaveValue('new.person@example.com')
    expect(within(sheet()).getByRole('button', { name: /Create free account/ })).toBeInTheDocument()
  })

  it('the link to finish setup (Log in, no password yet): the note, and Change it back to Log in', async () => {
    open('/login')
    await user.type(within(sheet()).getByLabelText('Email'), 'ada@example.com')
    await user.type(within(sheet()).getByLabelText('Password'), 'anything')
    await user.click(within(sheet()).getByRole('button', { name: 'Log in' }))
    await user.click(await within(sheet()).findByRole('button', { name: 'Never set a password? Email me a link to finish setup' }))
    expect(await within(sheet()).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
    expect(note().email).toBe('ada@example.com')
    expect(within(sheet()).getByRole('button', { name: 'Resend in 60s' })).toBeDisabled()
    await user.click(within(sheet()).getByRole('button', { name: 'Change it' }))
    expect(within(sheet()).getByRole('tab', { name: 'Log in' })).toHaveAttribute('aria-selected', 'true')
    expect(within(sheet()).getByLabelText('Email')).toHaveValue('ada@example.com')
  })

  it('Resend confirmation (Log in, not confirmed yet): the note', async () => {
    client.auth.signInWithPassword.mockResolvedValueOnce({ data: { user: null, session: null }, error: { code: 'email_not_confirmed', message: 'Email not confirmed', status: 400 } })
    open('/login')
    await user.type(within(sheet()).getByLabelText('Email'), 'tolu@example.com')
    await user.type(within(sheet()).getByLabelText('Password'), 'Some-password-1')
    await user.click(within(sheet()).getByRole('button', { name: 'Log in' }))
    await user.click(await within(sheet()).findByRole('button', { name: 'Resend confirmation' }))
    expect(await within(sheet()).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
    expect(note().email).toBe('tolu@example.com')
    // A resend: one of the 3 this hour.
    expect(resendLimitWait()).toBe(0)
    expect(JSON.parse(localStorage.getItem('naijatr.auth.resends')!)).toHaveLength(1)
  })

  it('Resend email (registered, not confirmed): the note, to the account’s own address', async () => {
    emailStatus['chioma+new@gmail.com'] = { status: 'unconfirmed', email: 'chi.oma@gmail.com' }
    open('/signup')
    await user.type(within(sheet()).getByLabelText('Email'), 'chioma+new@gmail.com')
    await user.click(within(sheet()).getByRole('button', { name: 'Create free account' }))
    await user.click(await within(sheet()).findByRole('button', { name: 'Resend email' }))
    expect(await within(sheet()).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
    expect(note().email).toBe('chi.oma@gmail.com')
    await user.click(within(sheet()).getByRole('button', { name: 'Change it' }))
    expect(within(sheet()).getByLabelText('Email')).toHaveValue('chi.oma@gmail.com')
  })

  it('forgot password: the note under “we’ve sent a reset link”, Resend, and Change it back to the reset form', async () => {
    open('/login')
    await user.click(within(sheet()).getByRole('button', { name: 'Forgot password?' }))
    await user.type(within(sheet()).getByLabelText('Email'), 'ada@example.com')
    await user.click(within(sheet()).getByRole('button', { name: 'Send reset link' }))
    expect(await within(sheet()).findByText('If that email has an account, we’ve sent a reset link. Open it to choose a new password.')).toBeInTheDocument()
    expect(note().email).toBe('ada@example.com')
    expect(reset).toHaveBeenCalledTimes(1)
    expect(within(sheet()).getByRole('button', { name: 'Resend in 60s' })).toBeDisabled()
    await wait(61_000)
    await user.click(within(sheet()).getByRole('button', { name: 'Resend email' }))
    expect(await within(sheet()).findByText('Sent again. It can take a minute to arrive.')).toBeInTheDocument()
    expect(reset).toHaveBeenCalledTimes(2)
    expect(reset).toHaveBeenLastCalledWith('ada@example.com', { redirectTo: 'http://localhost:3000/auth/reset' })
    // Back to Log in is still there.
    expect(within(sheet()).getByRole('button', { name: 'Back to Log in' })).toBeInTheDocument()
    await user.click(within(sheet()).getByRole('button', { name: 'Change it' }))
    expect(within(sheet()).getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument()
    expect(within(sheet()).getByLabelText('Email')).toHaveValue('ada@example.com')
  })

  it('allows 3 resends an hour, even after a reload', async () => {
    open('/signup')
    await user.type(within(sheet()).getByLabelText('Email'), 'new.person@example.com')
    await user.click(within(sheet()).getByRole('button', { name: 'Create free account' }))
    await within(sheet()).findByRole('heading', { name: 'Check your email to confirm your address' })
    for (let i = 1; i <= RESEND_LIMIT; i++) {
      await wait(61_000)
      await user.click(within(sheet()).getByRole('button', { name: 'Resend email' }))
      await vi.waitFor(() => expect(otp).toHaveBeenCalledTimes(1 + i))
    }
    // The 4th: no countdown, just the limit.
    await wait(61_000)
    expect(within(sheet()).getByRole('button', { name: 'Resend email' })).toBeDisabled()
    expect(within(sheet()).getByText(/^You can resend 3 times an hour\. Try again in \d+ min\.$/)).toBeInTheDocument()
    await user.click(within(sheet()).getByRole('button', { name: 'Resend email' }))
    expect(otp).toHaveBeenCalledTimes(1 + RESEND_LIMIT)

    // A reload keeps the count; an hour after the first resend, one more is allowed.
    screen.getByRole('region', { name: 'Your NAIJA TR account' })
    expect(resendLimitWait()).toBeGreaterThan(0)
    await wait(RESEND_WINDOW_MS)
    expect(resendLimitWait()).toBe(0)
  })

  it('counts resends from any flow: the inline Resend buttons respect the limit too', async () => {
    const now = Date.now()
    for (let i = 0; i < RESEND_LIMIT; i++) recordResend(now - i * 1000)
    emailStatus['tolu@example.com'] = { status: 'unconfirmed', email: 'tolu@example.com' }
    open('/signup')
    await user.type(within(sheet()).getByLabelText('Email'), 'tolu@example.com')
    await user.click(within(sheet()).getByRole('button', { name: 'Create free account' }))
    const button = await within(sheet()).findByRole('button', { name: 'Resend email' })
    expect(button).toBeDisabled()
    expect(within(sheet()).getByText(/Try again in 60 min\./)).toBeInTheDocument()
    expect(otp).not.toHaveBeenCalled()
  })

  it('no ads: taps on Resend and Change it never reach the ad script', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    installQuietZones(host)
    const adScript = vi.fn()
    document.addEventListener('click', adScript)
    window.history.replaceState(null, '', '/signup')
    render(<AuthRoot />, { container: host })
    await user.type(within(sheet()).getByLabelText('Email'), 'new.person@example.com')
    await user.click(within(sheet()).getByRole('button', { name: 'Create free account' }))
    await within(sheet()).findByRole('heading', { name: 'Check your email to confirm your address' })
    adScript.mockClear()
    await wait(61_000)
    await user.click(within(sheet()).getByRole('button', { name: 'Resend email' }))
    await within(sheet()).findByText('Sent again. It can take a minute to arrive.')
    await user.click(within(sheet()).getByRole('button', { name: 'Change it' }))
    expect(adScript).not.toHaveBeenCalled()
    document.removeEventListener('click', adScript)
    host.remove()
  })
})
