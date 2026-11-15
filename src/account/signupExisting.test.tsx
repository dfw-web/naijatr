import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isAlreadyRegistered, openSignIn, resendConfirmation, resetAccount, setAccountForTests } from './account'
import { resetClient } from './client'
import { SignInHost } from './SignInSheet'
import { resetSync } from './sync'

/** What /api/account/email-status answers for each address typed (after Gmail normalizing). */
let serverAnswers: Record<string, unknown>
let statusCalls: string[]

const otp = vi.fn(async (_args: unknown): Promise<{ data: unknown; error: unknown }> => ({ data: { user: null, session: null }, error: null }))
const client = {
  auth: {
    signInWithOtp: otp,
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: { user: null, session: null }, error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 } })),
    getSession: vi.fn(async () => ({ data: { session: null } })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
  },
}

const gmail = (email: string) => {
  const [local, domain] = email.trim().toLowerCase().split('@')
  return domain === 'gmail.com' || domain === 'googlemail.com' ? `${local.split('+')[0].replace(/\./g, '')}@gmail.com` : `${local}@${domain}`
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test')
  resetClient(Promise.resolve(client as unknown as SupabaseClient))
  otp.mockClear()
  serverAnswers = {}
  statusCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/account/email-status') throw new Error(url)
      const { email } = JSON.parse(String(init?.body)) as { email: string }
      statusCalls.push(email)
      const answer = serverAnswers[gmail(email)]
      if (answer === 'down') return new Response('{"error":"not-configured"}', { status: 503 })
      return new Response(JSON.stringify(answer ?? { status: 'new' }))
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
})

const sheet = () => screen.getByRole('dialog', { name: 'Your NAIJA TR account' })

async function signUpWith(email: string) {
  render(<SignInHost />)
  act(() => openSignIn('create'))
  await userEvent.type(within(sheet()).getByLabelText('Email'), email)
  await userEvent.click(within(sheet()).getByRole('button', { name: 'Create free account' }))
}

