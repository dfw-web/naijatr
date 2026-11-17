import { useState } from 'react'
import { QUIET_ADS_ATTR } from '../ads/adManager'
import type { EmailResult } from './account'
import { RESEND_LIMIT, recordResend, resendLimitWait, useResendWait } from './resendLimit'

interface EmailSentNoteProps {
  /** Where it went. */
  email: string
  /** Sends the same email again. */
  onResend: () => Promise<EmailResult>
  /** Back to the form, with this email filled in. */
  onChangeEmail: () => void
}

/**
 * Under every "we've sent you an email" message (confirm your address, the
 * link to finish setup, the password reset link): where to look for it,
 * "Resend email" (60 seconds apart, 3 an hour) and "Wrong email? Change it".
 * On the page itself, never a popup; a quiet zone, so none of its taps can
 * open an ad.
 */
export function EmailSentNote({ email, onResend, onChangeEmail }: EmailSentNoteProps) {
  const { seconds, limitMinutes } = useResendWait()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(0)

  const resend = async () => {
    if (sending || seconds > 0 || resendLimitWait() > 0) return
    setSending(true)
    setError(null)
    const result = await onResend()
    setSending(false)
    if (result.ok) {
      recordResend()
      setResent((n) => n + 1)
    } else setError(result.message)
  }

  const label = sending ? 'Sending…' : limitMinutes > 0 ? 'Resend email' : seconds > 0 ? `Resend in ${seconds}s` : 'Resend email'

  return (
    <div className="email-sent" {...{ [QUIET_ADS_ATTR]: '' }}>
      <p className="email-sent__note">
        <span aria-hidden="true">📩 </span>
        Email sent to <strong>{email}</strong>. Can’t find it? Check your Spam or Promotions folder, and tap ‘Not spam’ so future emails reach your inbox.
      </p>
      {resent > 0 && !error && (
        <p className="email-sent__status" role="status">
          Sent again. It can take a minute to arrive.
        </p>
      )}
      {error && (
        <p className="account-sheet__error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="account-sheet__secondary email-sent__resend" onClick={() => void resend()} disabled={sending || seconds > 0 || limitMinutes > 0}>
        {label}
      </button>
      {limitMinutes > 0 && (
        <p className="email-sent__limit">
          You can resend {RESEND_LIMIT} times an hour. Try again in {limitMinutes} min.
        </p>
      )}
      <p className="email-sent__change">
        Wrong email?{' '}
        <button type="button" className="account-sheet__link" onClick={onChangeEmail}>
          Change it
        </button>
      </p>
    </div>
  )
}
