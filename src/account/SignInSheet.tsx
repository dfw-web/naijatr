import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MailCheck, X } from 'lucide-react'
import { GOOGLE_LOGIN_ENABLED } from '../config/account'
import { useDismiss } from '../ui/useDismiss'
import {
  closeSignIn,
  logIn,
  openSignIn,
  sendConfirmLink,
  sendPasswordReset,
  signInWithGoogle,
  useAccount,
  useSignInSheet,
  type SheetTab,
} from './account'
import { Benefits, PasswordInput } from './authParts'
import { useCooldownSeconds } from './authRules'
import { goToPage } from './pages'
import { snooze } from './reminders'
import './account.css'
import { useAdOverlay } from '../ads/adManager'

/** The sign-in sheet ("Log in" / "Create account"), opened from the header, the prompt or the Account page. Mount once (App). */
export function SignInHost() {
  const tab = useSignInSheet()
  const { status } = useAccount()
  if (!tab || status === 'disabled') return null
  return <SignInSheet tab={tab} />
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** What the sheet shows besides the two tabs' forms. */
type Notice =
  | { kind: 'confirm-sent'; email: string }
  | { kind: 'reset-sent' }
  | { kind: 'forgot' }

function SignInSheet({ tab }: { tab: SheetTab }) {
  const { status, user, linkError } = useAccount()
  const [notice, setNotice] = useState<Notice | null>(null)
  const [email, setEmail] = useState('')
  useDismiss(true, closeSignIn)
  // No ads while signing up or in (see src/ads/adManager.ts).
  useAdOverlay(true)

  const notNow = () => {
    snooze('sync')
    closeSignIn()
  }

  const switchTab = (next: SheetTab) => {
    setNotice(null)
    openSignIn(next)
  }

  let body
  if (status === 'signedIn' && user) {
    body = (
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
    )
  } else if (notice?.kind === 'confirm-sent') {
    body = <ConfirmSent email={notice.email} onBack={() => setNotice(null)} />
  } else if (notice?.kind === 'reset-sent') {
    body = (
      <>
        <MailCheck className="account-sheet__icon" aria-hidden="true" />
        <h2 id="sign-in-title" className="account-sheet__title">
          Check your email
        </h2>
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
            <CreateForm email={email} onEmail={setEmail} onSent={(to) => setNotice({ kind: 'confirm-sent', email: to })} />
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
    <div className="account-sheet" role="presentation" data-quiet-ads="" onClick={(event) => event.target === event.currentTarget && closeSignIn()}>
      <div className="account-sheet__panel" role="dialog" aria-modal="true" aria-label="Your NAIJA TR account" data-quiet-ads="">
        <button type="button" className="account-sheet__close" aria-label="Close" onClick={closeSignIn}>
          <X aria-hidden="true" />
        </button>
        <img src="/icons/icon-192.png" alt="" className="account-sheet__logo" width={52} height={52} />
        {body}
        {status !== 'signedIn' && (
          <button type="button" className="account-sheet__notnow" onClick={notNow}>
            Not now
          </button>
        )}
        <p className="account-sheet__fine">
          Optional: you can always browse and watch without an account. We never sell your data.{' '}
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

interface EmailProps {
  email: string
  onEmail: (email: string) => void
}

function EmailField({ email, onEmail, id, autoFocus = false }: EmailProps & { id: string; autoFocus?: boolean }) {
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

function CreateForm({ email, onEmail, onSent }: EmailProps & { onSent: (email: string) => void }) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!EMAIL.test(email.trim())) return setError('Please enter a valid email address.')
    setSending(true)
    setError(null)
    const result = await sendConfirmLink(email)
    setSending(false)
    if (result.ok) onSent(email.trim())
    else setError(result.message)
  }
  return (
    <>
      <Benefits />
      <form className="account-sheet__form" onSubmit={submit} noValidate>
        <EmailField email={email} onEmail={onEmail} id="create-email" />
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
      <h2 id="sign-in-title" className="account-sheet__title">
        Check your email to confirm your address
      </h2>
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
      <h2 id="sign-in-title" className="account-sheet__title">
        Forgot your password?
      </h2>
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
