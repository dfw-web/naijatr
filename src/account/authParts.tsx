import { useId, useState, type FormEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { BENEFITS, MIN_PASSWORD, passwordStrength } from './authRules'

export function Benefits({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'account-benefits account-benefits--compact' : 'account-benefits'}>
      <p className="account-benefits__title">Why create a free account?</p>
      <ul className="account-benefits__list">
        {BENEFITS.map((benefit) => (
          <li key={benefit}>
            <span aria-hidden="true">✅</span> {benefit}
          </li>
        ))}
      </ul>
    </div>
  )
}

interface PasswordFormProps {
  submitLabel: string
  onSubmit: (password: string) => Promise<string | null>
  /** A label for the first field ("New password" when changing it). */
  label?: string
}

/** Password + confirm, with show/hide and a strength hint. `onSubmit` returns an error message, or null. */
export function PasswordForm({ submitLabel, onSubmit, label = 'Password' }: PasswordFormProps) {
  const id = useId()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [shown, setShown] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const strength = passwordStrength(password)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < MIN_PASSWORD) return setError(`Your password needs at least ${MIN_PASSWORD} characters.`)
    if (password !== confirm) return setError('The two passwords don’t match.')
    setSaving(true)
    setError(null)
    const failed = await onSubmit(password)
    setSaving(false)
    if (failed) setError(failed)
  }

  return (
    // data-quiet-ads: no pop-under while choosing a password (src/ads/adManager.ts).
    <form className="account-sheet__form" onSubmit={submit} noValidate data-quiet-ads="">
      <label className="account-sheet__label" htmlFor={`${id}-password`}>
        {label}
      </label>
      <div className="account-password">
        <input
          id={`${id}-password`}
          className="account-sheet__input"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby={`${id}-strength`}
        />
        <button
          type="button"
          className="account-password__toggle"
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      </div>
      <p id={`${id}-strength`} className={`account-strength account-strength--${strength.level}`}>
        {strength.label}
      </p>
      <label className="account-sheet__label" htmlFor={`${id}-confirm`}>
        Confirm password
      </label>
      <input
        id={`${id}-confirm`}
        className="account-sheet__input"
        type={shown ? 'text' : 'password'}
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
      {error && (
        <p className="account-sheet__error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="account-sheet__primary" disabled={saving}>
        {saving ? 'Saving…' : submitLabel}
      </button>
    </form>
  )
}

/** One password field with show/hide (log in). */
export function PasswordInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="account-password">
      <input
        id={id}
        className="account-sheet__input"
        type={shown ? 'text' : 'password'}
        autoComplete="current-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="account-password__toggle"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </div>
  )
}
