import { useEffect, useState } from 'react'
import { Bookmark, Download, KeyRound, LogOut, RefreshCw, Trash2 } from 'lucide-react'
import { TitleGrid } from '../components/TitleGrid'
import { AdFreeCard } from '../referral/Invite'
import type { MediaItem } from '../types/media'
import { savedItem, useWatchLater } from '../utils/watchLater'
import { deleteAccount, downloadMyData, openSignIn, setPassword, signOut, useAccount } from './account'
import { PasswordForm } from './authParts'
import { AccountIdentity } from './PremiumAvatar'
import { goHome } from './pages'
import { snooze } from './reminders'
import { refreshSync, useSyncState } from './sync'
import './account.css'

/** /my-list: every saved title. */
export function MyListPage({ onSelect }: { onSelect: (item: MediaItem) => void }) {
  const entries = useWatchLater()
  const { status } = useAccount()
  return (
    <section className="account-page" aria-labelledby="my-list-title" data-ad-trigger="list">
      <h1 id="my-list-title" className="account-page__title">
        My List
      </h1>
      <p className="account-page__lead">
        {status === 'signedIn'
          ? 'Saved to your account: the same list on all your devices.'
          : 'Saved on this device.'}{' '}
        {status === 'signedOut' && (
          <button type="button" className="account-page__link" onClick={() => openSignIn()}>
            Sign in to sync it
          </button>
        )}
      </p>
      {entries.length === 0 ? (
        <p className="account-page__empty">
          <Bookmark aria-hidden="true" /> Nothing saved yet. Tap <strong>＋ My List</strong> on any movie or series.
        </p>
      ) : (
        <TitleGrid items={entries.map(savedItem)} onSelect={onSelect} />
      )}
    </section>
  )
}

const syncLabels = { idle: 'Up to date', syncing: 'Syncing…', offline: 'Offline: saved here, will sync later', error: 'Couldn’t sync: will try again' }

