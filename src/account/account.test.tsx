import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordTaste } from '../taste/profile'
import type { MediaItem } from '../types/media'
import { saveForLater } from '../utils/watchLater'
import { deleteAccount, initAccount, rememberTelegram, resetAccount, useAccount } from './account'
import { AccountMenu } from './AccountMenu'
import { resetClient } from './client'
import { SignInHost } from './SignInSheet'
import { resetSync } from './sync'
import { SyncPromptHost } from './SyncPrompt'

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

/** A stand-in for the Supabase client: every query answers "nothing", and is recorded. */
function fakeClient(session: { user: { id: string; email: string }; access_token: string } | null = null) {
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
  let current = session
  const client = {
    auth: {
      signInWithOtp: vi.fn(async () => ({ error: null })),
      setSession: vi.fn(async ({ access_token }: { access_token: string }) => {
        current = { user: { id: 'user-1', email: 'ada@example.com' }, access_token }
        return { error: null }
      }),
      getSession: vi.fn(async () => ({ data: { session: current } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: vi.fn(query),
  }
  return { client, queries }
}

function useFake(fake: ReturnType<typeof fakeClient>) {
  resetClient(Promise.resolve(fake.client as unknown as SupabaseClient))
}

function Status() {
  return <p data-testid="status">{useAccount().status}</p>
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_test')
})

afterEach(() => {
  resetSync()
  resetAccount()
  resetClient()
  vi.unstubAllEnvs()
})

describe('accounts', () => {
  it('shows nothing while Supabase isn’t configured', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    initAccount()
    render(<AccountMenu />)
    expect(screen.queryByRole('button', { name: 'Sign in to sync' })).not.toBeInTheDocument()
  })

  it('is signed out without loading anything, and emails a login link from the sheet', async () => {
    const fake = fakeClient()
    useFake(fake)
    initAccount()
    render(
      <>
        <AccountMenu />
        <SignInHost />
        <Status />
      </>,
    )
    expect(screen.getByTestId('status')).toHaveTextContent('signedOut')
    // Never signed in here: the account library isn't even asked for a session.
    expect(fake.client.auth.getSession).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Sign in to sync' }))
    const sheet = screen.getByRole('dialog', { name: 'Sign in to sync' })
    await userEvent.type(within(sheet).getByLabelText('Email'), 'not-an-email')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Email me a login link' }))
    expect(within(sheet).getByRole('alert')).toHaveTextContent('valid email')
    expect(fake.client.auth.signInWithOtp).not.toHaveBeenCalled()

    await userEvent.clear(within(sheet).getByLabelText('Email'))
    await userEvent.type(within(sheet).getByLabelText('Email'), 'ada@example.com')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Email me a login link' }))
    expect(await screen.findByRole('heading', { name: 'Check your email for a login link' })).toBeInTheDocument()
    expect(fake.client.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      options: { emailRedirectTo: 'http://localhost:3000/', shouldCreateUser: true },
    })
    // Escape closes it, like the other popups.
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('signs in from the email link, takes the tokens out of the address, and syncs', async () => {
    const fake = fakeClient()
    useFake(fake)
    window.history.replaceState(null, '', '/#access_token=at-1&refresh_token=rt-1&token_type=bearer&type=magiclink')
    initAccount()
    expect(window.location.hash).toBe('')
    render(
      <>
        <AccountMenu />
        <Status />
      </>,
    )
    await vi.waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('signedIn'))
    expect(fake.client.auth.setSession).toHaveBeenCalledWith({ access_token: 'at-1', refresh_token: 'rt-1' })
    // The account's data was loaded.
    await vi.waitFor(() => expect(fake.queries.some((q) => q.table === 'continue_watching' && q.method === 'select')).toBe(true))

    await userEvent.click(screen.getByRole('button', { name: 'Account: ada@example.com' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['My List', 'Account', 'Sign out'])
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }))
    await vi.waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('signedOut'))
    expect(fake.client.auth.signOut).toHaveBeenCalled()
  })

  it('shows an expired link’s error in the sheet', async () => {
    useFake(fakeClient())
    window.history.replaceState(null, '', '/#error=access_denied&error_description=Email+link+is+invalid+or+has+expired')
    initAccount()
    render(<SignInHost />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Email link is invalid or has expired')
  })

  it('links the Telegram login to the account’s profile', async () => {
    const fake = fakeClient({ user: { id: 'user-1', email: 'ada@example.com' }, access_token: 't' })
    useFake(fake)
    localStorage.setItem('naijatr.auth', '{}')
    initAccount()
    render(<Status />)
    await vi.waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('signedIn'))
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
    const fake = fakeClient({ user: { id: 'user-1', email: 'ada@example.com' }, access_token: 't' })
    useFake(fake)
    localStorage.setItem('naijatr.auth', '{}')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"not-configured"}', { status: 503 }))
    initAccount()
    render(<Status />)
    await vi.waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('signedIn'))
    let result: { loginDeleted: boolean } | undefined
    await act(async () => {
      result = await deleteAccount()
    })
    expect(result).toEqual({ loginDeleted: false })
    const deleted = fake.queries.filter((q) => q.method === 'delete').map((q) => q.table)
    expect(deleted).toEqual(['continue_watching', 'my_list', 'taste_profile', 'profiles'])
    expect(screen.getByTestId('status')).toHaveTextContent('signedOut')
    fetchSpy.mockRestore()
  })
})

describe('the sync prompt', () => {
  const watchTwo = () => {
    recordTaste(film(1), 'play')
    recordTaste(film(2), 'play')
  }

  it('asks a signed-out viewer who watched 2 titles, once a week, and "Not now" closes it', async () => {
    initAccount()
    watchTwo()
    const { unmount } = render(<SyncPromptHost delayMs={0} />)
    const card = await screen.findByRole('dialog', { name: /Sign in to keep your progress/ })
    await userEvent.click(within(card).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()
    // Within the week: not again.
    render(<SyncPromptHost delayMs={0} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks after one title saved, and its Sign in opens the sheet', async () => {
    useFake(fakeClient())
    initAccount()
    saveForLater(film(3))
    render(
      <>
        <SyncPromptHost delayMs={0} />
        <SignInHost />
      </>,
    )
    const card = await screen.findByRole('dialog', { name: /Sign in to keep your progress/ })
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('dialog', { name: 'Sign in to sync' })).toBeInTheDocument()
  })

  it('never shows during playback, before 2 titles, or when signed in', async () => {
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
