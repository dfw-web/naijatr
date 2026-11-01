import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MailCheck, X } from 'lucide-react'
import { GOOGLE_LOGIN_ENABLED } from '../config/account'
import { useDismiss } from '../ui/useDismiss'
import { closeSignIn, sendMagicLink, signInWithGoogle, useAccount, useSignInOpen } from './account'
import { goToPage } from './pages'
import './account.css'

/** The "Sign in" sheet, opened from the header, the sync prompt or the Account page. Mount once (App). */
export function SignInHost() {
  const open = useSignInOpen()
  const { status } = useAccount()
  if (!open || status === 'disabled') return null
  return <SignInSheet />
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function SignInSheet() {
  const { status, user, linkError } = useAccount()
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useDismiss(true, closeSignIn)
  useEffect(() => inputRef.current?.focus(), [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!EMAIL.test(email.trim())) return setError('Please enter a valid email address.')
    setSending(true)
    setError(null)
    const result = await sendMagicLink(email)
    setSending(false)
    if (result.ok) setSentTo(email.trim())
    else setError(result.message)
  }

  return (
    <div className="account-sheet" role="presentation" onClick={(event) => event.target === event.currentTarget && closeSignIn()}>
      <div className="account-sheet__panel" role="dialog" aria-modal="true" aria-labelledby="sign-in-title">
        <button type="button" className="account-sheet__close" aria-label="Close" onClick={closeSignIn}>
          <X aria-hidden="true" />
        </button>
        <img src="/icons/icon-192.png" alt="" className="account-sheet__logo" width={56} height={56} />
        {status === 'signedIn' && user ? (
          <>
            <h2 id="sign-in-title" className="account-sheet__title">
              You’re signed in
            </h2>
            <p className="account-sheet__text">
              As <strong>{user.email}</strong>. Your progress and My List now sync across your devices.
            </p>
            <button type="button" className="account-sheet__primary" onClick={closeSignIn}>
              Done
            </button>
          </>
        ) : sentTo ? (
          <>
            <MailCheck className="account-sheet__icon" aria-hidden="true" />
            <h2 id="sign-in-title" className="account-sheet__title">
              Check your email for a login link
            </h2>
            <p className="account-sheet__text" role="status">
              We sent it to <strong>{sentTo}</strong>. Open it on this device to sign in. It can take a minute; check Spam
              too.
            </p>
            <button type="button" className="account-sheet__link" onClick={() => setSentTo(null)}>
              Use a different email
            </button>
          </>
        ) : (
          <>
            <h2 id="sign-in-title" className="account-sheet__title">
              Sign in to sync
            </h2>
            <p className="account-sheet__text">
              Keep your Continue Watching, My List and recommendations on all your devices. No password: we email you a
              link. Signing in is optional.
            </p>
            {linkError && (
              <p className="account-sheet__error" role="alert">
                {linkError}
              </p>
            )}
            <form className="account-sheet__form" onSubmit={submit} noValidate>
              <label className="account-sheet__label" htmlFor="sign-in-email">
                Email
              </label>
              <input
                ref={inputRef}
                id="sign-in-email"
                className="account-sheet__input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'sign-in-error' : undefined}
              />
              {error && (
                <p id="sign-in-error" className="account-sheet__error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" className="account-sheet__primary" disabled={sending}>
                {sending ? 'Sending…' : 'Email me a login link'}
              </button>
            </form>
            {GOOGLE_LOGIN_ENABLED && (
              <button type="button" className="account-sheet__secondary" onClick={() => void signInWithGoogle()}>
                Continue with Google
              </button>
            )}
          </>
        )}
        <p className="account-sheet__fine">
          We only store what’s needed to sync, and never sell your data.{' '}
          <button
            type="button"
            className="account-sheet__link"
            onClick={() => {
              closeSignIn()
              goToPage('privacy')
            }}
          >
            Privacy
          </button>
        </p>
      </div>
    </div>
  )
}