/** /account: who's signed in, sync, ad-free, your data. */
export function AccountPage() {
  const { status, user } = useAccount()
  const sync = useSyncState()
  const [busy, setBusy] = useState<'download' | 'delete' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  if (status !== 'signedIn' || !user) {
    return (
      <section className="account-page" aria-labelledby="account-title" data-quiet-ads="">
        <h1 id="account-title" className="account-page__title">
          Account
        </h1>
        {status === 'checking' ? (
          <p className="account-page__lead" role="status">
            Signing you in…
          </p>
        ) : (
          <>
            <p className="account-page__lead">
              Signing in is optional. It keeps your Continue Watching, My List and recommendations in sync on all your
              devices.
            </p>
            <button type="button" className="account-page__primary" onClick={() => openSignIn()}>
              Sign in
            </button>
          </>
        )}
      </section>
    )
  }

  const download = async () => {
    setBusy('download')
    try {
      await downloadMyData()
    } catch {
      setMessage('Couldn’t prepare your data. Please try again.')
    }
    setBusy(null)
  }

  const remove = async () => {
    setBusy('delete')
    try {
      const { loginDeleted } = await deleteAccount()
      setMessage(
        loginDeleted
          ? 'Your account and everything synced to it have been deleted.'
          : 'Everything synced to your account has been deleted. Your sign-in email will be removed by the NAIJA TR team.',
      )
    } catch {
      setMessage('Couldn’t delete your account. Please try again.')
    }
    setBusy(null)
    setConfirming(false)
  }

  return (
    <section className="account-page" aria-labelledby="account-title" data-quiet-ads="">
      <h1 id="account-title" className="account-page__title">
        Account
      </h1>
      {message && (
        <p className="account-page__note" role="status">
          {message}
        </p>
      )}
      <div className="account-card">
        <h2 className="account-card__title">Signed in</h2>
        <AccountIdentity email={user.email} />
        <p className="account-card__muted">
          Sync: {syncLabels[sync.status]}
          {sync.lastSyncedAt && sync.status === 'idle' ? ` · ${new Date(sync.lastSyncedAt).toLocaleTimeString()}` : ''}
        </p>
        <div className="account-card__actions">
          <button type="button" className="account-page__ghost" onClick={() => void refreshSync()}>
            <RefreshCw aria-hidden="true" /> Sync now
          </button>
          <button type="button" className="account-page__ghost" onClick={() => void signOut()}>
            <LogOut aria-hidden="true" /> Sign out
          </button>
        </div>
      </div>

      <ChangePassword hasPassword={user.passwordSet} />

      <AdFreeCard />

      <div className="account-card">
        <h2 className="account-card__title">Your data</h2>
        <p className="account-card__muted">
          A copy of everything we keep for your account, as a JSON file. See{' '}
          <a href="/privacy" className="account-page__link">
            Privacy
          </a>
          .
        </p>
        <div className="account-card__actions">
          <button type="button" className="account-page__ghost" onClick={() => void download()} disabled={busy !== null}>
            <Download aria-hidden="true" /> {busy === 'download' ? 'Preparing…' : 'Download my data'}
          </button>
        </div>
      </div>

      <div className="account-card account-card--danger">
        <h2 className="account-card__title">Delete my account</h2>
        <p className="account-card__muted">
          Deletes your synced Continue Watching, My List, recommendations, invites and ad-free reward. This device keeps its own
          copy until you clear it.
        </p>
        {confirming ? (
          <div className="account-card__actions">
            <button type="button" className="account-page__danger" onClick={() => void remove()} disabled={busy !== null}>
              <Trash2 aria-hidden="true" /> {busy === 'delete' ? 'Deleting…' : 'Yes, delete my account'}
            </button>
            <button type="button" className="account-page__ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="account-card__actions">
            <button type="button" className="account-page__ghost" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden="true" /> Delete my account
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

/** /privacy */
export function PrivacyPage() {
  return (
    <article className="account-page account-page--text" aria-labelledby="privacy-title" data-quiet-ads="">
      <h1 id="privacy-title" className="account-page__title">
        Privacy
      </h1>
      <p className="account-page__lead">Short version: an account is optional, we keep only what’s needed to sync, and we never sell your data.</p>

      <h2>Without an account</h2>
      <p>
        Your Continue Watching, My List and recommendations are stored only in your browser on this device
        (localStorage). We count visits and plays anonymously (Vercel Analytics and our live viewer counter) to keep the
        site running. Ads on the site are served by Monetag, who may use cookies.
      </p>

      <h2>With an account</h2>
      <p>If you sign in with your email, we store, so it can follow you to your other devices:</p>
      <ul>
        <li>your email address (to send your login links);</li>
        <li>Continue Watching: which movies and episodes you watch and how far in you are;</li>
        <li>My List: the titles you save;</li>
        <li>your taste profile: genres and kinds of titles you like, used to personalise the home page;</li>
        <li>if you link Telegram: your Telegram id, username and invite code, so contest and referral data stay connected.</li>
      </ul>
      <p>
        This is kept with Supabase (our database provider) and is only readable by you when signed in. We don’t sell or
        share it, and we don’t use it for advertising.
      </p>

      <h2>Your choices</h2>
      <p>
        On your <a href="/account">Account</a> page you can download a copy of your data or delete your account at any
        time. Signing out stops syncing; this device keeps its own copy.
      </p>

      <h2>Contact</h2>
      <p>
        Questions? Message us on Telegram at{' '}
        <a href="https://t.me/naijatr" target="_blank" rel="noopener noreferrer">
          t.me/naijatr
        </a>
        .
      </p>
    </article>
  )
}

/** Account page: change the password (or set one, for an account made by email link). */
function ChangePassword({ hasPassword }: { hasPassword: boolean }) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  return (
    <div className="account-card">
      <h2 className="account-card__title">{hasPassword ? 'Change password' : 'Set a password'}</h2>
      {done ? (
        <p className="account-card__value" role="status">
          Password updated ✅
        </p>
      ) : open ? (
        <PasswordForm
          label="New password"
          submitLabel="Save password"
          onSubmit={async (password) => {
            const result = await setPassword(password)
            if (result.ok) setDone(true)
            return result.ok ? null : result.message
          }}
        />
      ) : (
        <>
          <p className="account-card__muted">
            {hasPassword ? 'Choose a new password for logging in on your devices.' : 'Set a password to log in on your other devices.'}
          </p>
          <div className="account-card__actions">
            <button type="button" className="account-page__ghost" onClick={() => setOpen(true)}>
              <KeyRound aria-hidden="true" /> {hasPassword ? 'Change password' : 'Set a password'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * /auth/confirm: where the "confirm your address" email lands. They're signed
 * in; now they choose a password, or skip it for now (a reminder comes back
 * at most once a week). Their device's data is merged in by sync meanwhile.
 */
export function AuthConfirmPage() {
  const { status, user } = useAccount()
  const [done, setDone] = useState(false)
  return (
    <section className="account-page account-page--narrow" aria-labelledby="confirm-title">
      {status === 'checking' ? (
        <>
          <h1 id="confirm-title" className="account-page__title">
            Signing you in…
          </h1>
          <p className="account-page__lead" role="status">
            One moment.
          </p>
        </>
      ) : status !== 'signedIn' || !user ? (
        <>
          <h1 id="confirm-title" className="account-page__title">
            That link has expired
          </h1>
          <p className="account-page__lead">Links work once, for a limited time. Ask for a new one, or log in if you already have a password.</p>
          <button type="button" className="account-page__primary" onClick={() => openSignIn('create')}>
            Send a new link
          </button>
        </>
      ) : done || user.passwordSet ? (
        <>
          <h1 id="confirm-title" className="account-page__title">
            You’re all set ✅
          </h1>
          <p className="account-page__lead">
            Signed in as <strong>{user.email}</strong>. Your Continue Watching and My List now sync across your devices.
          </p>
          <button type="button" className="account-page__primary" onClick={goHome}>
            Start watching
          </button>
        </>
      ) : (
        <>
          <h1 id="confirm-title" className="account-page__title">
            Create your password
          </h1>
          <p className="account-page__lead">
            Email confirmed: you’re signed in as <strong>{user.email}</strong>. Choose a password to log in on your other devices.
          </p>
          <PasswordForm
            submitLabel="Save password"
            onSubmit={async (password) => {
              const result = await setPassword(password)
              if (result.ok) setDone(true)
              return result.ok ? null : result.message
            }}
          />
          <button
            type="button"
            className="account-page__skip"
            onClick={() => {
              snooze('password')
              goHome()
            }}
          >
            Skip for now
          </button>
        </>
      )}
    </section>
  )
}

/** After "Password updated", the home page follows by itself. */
const RESET_HOME_AFTER_MS = 2000

/** /auth/reset: where the reset email lands, signed in by the link: choose a new password. */
export function AuthResetPage() {
  const { status } = useAccount()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(goHome, RESET_HOME_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [done])
  return (
    <section className="account-page account-page--narrow" aria-labelledby="reset-title">
      {done ? (
        <>
          <h1 id="reset-title" className="account-page__title">
            Password updated
          </h1>
          <p className="account-page__lead" role="status">
            You’re signed in. Taking you to the home page…
          </p>
        </>
      ) : status === 'checking' ? (
        <h1 id="reset-title" className="account-page__title">
          One moment…
        </h1>
      ) : status !== 'signedIn' ? (
        <>
          <h1 id="reset-title" className="account-page__title">
            That reset link has expired
          </h1>
          <p className="account-page__lead">Reset links work once, for a limited time. Ask for a new one.</p>
          <button type="button" className="account-page__primary" onClick={() => openSignIn('login')}>
            Log in or reset again
          </button>
        </>
      ) : (
        <>
          <h1 id="reset-title" className="account-page__title">
            Choose a new password
          </h1>
          <PasswordForm
            label="New password"
            submitLabel="Update password"
            onSubmit={async (password) => {
              const result = await setPassword(password)
              if (result.ok) setDone(true)
              return result.ok ? null : result.message
            }}
          />
        </>
      )}
    </section>
  )
}
