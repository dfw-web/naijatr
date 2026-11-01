import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordTaste } from '../taste/profile'
import type { MediaItem } from '../types/media'
import { saveForLater } from '../utils/watchLater'
import { deleteAccount, initAccount, rememberTelegram, resetAccount, signOut, useAccount } from './account'
import { AccountMenu } from './AccountMenu'
import { AuthConfirmPage, AuthResetPage } from './AccountPages'
import { resetClient } from './client'
import { SignInHost } from './SignInSheet'
import { resetSync } from './sync'
import { PasswordReminderHost, SyncPromptHost } from './SyncPrompt'

const film = (id: number): MediaItem => ({
  id: `tmdb-movie-${id}`,
  tmdbId: id,
  title: `Film ${id}`,
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
})

const EMAIL = 'ada@example.com'
const PASSWORD = 'Sunny-Lagos-2026'

interface FakeUser {
  id: string
  email: string
  user_metadata: Record<string, unknown>
}

/**
 * A stand-in for Supabase: one account (ada@example.com), its session on this
 * "device", and every database query recorded (each answers "nothing").
 */
function fakeSupabase() {
  const account = { password: null as string | null, confirmed: true, user: { id: 'user-1', email: EMAIL, user_metadata: {} } as FakeUser }
  let session: { user: FakeUser; access_token: string } | null = null
  const queries: { table: string; method: string; args: unknown[] }[] = []
  const query = (table: string) => {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'limit', 'upsert', 'delete']) {
      builder[method] = (...args: unknown[]) => {
        queries.push({ table, method, args })
        return builder
      }
    }
    builder.maybeSingle = () => Promise.resolve({ data: null, error: null })
    builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null })
    return builder
  }
  const authError = (code: string, message: string, status = 400) => ({ code, message, status })
  const client = {
    auth: {
      signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
      resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
      // An email link was opened on this device: signed in.
      setSession: vi.fn(async ({ access_token }: { access_token: string }) => {
        session = { user: account.user, access_token }
        return { data: { session }, error: null }
      }),
      getSession: vi.fn(async () => ({ data: { session } })),
      signInWithPassword: vi.fn(async ({ email, password }: { email: string; password: string }) => {
        if (email !== EMAIL || !account.password || password !== account.password) {
          return { data: { user: null, session: null }, error: authError('invalid_credentials', 'Invalid login credentials') }
        }
        if (!account.confirmed) return { data: { user: null, session: null }, error: authError('email_not_confirmed', 'Email not confirmed') }
        session = { user: account.user, access_token: 'password-token' }
        return { data: { user: account.user, session }, error: null }
      }),
      updateUser: vi.fn(async ({ password, data }: { password: string; data?: Record<string, unknown> }) => {
        if (!session) return { data: { user: null }, error: authError('session_not_found', 'No session') }
        if (password === account.password) return { data: { user: null }, error: authError('same_password', 'Same password') }
        account.password = password
        account.user = { ...account.user, user_metadata: { ...account.user.user_metadata, ...data } }
        session = { ...session, user: account.user }
        return { data: { user: account.user }, error: null }
      }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
      signOut: vi.fn(async () => {
        session = null
        return { error: null }
      }),
    },
    from: vi.fn(query),
  }
  return {
    client,
    account,
    queries,
    /** Opens the site afresh on this device (as after a reload). */
    reload() {
      resetSync()
      resetAccount()
      resetClient(Promise.resolve(client as unknown as SupabaseClient))
    },
    signedInAlready() {
      session = { user: account.user, access_token: 't' }
      localStorage.setItem('naijatr.auth', '{}')
    },
  }
}

function Status() {
  const { status, user } = useAccount()
  return (
    <p data-testid="status">
      {status}
      {user ? ` ${user.email} password:${user.passwordSet}` : ''}
    </p>
  )
}

const status = () => screen.getByTestId('status')
const visit = (path: string) => window.history.replaceState(null, '', path)

let fake: ReturnType<typeof fakeSupabase>
beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test')
  fake = fakeSupabase()
  fake.reload()
})

