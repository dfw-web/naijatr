import { useState } from 'react'
import { Bookmark, Download, LogOut, RefreshCw, Send, Trash2 } from 'lucide-react'
import { TitleGrid } from '../components/TitleGrid'
import { TelegramLogin } from '../referral/Invite'
import type { MediaItem } from '../types/media'
import { savedItem, useWatchLater } from '../utils/watchLater'
import { deleteAccount, downloadMyData, openSignIn, signOut, useAccount, useTelegramLink } from './account'
import { refreshSync, useSyncState } from './sync'
import './account.css'

/** /my-list: every saved title. */
export function MyListPage({ onSelect }: { onSelect: (item: MediaItem) => void }) {
  const entries = useWatchLater()
  const { status } = useAccount()
  return (
    <section className="account-page" aria-labelledby="my-list-title">
      <h1 id="my-list-title" className="account-page__title">
        My List
      </h1>
      <p className="account-page__lead">
        {status === 'signedIn'
          ? 'Saved to your account: the same list on all your devices.'
          : 'Saved on this device.'}{' '}
        {status === 'signedOut' && (
          <button type="button" className="account-page__link" onClick={openSignIn}>
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

/** /account: who's signed in, sync, Telegram, your data. */
export function AccountPage() {
  const { status, user } = useAccount()
  const sync = useSyncState()
  const telegram = useTelegramLink()
  const [busy, setBusy] = useState<'download' | 'delete' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  if (status !== 'signedIn' || !user) {
    return (
      <section className="account-page" aria-labelledby="account-title">
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
            <button type="button" className="account-page__primary" onClick={openSignIn}>
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
    <section className="account-page" aria-labelledby="account-title">
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
        <p className="account-card__value">{user.email}</p>
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

      <div className="account-card">
        <h2 className="account-card__title">Telegram</h2>
        {telegram ? (
          <p className="account-card__value">
            <Send aria-hidden="true" /> Linked{telegram.username ? ` as @${telegram.username}` : telegram.name ? ` as ${telegram.name}` : ''}
            {telegram.code ? ` · invite code ${telegram.code}` : ''}
          </p>
        ) : (
          <>
            <p className="account-card__muted">
              Link your Telegram so your contest entries and invites stay with your account.
            </p>
            <TelegramLogin />
          </>
        )}
      </div>

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
          Deletes your synced Continue Watching, My List, recommendations and Telegram link. This device keeps its own
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
    <article className="account-page account-page--text" aria-labelledby="privacy-title">
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
