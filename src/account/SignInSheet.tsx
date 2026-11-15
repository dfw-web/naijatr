import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MailCheck, X } from 'lucide-react'
import { GOOGLE_LOGIN_ENABLED } from '../config/account'
import {
  createAccount,
  logIn,
  openSignIn,
  resendConfirmation,
  sendConfirmLink,
  sendPasswordReset,
  signInWithGoogle,
  useAccount,
  type SheetTab,
} from './account'
import { Benefits, PasswordInput } from './authParts'
import { useCooldownSeconds } from './authRules'
import { goBackFromAuth, pageLoad } from './pages'
import { snooze } from './reminders'
import './account.css'

/**
 * /login and /signup: "Log in" / "Create account" as their own pages, always
 * opened with a full page load (openSignIn), so no ad script is in memory
 * while someone types their email or password (src/ads/authGuard.ts). Signed
 * in: back to ?next= with a full page load.
 */
export function AuthPage({ tab }: { tab: SheetTab }) {
  const { status } = useAccount()
  if (status === 'disabled') {
    return (
      <section className="account-page account-page--narrow" aria-labelledby="sign-in-title">
        <h1 id="sign-in-title" className="account-page__title">
          Accounts are off
        </h1>
        <button type="button" className="account-page__primary" onClick={goBackFromAuth}>
          Back
        </button>
      </section>
    )
  }
  return <SignInPanel tab={tab} />
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** What the page shows besides the two tabs' forms. */
type Notice =
  | { kind: 'confirm-sent'; email: string }
  | { kind: 'reset-sent' }
  | { kind: 'forgot' }

/** Signed in here: a moment to read it, then back where they came from. */
export const BACK_AFTER_MS = 800

function SignInPanel({ tab }: { tab: SheetTab }) {
  const { status, user, linkError } = useAccount()
  const [notice, setNotice] = useState<Notice | null>(null)
  const [email, setEmail] = useState('')
  const signedIn = status === 'signedIn' && user !== null

  useEffect(() => {
    if (!signedIn) return
    const timer = window.setTimeout(goBackFromAuth, BACK_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [signedIn])

  const notNow = () => {
    snooze('sync')
    goBackFromAuth()
  }

  const switchTab = (next: SheetTab) => {
    setNotice(null)
    openSignIn(next)
  }

  let body
  if (signedIn) {
    body = (
      <>
        <h1 id="sign-in-title" className="account-sheet__title">
          You’re signed in
        </h1>
        <p className="account-sheet__text" role="status">
          As <strong>{user.email}</strong>. Taking you back…
        </p>
        <button type="button" className="account-sheet__primary" onClick={goBackFromAuth}>
          Continue
        </button>
      </>
    )
  } else if (notice?.kind === 'confirm-sent') {
    body = <ConfirmSent email={notice.email} onBack={() => setNotice(null)} />
  } else if (notice?.kind === 'reset-sent') {
    body = (
      <>
        <MailCheck className="account-sheet__icon" aria-hidden="true" />
        <h1 id="sign-in-title" className="account-sheet__title">
          Check your email
        </h1>
        <p className="account-sheet__text" role="status">
          If that email has an account, we’ve sent a reset link. Open it to choose a new password.
        </p>
        <button type="button" className="account-sheet__link" onClick={() => switchTab('login')}>
          Back to Log in
        </button>
      </>
    )
  } else if (notice?.kind === 'forgot') {
    body = <ForgotForm email={email} onEmail={setEmail} onSent={() => setNotice({ kind: 'reset-sent' })} onBack={() => setNotice(null)} />
  } else {
    body = (
      <>
        <h1 id="sign-in-title" className="account-auth__hidden">
          {tab === 'login' ? 'Log in' : 'Create account'}
        </h1>
        <div className="account-tabs" role="tablist" aria-label="Account">
          <button type="button" role="tab" id="tab-login" aria-selected={tab === 'login'} aria-controls="tab-panel" onClick={() => switchTab('login')}>
            Log in
          </button>
          <button type="button" role="tab" id="tab-create" aria-selected={tab === 'create'} aria-controls="tab-panel" onClick={() => switchTab('create')}>
            Create account
          </button>
        </div>
        <div id="tab-panel" role="tabpanel" aria-labelledby={tab === 'login' ? 'tab-login' : 'tab-create'} className="account-sheet__panel-body">
          {linkError && (
            <p className="account-sheet__error" role="alert">
              {linkError}
            </p>
          )}
          {tab === 'login' ? (
            <LogInForm
              email={email}
              onEmail={setEmail}
              onForgot={() => setNotice({ kind: 'forgot' })}
              onLinkSent={(to) => setNotice({ kind: 'confirm-sent', email: to })}
            />
          ) : (
            <CreateForm
              email={email}
              onEmail={setEmail}
              onSent={(to) => setNotice({ kind: 'confirm-sent', email: to })}
              onLogIn={(existing) => {
                setEmail(existing)
                switchTab('login')
              }}
              onForgot={(existing) => {
                setEmail(existing)
                setNotice({ kind: 'forgot' })
              }}
            />
          )}
          {GOOGLE_LOGIN_ENABLED && (
            <button type="button" className="account-sheet__secondary" onClick={() => void signInWithGoogle()}>
              Continue with Google
            </button>
          )}
        </div>
      </>
    )
  }

  return (
    <section className="account-auth" aria-labelledby="sign-in-title">
      <div className="account-sheet__panel account-auth__panel" role="region" aria-label="Your NAIJA TR account">
        <button type="button" className="account-sheet__close" aria-label="Close" onClick={goBackFromAuth}>
          <X aria-hidden="true" />
        </button>
        <img src="/icons/icon-192.png" alt="" className="account-sheet__logo" width={52} height={52} />
        {body}
        {!signedIn && (
          <button type="button" className="account-sheet__notnow" onClick={notNow}>
            Not now
          </button>
        )}
        <p className="account-sheet__fine">
          Optional: you can always browse and watch without an account. We never sell your data.{' '}
          <a
            className="account-sheet__link"
            href="/privacy"
            onClick={(event) => {
              event.preventDefault()
              pageLoad.assign('/privacy')
            }}
          >
            Privacy
          </a>
        </p>
      </div>
    </section>
  )
}

interface EmailProps {
  email: string
  onEmail: (email: string) => void
}

function EmailField({ email, onEmail, id, autoFocus = false, describedBy }: EmailProps & { id: string; autoFocus?: boolean; describedBy?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  return (
    <>
      <label className="account-sheet__label" htmlFor={id}>
        Email
      </label>
      <input
        ref={ref}
        id={id}
        className="account-sheet__input"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="you@example.com"
        value={email}
        aria-invalid={describedBy ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onEmail(event.target.value)}
      />
    </>
  )
}

/** The send button: waits 60 seconds after each email. */
function SendButton({ label, sending }: { label: string; sending: boolean }) {
  const wait = useCooldownSeconds()
  return (
    <button type="submit" className="account-sheet__primary" disabled={sending || wait > 0}>
      {sending ? 'Sending…' : wait > 0 ? `${label} (${wait}s)` : label}
    </button>
  )
}

function LogInForm({ email, onEmail, onForgot, onLinkSent }: EmailProps & { onForgot: () => void; onLinkSent: (email: string) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'wrong' | 'unconfirmed' | 'rate' | 'offline' | 'other' | 'email' | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const wait = useCooldownSeconds()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!EMAIL.test(email.trim())) return setError('email')
    if (!password) return setError('wrong')
    setBusy(true)
    setError(null)
    const result = await logIn(email, password)
    setBusy(false)
    if (!result.ok) setError(result.reason)
  }

  /** "Resend confirmation" and "Email me a link to finish setup": both land on /auth/confirm. */
  const sendLink = async () => {
    setLinkError(null)
    const result = await sendConfirmLink(email)
    if (result.ok) onLinkSent(email.trim())
    else setLinkError(result.message)
  }

  const messages = {
    email: 'Please enter a valid email address.',
    wrong: 'Wrong email or password.',
    unconfirmed: 'Please confirm your email first.',
    rate: 'Too many tries. Please wait a minute and try again.',
    offline: 'No connection. Please try again.',
    other: 'We couldn’t log you in. Please try again.',
  }

  return (
    <form className="account-sheet__form" onSubmit={submit} noValidate>
      <EmailField email={email} onEmail={onEmail} id="login-email" autoFocus />
      <label className="account-sheet__label" htmlFor="login-password">
        Password
      </label>
      <PasswordInput id="login-password" value={password} onChange={setPassword} />
      <button type="button" className="account-sheet__link account-sheet__forgot" onClick={onForgot}>
        Forgot password?
      </button>
      {error && (
        <div className="account-sheet__error" role="alert">
          <p>{messages[error]}</p>
          {error === 'unconfirmed' && (
            <button type="button" className="account-sheet__inline" onClick={() => void sendLink()} disabled={wait > 0}>
              {wait > 0 ? `Resend confirmation (${wait}s)` : 'Resend confirmation'}
            </button>
          )}
          {error === 'wrong' && EMAIL.test(email.trim()) && (
            <button type="button" className="account-sheet__inline" onClick={() => void sendLink()} disabled={wait > 0}>
              {wait > 0 ? `Never set a password? Email me a link (${wait}s)` : 'Never set a password? Email me a link to finish setup'}
            </button>
          )}
          {linkError && <p>{linkError}</p>}
        </div>
      )}
      <button type="submit" className="account-sheet__primary" disabled={busy}>
        {busy ? 'Logging in…' : 'Log in'}
      </button>
    </form>
  )
}

/** What "Create free account" found: an address that already has an account, confirmed or not. */
type Existing = { kind: 'exists' | 'unconfirmed'; email: string }

function CreateForm({
  email,
  onEmail,
  onSent,
  onLogIn,
  onForgot,
}: EmailProps & { onSent: (email: string) => void; onLogIn: (email: string) => void; onForgot: (email: string) => void }) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existing, setExisting] = useState<Existing | null>(null)
  const [resending, setResending] = useState(false)
  const wait = useCooldownSeconds()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!EMAIL.test(email.trim())) return setError('Please enter a valid email address.')
    setSending(true)
    setError(null)
    setExisting(null)
    const result = await createAccount(email)
    setSending(false)
    if (result.ok) onSent(email.trim())
    else if (result.reason === 'error') setError(result.message)
    else setExisting({ kind: result.reason, email: result.email })
  }

  const resend = async () => {
    if (!existing) return
    setResending(true)
    setError(null)
    const result = await resendConfirmation(existing.email)
    setResending(false)
    if (result.ok) onSent(existing.email)
    else setError(result.message)
  }

  const changeEmail = (next: string) => {
    setExisting(null)
    onEmail(next)
  }

  return (
    <>
      <Benefits />
      <form className="account-sheet__form" onSubmit={submit} noValidate>
        <EmailField email={email} onEmail={changeEmail} id="create-email" describedBy={existing ? 'create-email-taken' : undefined} />
        {existing?.kind === 'exists' && (
          <div id="create-email-taken" className="account-sheet__field-error" role="alert">
            <p>This email already has an account. Tap Log in to sign in with your password.</p>
            <div className="account-sheet__field-actions">
              <button type="button" className="account-sheet__inline" onClick={() => onLogIn(existing.email)}>
                Log in
              </button>
              <button type="button" className="account-sheet__link account-sheet__small" onClick={() => onForgot(existing.email)}>
                Forgot password?
              </button>
            </div>
          </div>
        )}
        {existing?.kind === 'unconfirmed' && (
          <div id="create-email-taken" className="account-sheet__field-error" role="alert">
            <p>This email is registered but not confirmed yet. Check your inbox or tap Resend email.</p>
            <div className="account-sheet__field-actions">
              <button type="button" className="account-sheet__inline" onClick={() => void resend()} disabled={resending || wait > 0}>
                {resending ? 'Sending…' : wait > 0 ? `Resend email (${wait}s)` : 'Resend email'}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="account-sheet__error" role="alert">
            {error}
          </p>
        )}
        <SendButton label="Create free account" sending={sending} />
        <p className="account-sheet__hint">We’ll email you a link to confirm your address, then you choose a password.</p>
      </form>
    </>
  )
}