afterEach(() => {
  resetSync()
  resetAccount()
  resetClient()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('accounts', () => {
  it('shows nothing while Supabase isn’t configured', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    initAccount()
    render(<AccountMenu />)
    expect(screen.queryByRole('button', { name: 'Sign in to sync' })).not.toBeInTheDocument()
  })

  it('goes from sign-up to confirm, password, log out, log in, forgot password and reset', async () => {
    const user = userEvent.setup()
    initAccount()
    const page = render(
      <>
        <AccountMenu />
        <SignInHost />
        <Status />
      </>,
    )
    expect(status()).toHaveTextContent('signedOut')
    // Never signed in here: the account library isn't even asked for a session.
    expect(fake.client.auth.getSession).not.toHaveBeenCalled()

    // 1. Create account: the benefits, an email, the confirmation link.
    await user.click(screen.getByRole('button', { name: 'Sign in to sync' }))
    const sheet = screen.getByRole('dialog', { name: 'Your NAIJA TR account' })
    expect(within(sheet).getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true')
    expect(within(sheet).getByText('Why create a free account?')).toBeInTheDocument()
    expect(within(sheet).getByText(/Get the new link if NAIJA TR ever moves/)).toBeInTheDocument()
    await user.type(within(sheet).getByLabelText('Email'), EMAIL)
    await user.click(within(sheet).getByRole('button', { name: 'Create free account' }))
    expect(await within(sheet).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
    expect(fake.client.auth.signInWithOtp).toHaveBeenCalledWith({
      email: EMAIL,
      options: { emailRedirectTo: 'http://localhost:3000/auth/confirm', shouldCreateUser: true },
    })
    // No second email for 60 seconds.
    expect(within(sheet).getByRole('button', { name: /Send it again \(\d+s\)/ })).toBeDisabled()
    page.unmount()

    // 2. The link opens /auth/confirm: signed in, tokens out of the address, "Create your password".
    fake.reload()
    visit('/auth/confirm#access_token=at-1&refresh_token=rt-1&token_type=bearer&type=magiclink')
    initAccount()
    expect(window.location.hash).toBe('')
    const confirm = render(
      <>
        <AuthConfirmPage />
        <Status />
      </>,
    )
    expect(await screen.findByRole('heading', { name: 'Create your password' })).toBeInTheDocument()
    expect(status()).toHaveTextContent(`signedIn ${EMAIL} password:false`)
    expect(fake.client.auth.setSession).toHaveBeenCalledWith({ access_token: 'at-1', refresh_token: 'rt-1' })
    // Their data is being merged into the account meanwhile.
    await vi.waitFor(() => expect(fake.queries.some((q) => q.table === 'continue_watching' && q.method === 'select')).toBe(true))

    await user.type(screen.getByLabelText('Password'), 'short')
    expect(screen.getByText('At least 8 characters')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters')
    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), PASSWORD)
    expect(screen.getByText('Strong')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Confirm password'), 'Sunny-Lagos-2025')
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(screen.getByRole('alert')).toHaveTextContent('don’t match')
    // Show/hide.
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    await user.clear(screen.getByLabelText('Confirm password'))
    await user.type(screen.getByLabelText('Confirm password'), PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(await screen.findByRole('heading', { name: 'You’re all set ✅' })).toBeInTheDocument()
    expect(fake.client.auth.updateUser).toHaveBeenCalledWith({ password: PASSWORD, data: { password_set: true } })
    expect(status()).toHaveTextContent('password:true')

    // 3. Log out.
    await act(() => signOut())
    expect(status()).toHaveTextContent('signedOut')
    confirm.unmount()

    // 4. Log in with the password (the Log in tab first, for someone who's had an account here).
    visit('/')
    initAccount()
    render(
      <>
        <AccountMenu />
        <SignInHost />
        <Status />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Sign in to sync' }))
    const login = screen.getByRole('dialog', { name: 'Your NAIJA TR account' })
    expect(within(login).getByRole('tab', { name: 'Log in' })).toHaveAttribute('aria-selected', 'true')
    await user.type(within(login).getByLabelText('Email'), EMAIL)
    await user.type(within(login).getByLabelText('Password'), 'wrong-password')
    await user.click(within(login).getByRole('button', { name: 'Log in' }))
    expect(await within(login).findByRole('alert')).toHaveTextContent('Wrong email or password.')
    await user.clear(within(login).getByLabelText('Password'))
    await user.type(within(login).getByLabelText('Password'), PASSWORD)
    await user.click(within(login).getByRole('button', { name: 'Log in' }))
    await vi.waitFor(() => expect(status()).toHaveTextContent(`signedIn ${EMAIL} password:true`))
    expect(fake.client.auth.signInWithPassword).toHaveBeenLastCalledWith({ email: EMAIL, password: PASSWORD })

    // 5. Forgot password (signed out again): the same answer whether or not the account exists.
    await act(() => signOut())
    await user.click(screen.getByRole('button', { name: 'Sign in to sync' }))
    const forgot = screen.getByRole('dialog', { name: 'Your NAIJA TR account' })
    await user.click(within(forgot).getByRole('button', { name: 'Forgot password?' }))
    expect(within(forgot).getByLabelText('Email')).toHaveValue('')
    await user.type(within(forgot).getByLabelText('Email'), EMAIL)
    // The confirmation email above started the 60 seconds: wait them out.
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.now() + 61_000 })
    await user.click(within(forgot).getByRole('button', { name: 'Send reset link' }))
    expect(await within(forgot).findByText('If that email has an account, we’ve sent a reset link. Open it to choose a new password.')).toBeInTheDocument()
    expect(fake.client.auth.resetPasswordForEmail).toHaveBeenCalledWith(EMAIL, { redirectTo: 'http://localhost:3000/auth/reset' })
    vi.useRealTimers()
  })

  it('resets the password from the reset link, then goes home signed in', async () => {
    const user = userEvent.setup()
    fake.account.password = 'Old-password-1'
    visit('/auth/reset#access_token=at-2&refresh_token=rt-2&type=recovery')
    initAccount()
    render(
      <>
        <AuthResetPage />
        <Status />
      </>,
    )
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('New password'), 'New-password-2026')
    await user.type(screen.getByLabelText('Confirm password'), 'New-password-2026')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByRole('heading', { name: 'Password updated' })).toBeInTheDocument()
    expect(fake.account.password).toBe('New-password-2026')
    await vi.waitFor(() => expect(window.location.pathname).toBe('/'), { timeout: 3000 })
    expect(status()).toHaveTextContent('signedIn')
  })

  it('says when an email isn’t confirmed yet, and resends the confirmation', async () => {
    const user = userEvent.setup()
    fake.account.password = PASSWORD
    fake.account.confirmed = false
    initAccount()
    render(<SignInHost />)
    const { openSignIn } = await import('./account')
    act(() => openSignIn('login'))
    const sheet = screen.getByRole('dialog', { name: 'Your NAIJA TR account' })
    await user.type(within(sheet).getByLabelText('Email'), EMAIL)
    await user.type(within(sheet).getByLabelText('Password'), PASSWORD)
    await user.click(within(sheet).getByRole('button', { name: 'Log in' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Please confirm your email first.')
    await user.click(within(sheet).getByRole('button', { name: 'Resend confirmation' }))
    expect(await within(sheet).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
    expect(fake.client.auth.signInWithOtp).toHaveBeenCalledWith({
      email: EMAIL,
      options: { emailRedirectTo: 'http://localhost:3000/auth/confirm', shouldCreateUser: true },
    })
  })

  it('offers to finish setup for an account without a password', async () => {
    const user = userEvent.setup()
    initAccount()
    render(<SignInHost />)
    const { openSignIn } = await import('./account')
    act(() => openSignIn('login'))
    const sheet = screen.getByRole('dialog', { name: 'Your NAIJA TR account' })
    await user.type(within(sheet).getByLabelText('Email'), EMAIL)
    await user.type(within(sheet).getByLabelText('Password'), 'anything-at-all')
    await user.click(within(sheet).getByRole('button', { name: 'Log in' }))
    await user.click(await within(sheet).findByRole('button', { name: 'Never set a password? Email me a link to finish setup' }))
    expect(await within(sheet).findByRole('heading', { name: 'Check your email to confirm your address' })).toBeInTheDocument()
  })

  it('lets a new user skip the password, and reminds them at most once a week', async () => {
    const user = userEvent.setup()
    visit('/auth/confirm#access_token=at-1&refresh_token=rt-1&type=magiclink')
    initAccount()
    const confirm = render(<AuthConfirmPage />)
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }))
    expect(window.location.pathname).toBe('/')
    confirm.unmount()
    // Just skipped: no reminder this week.
    const first = render(<PasswordReminderHost delayMs={0} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    first.unmount()
    // A week later: once.
    localStorage.setItem('naijatr.passwordReminder.closedAt', String(Date.now() - 8 * 24 * 60 * 60 * 1000))
    render(<PasswordReminderHost delayMs={0} />)
    const card = await screen.findByRole('dialog', { name: 'Set a password to log in on other devices' })
    await user.click(within(card).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an expired link’s error in the sheet', async () => {
    visit('/#error=access_denied&error_description=Email+link+is+invalid+or+has+expired')
    initAccount()
    render(<SignInHost />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Email link is invalid or has expired')
  })

  it('links the Telegram login to the account’s profile', async () => {
    fake.signedInAlready()
    initAccount()
    render(<Status />)
    await vi.waitFor(() => expect(status()).toHaveTextContent('signedIn'))
    rememberTelegram({ id: 4242, username: 'ada', first_name: 'Ada' }, 'ADA42')
    await vi.waitFor(() =>
      expect(fake.queries).toContainEqual({
        table: 'profiles',
        method: 'upsert',
        args: [expect.objectContaining({ user_id: 'user-1', telegram_id: 4242, telegram_username: 'ada', referral_code: 'ADA42' }), { onConflict: 'user_id' }],
      }),
    )
  })

  it('deletes the account’s rows itself when the server has no service key', async () => {
    fake.signedInAlready()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"not-configured"}', { status: 503 }))
    initAccount()
    render(<Status />)
    await vi.waitFor(() => expect(status()).toHaveTextContent('signedIn'))
    let result: { loginDeleted: boolean } | undefined
    await act(async () => {
      result = await deleteAccount()
    })
    expect(result).toEqual({ loginDeleted: false })
    const deleted = fake.queries.filter((q) => q.method === 'delete').map((q) => q.table)
    expect(deleted).toEqual(['continue_watching', 'my_list', 'taste_profile', 'profiles'])
    expect(status()).toHaveTextContent('signedOut')
    fetchSpy.mockRestore()
  })
})

describe('the sync prompt', () => {
  const watchTwo = () => {
    recordTaste(film(1), 'play')
    recordTaste(film(2), 'play')
  }

  it('explains why, for a signed-out viewer who watched 2 titles, and "Not now" holds it for 7 days', async () => {
    const user = userEvent.setup()
    initAccount()
    watchTwo()
    const { unmount } = render(<SyncPromptHost delayMs={0} />)
    const card = await screen.findByRole('dialog', { name: /Sign in to keep your progress/ })
    expect(within(card).getByText('Why create a free account?')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()
    render(<SyncPromptHost delayMs={0} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks after one title saved, and opens the sheet on Create account', async () => {
    const user = userEvent.setup()
    initAccount()
    saveForLater(film(3))
    render(
      <>
        <SyncPromptHost delayMs={0} />
        <SignInHost />
      </>,
    )
    const card = await screen.findByRole('dialog', { name: /Sign in to keep your progress/ })
    await user.click(within(card).getByRole('button', { name: 'Create free account' }))
    expect(screen.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true')
  })

  it('the sheet’s "Not now" closes it and holds the prompt for 7 days', async () => {
    const user = userEvent.setup()
    initAccount()
    watchTwo()
    render(<SignInHost />)
    const { openSignIn } = await import('./account')
    act(() => openSignIn())
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    render(<SyncPromptHost delayMs={0} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('never shows during playback, or before 2 titles', async () => {
    initAccount()
    recordTaste(film(1), 'play')
    const { unmount } = render(<SyncPromptHost delayMs={0} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()

    recordTaste(film(2), 'play')
    const frame = document.createElement('div')
    frame.className = 'player__frame'
    document.body.append(frame)
    render(<SyncPromptHost delayMs={0} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    frame.remove()
  })
})
