/**
 * Sends feedback and "Rate this" ratings to /api/feedback/send
 * (server/feedback/handlers.ts). The device id is the live counter's random
 * id, so the server can hold each device to 3 messages a day; the same limit
 * is counted here too, so the form can say so before sending.
 */
import { sessionId } from '../live/heartbeat'

export type FeedbackType = 'review' | 'bug' | 'request' | 'other'

export const DAILY_MESSAGES = 3
export const MAX_MESSAGE = 500
const SENT_KEY = 'naijatr.feedback.sent'
const RATED_KEY = 'naijatr.feedback.rated'

const today = () => new Date().toISOString().slice(0, 10)

/** Messages this device has sent today. */
export function sentToday(): number {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SENT_KEY) ?? 'null') as { day?: string; count?: number } | null
    return saved?.day === today() ? (saved.count ?? 0) : 0
  } catch {
    return 0
  }
}

function countSent() {
  try {
    window.localStorage.setItem(SENT_KEY, JSON.stringify({ day: today(), count: sentToday() + 1 }))
  } catch {
    // The server still keeps count.
  }
}

/** The stars this device gave a title, if any. */
export function ratingFor(titleKey: string): number | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RATED_KEY) ?? '{}') as Record<string, number>
    return saved[titleKey] ?? null
  } catch {
    return null
  }
}

function rememberRating(titleKey: string, stars: number) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RATED_KEY) ?? '{}') as Record<string, number>
    saved[titleKey] = stars
    // Keep the most recent 200.
    const entries = Object.entries(saved).slice(-200)
    window.localStorage.setItem(RATED_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Asked again next time.
  }
}

const isMobile = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/** The page as a path, including the app's #/ routes. */
const currentPage = () => `${window.location.pathname}${window.location.hash}`.slice(0, 200)

export type SendOutcome = 'sent' | 'limit' | 'invalid' | 'failed'

async function post(body: Record<string, unknown>): Promise<SendOutcome> {
  try {
    const response = await fetch('/api/feedback/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, device: sessionId(), mobile: isMobile(), page: currentPage() }),
    })
    if (response.ok) return 'sent'
    if (response.status === 429) return 'limit'
    if (response.status === 400) return 'invalid'
    return 'failed'
  } catch {
    return 'failed'
  }
}

export interface FeedbackForm {
  type: FeedbackType
  rating: number | null
  message: string
  name: string
  /** The hidden honeypot field; people leave it empty. */
  website: string
}

export async function sendFeedback(form: FeedbackForm): Promise<SendOutcome> {
  if (sentToday() >= DAILY_MESSAGES) return 'limit'
  const outcome = await post({ ...form })
  if (outcome === 'sent') countSent()
  return outcome
}

/** "Rate this" on a title's details. */
export async function sendRating(titleKey: string, title: string, stars: number): Promise<SendOutcome> {
  const outcome = await post({ type: 'rating', rating: stars, title })
  if (outcome === 'sent') rememberRating(titleKey, stars)
  return outcome
}