describe('Create account with an email that already has an account', () => {
  it('a new email: the confirmation link is sent', async () => {
    await signUpWith('new.person@example.com')
    expect(await within(sheet()).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
    expect(statusCalls).toEqual(['new.person@example.com'])
    expect(otp).toHaveBeenCalledTimes(1)
    expect(otp).toHaveBeenCalledWith({
      email: 'new.person@example.com',
      options: { emailRedirectTo: 'http://localhost:3000/auth/confirm', shouldCreateUser: true },
    })
  })

  it('an existing confirmed email: says so under the field, sends nothing, and Log in fills in the email', async () => {
    serverAnswers['ada@example.com'] = { status: 'confirmed', email: 'ada@example.com' }
    await signUpWith('ada@example.com')
    const notice = await within(sheet()).findByText('This email already has an account. Tap Log in to sign in with your password.')
    // Under the email field (described by it), not a popup.
    const field = within(sheet()).getByLabelText('Email')
    expect(field).toHaveAttribute('aria-describedby', notice.parentElement!.id)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(otp).not.toHaveBeenCalled()
    expect(within(sheet()).getByRole('button', { name: 'Forgot password?' })).toBeInTheDocument()

    await userEvent.click(within(sheet()).getByRole('button', { name: 'Log in' }))
    expect(within(sheet()).getByRole('tab', { name: 'Log in' })).toHaveAttribute('aria-selected', 'true')
    expect(within(sheet()).getByLabelText('Email')).toHaveValue('ada@example.com')
    expect(within(sheet()).getByLabelText('Password')).toBeInTheDocument()
    expect(otp).not.toHaveBeenCalled()
  })

  it('"Forgot password?" opens the reset form with the email filled in', async () => {
    serverAnswers['ada@example.com'] = { status: 'confirmed', email: 'ada@example.com' }
    await signUpWith('ada@example.com')
    await userEvent.click(await within(sheet()).findByRole('button', { name: 'Forgot password?' }))
    expect(within(sheet()).getByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument()
    expect(within(sheet()).getByLabelText('Email')).toHaveValue('ada@example.com')
    expect(otp).not.toHaveBeenCalled()
  })

  it('an existing unconfirmed email: says so, sends nothing until Resend email, which goes to that account only and waits 60 s', async () => {
    serverAnswers['tolu@example.com'] = { status: 'unconfirmed', email: 'tolu@example.com' }
    await signUpWith('tolu@example.com')
    expect(await within(sheet()).findByText('This email is registered but not confirmed yet. Check your inbox or tap Resend email.')).toBeInTheDocument()
    expect(otp).not.toHaveBeenCalled()
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Resend email' }))
    expect(await within(sheet()).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
    expect(otp).toHaveBeenCalledTimes(1)
    // Never creates an account.
    expect(otp).toHaveBeenCalledWith({ email: 'tolu@example.com', options: { emailRedirectTo: 'http://localhost:3000/auth/confirm', shouldCreateUser: false } })
    // Rate-limited: a second resend right away sends nothing.
    expect(await resendConfirmation('tolu@example.com')).toEqual({ ok: false, message: expect.stringMatching(/^Please wait \d+ seconds/) })
    expect(within(sheet()).getByRole('button', { name: /^Send it again \(\d+s\)$/ })).toBeDisabled()
    expect(otp).toHaveBeenCalledTimes(1)
  })

  it('a Gmail with dots or a +tag: caught as the same inbox, and Log in uses the account’s own address', async () => {
    serverAnswers['adaeze@gmail.com'] = { status: 'confirmed', email: 'adaeze@gmail.com' }
    await signUpWith('a.da.eze+films@gmail.com')
    expect(await within(sheet()).findByText('This email already has an account. Tap Log in to sign in with your password.')).toBeInTheDocument()
    expect(otp).not.toHaveBeenCalled()
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Log in' }))
    expect(within(sheet()).getByLabelText('Email')).toHaveValue('adaeze@gmail.com')
  })

  it('a Gmail variant of an unconfirmed account: Resend goes to the account’s own address', async () => {
    serverAnswers['chioma@gmail.com'] = { status: 'unconfirmed', email: 'chi.oma@gmail.com' }
    await signUpWith('chioma+new@gmail.com')
    await userEvent.click(await within(sheet()).findByRole('button', { name: 'Resend email' }))
    expect(otp).toHaveBeenCalledWith({ email: 'chi.oma@gmail.com', options: { emailRedirectTo: 'http://localhost:3000/auth/confirm', shouldCreateUser: false } })
  })

  it('typing a new email clears the notice', async () => {
    serverAnswers['ada@example.com'] = { status: 'confirmed', email: 'ada@example.com' }
    await signUpWith('ada@example.com')
    await within(sheet()).findByText(/already has an account/)
    await userEvent.type(within(sheet()).getByLabelText('Email'), 'x')
    expect(within(sheet()).queryByText(/already has an account/)).toBeNull()
  })

  it('if the server can’t check: Supabase’s empty identities still count as "already registered"', async () => {
    serverAnswers['ada@example.com'] = 'down'
    otp.mockResolvedValueOnce({ data: { user: { id: 'fake', identities: [] }, session: null }, error: null })
    await signUpWith('ada@example.com')
    expect(await within(sheet()).findByText('This email already has an account. Tap Log in to sign in with your password.')).toBeInTheDocument()
    expect(within(sheet()).queryByRole('heading', { name: 'Check your email to confirm your address' })).toBeNull()
  })

  it('isAlreadyRegistered: only an empty identities list', () => {
    expect(isAlreadyRegistered({ identities: [] })).toBe(true)
    expect(isAlreadyRegistered({ identities: [{ id: 'i' } as never] })).toBe(false)
    expect(isAlreadyRegistered({ identities: undefined })).toBe(false)
    expect(isAlreadyRegistered(null)).toBe(false)
  })
})