function ConfirmSent({ email, onBack }: { email: string; onBack: () => void }) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wait = useCooldownSeconds()
  const resend = async () => {
    setSending(true)
    const result = await sendConfirmLink(email)
    setSending(false)
    setError(result.ok ? null : result.message)
  }
  return (
    <>
      <MailCheck className="account-sheet__icon" aria-hidden="true" />
      <h1 id="sign-in-title" className="account-sheet__title">
        Check your email to confirm your address
      </h1>
      <p className="account-sheet__text" role="status">
        We sent a link to <strong>{email}</strong>. Open it on this device to finish. It can take a minute; check Spam too.
      </p>
      {error && (
        <p className="account-sheet__error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="account-sheet__secondary" onClick={() => void resend()} disabled={sending || wait > 0}>
        {wait > 0 ? `Send it again (${wait}s)` : 'Send it again'}
      </button>
      <button type="button" className="account-sheet__link" onClick={onBack}>
        Use a different email
      </button>
    </>
  )
}

function ForgotForm({ email, onEmail, onSent, onBack }: EmailProps & { onSent: () => void; onBack: () => void }) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!EMAIL.test(email.trim())) return setError('Please enter a valid email address.')
    setSending(true)
    setError(null)
    const result = await sendPasswordReset(email)
    setSending(false)
    if (result.ok) onSent()
    else setError(result.message)
  }
  return (
    <>
      <h1 id="sign-in-title" className="account-sheet__title">
        Forgot your password?
      </h1>
      <p className="account-sheet__text">Enter your email and we’ll send you a link to choose a new one.</p>
      <form className="account-sheet__form" onSubmit={submit} noValidate>
        <EmailField email={email} onEmail={onEmail} id="forgot-email" autoFocus />
        {error && (
          <p className="account-sheet__error" role="alert">
            {error}
          </p>
        )}
        <SendButton label="Send reset link" sending={sending} />
      </form>
      <button type="button" className="account-sheet__link" onClick={onBack}>
        Back to Log in
      </button>
    </>
  )
}
