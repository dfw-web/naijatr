import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Star, X } from 'lucide-react'
import { isTvMode } from '../tv/tvMode'
import { DAILY_MESSAGES, MAX_MESSAGE, ratingFor, sendFeedback, sendRating, sentToday, type FeedbackType, type SendOutcome } from './feedbackApi'
import './Feedback.css'

/**
 * "💬 Feedback": a small button in the bottom corner of every page (not on
 * TVs or in fullscreen), opening a form for a review, a bug, a film or series
 * request or anything else, and "Rate this" stars on a title's details. Both
 * go to /api/feedback/send (feedbackApi.ts).
 */

const TYPES: { id: FeedbackType; label: string }[] = [
  { id: 'review', label: 'Review' },
  { id: 'bug', label: 'Bug' },
  { id: 'request', label: 'Request a movie or series' },
  { id: 'other', label: 'Other' },
]

const PLACEHOLDER: Record<FeedbackType, string> = {
  review: 'What do you like, or what could be better?',
  bug: 'What went wrong, and on which page?',
  request: 'Which movie or series should we add?',
  other: 'Your message',
}

const FAILED: Record<Exclude<SendOutcome, 'sent'>, string> = {
  limit: `You can send ${DAILY_MESSAGES} messages a day. Please try again tomorrow.`,
  invalid: 'Please write a short message (links and HTML are removed).',
  failed: "Couldn't send it right now. Please try again.",
}

const subscribeFullscreen = (onChange: () => void) => {
  document.addEventListener('fullscreenchange', onChange)
  return () => document.removeEventListener('fullscreenchange', onChange)
}
const useFullscreen = () => useSyncExternalStore(subscribeFullscreen, () => Boolean(document.fullscreenElement), () => false)

function Stars({ value, onChange, label, size = 'md' }: { value: number | null; onChange: (stars: number) => void; label: string; size?: 'md' | 'lg' }) {
  return (
    <div className={`stars stars--${size}`} role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          className={`stars__star${value !== null && n <= value ? ' stars__star--on' : ''}`}
          onClick={() => onChange(n)}
        >
          <Star aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const [type, setType] = useState<FeedbackType>('review')
  const [rating, setRating] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [name, setName] = useState('')
  const [website, setWebsite] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | Exclude<SendOutcome, 'sent'>>(() =>
    sentToday() >= DAILY_MESSAGES ? 'limit' : 'idle',
  )
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    firstRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!message.trim()) return setState('invalid')
    setState('sending')
    const outcome = await sendFeedback({ type, rating, message, name, website })
    setState(outcome)
  }

  return (
    <div className="feedback" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="feedback__panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button type="button" className="feedback__close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        {state === 'sent' ? (
          <div className="feedback__thanks" role="status">
            <p className="feedback__title">Thanks! We read every message 🙏</p>
            <button ref={firstRef} type="button" className="feedback__send" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <form className="feedback__form" onSubmit={submit}>
            <h2 id={titleId} className="feedback__title">
              Send us feedback
            </h2>
            <div className="feedback__field">
              <span className="feedback__label" id={`${titleId}-type`}>
                What is it about?
              </span>
              <div className="feedback__types" role="radiogroup" aria-labelledby={`${titleId}-type`}>
                {TYPES.map((t, index) => (
                  <button
                    key={t.id}
                    ref={index === 0 ? firstRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={type === t.id}
                    className="feedback__type"
                    onClick={() => setType(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="feedback__field">
              <span className="feedback__label">Your rating (optional)</span>
              <Stars value={rating} onChange={setRating} label="Your rating" />
            </div>
            <div className="feedback__field">
              <label className="feedback__label" htmlFor={`${titleId}-message`}>
                Message
              </label>
              <textarea
                id={`${titleId}-message`}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={MAX_MESSAGE}
                rows={4}
                required
                placeholder={PLACEHOLDER[type]}
              />
              <span className="feedback__count" aria-live="polite">
                {message.length}/{MAX_MESSAGE}
              </span>
            </div>
            <label className="feedback__field">
              <span className="feedback__label">Your name or Telegram @username (optional)</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoComplete="nickname" />
            </label>
            {/* Honeypot: hidden from people, so only bots fill it in. */}
            <input
              className="feedback__trap"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
            {state !== 'idle' && state !== 'sending' && (
              <p className="feedback__error" role="alert">
                {FAILED[state]}
              </p>
            )}
            <button type="submit" className="feedback__send" disabled={state === 'sending' || state === 'limit'}>
              {state === 'sending' ? 'Sending…' : 'Send'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

/** The Feedback button and its form. Mount once per page (App, FootballRoot). */
export function FeedbackHost() {
  const [open, setOpen] = useState(false)
  const fullscreen = useFullscreen()
  if (isTvMode()) return null
  return (
    <>
      {!fullscreen && !open && (
        <button type="button" className="feedback-fab" onClick={() => setOpen(true)}>
          <span aria-hidden="true">💬</span> <span className="feedback-fab__label">Feedback</span>
        </button>
      )}
      {open && <FeedbackDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/** "Rate this" at the bottom of a title's details. */
export function RateThis({ titleKey, title }: { titleKey: string; title: string }) {
  const [stars, setStars] = useState<number | null>(() => ratingFor(titleKey))
  const [state, setState] = useState<'idle' | 'sending' | SendOutcome>(() => (ratingFor(titleKey) ? 'sent' : 'idle'))
  if (isTvMode()) return null

  const rate = async (value: number) => {
    setStars(value)
    setState('sending')
    setState(await sendRating(titleKey, title, value))
  }

  return (
    <section className="rate-this" aria-label={`Rate ${title}`}>
      <p className="rate-this__label">{state === 'sent' ? 'Thanks for rating!' : 'Rate this'}</p>
      <Stars value={stars} onChange={(value) => void rate(value)} label={`Rate ${title}`} size="lg" />
      {(state === 'failed' || state === 'limit' || state === 'invalid') && (
        <p className="rate-this__error" role="alert">
          {state === 'limit' ? "You've rated a lot today. Please try again tomorrow." : "Couldn't save your rating. Please try again."}
        </p>
      )}
    </section>
  )
}
