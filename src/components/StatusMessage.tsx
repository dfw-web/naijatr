import type { LucideIcon } from 'lucide-react'
import './StatusMessage.css'

interface StatusMessageProps {
  icon: LucideIcon
  title: string
  message?: string
  tone?: 'neutral' | 'error'
  action?: { label: string; onClick: () => void }
  compact?: boolean
}

/** Shared empty / error state with an optional recovery action. */
export function StatusMessage({
  icon: Icon,
  title,
  message,
  tone = 'neutral',
  action,
  compact = false,
}: StatusMessageProps) {
  return (
    <div
      className={`status status--${tone} ${compact ? 'status--compact' : ''}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon className="status__icon" aria-hidden="true" />
      <p className="status__title">{title}</p>
      {message && <p className="status__message">{message}</p>}
      {action && (
        <button type="button" className="btn btn--ghost status__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
