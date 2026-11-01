import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { isPlaybackOpen, useOverlayCount } from '../ads/adManager'
import { fillMonth, greetingFor, GREETINGS, type Greeting } from '../config/greetings'
import { TELEGRAM_CHANNEL_URL } from '../config/telegram'
import { isTvMode } from '../tv/tvMode'
import { useNoticesHeld } from '../ui/noticeQueue'
import { useDismiss } from '../ui/useDismiss'
import './Greeting.css'

const seenKey = (greeting: Greeting) => `naijatr.greeting.${greeting.id}`

function seen(greeting: Greeting): boolean {
  try {
    return localStorage.getItem(seenKey(greeting)) === '1'
  } catch {
    return true
  }
}

function markSeen(greeting: Greeting) {
  try {
    localStorage.setItem(seenKey(greeting), '1')
  } catch {
    // Storage blocked: seen() already says yes.
  }
}

/** Lets the page settle (and the contest popup open) first. */
export const GREETING_DELAY_MS = 2500
/** How often to look again while waiting for the player to close. */
const RECHECK_MS = 1000

interface GreetingHostProps {
  greetings?: Greeting[]
  now?: () => number
  delayMs?: number
}

/**
 * The seasonal greeting (src/config/greetings.ts): a card at the bottom of
 * the page, once per device, on its dates. It waits while another popup, the
 * "Ads are back" card or a player is open, and closes with its buttons, a
 * tap anywhere else, Escape or Back. Not on TV.
 */
export function GreetingHost({ greetings = GREETINGS, now = Date.now, delayMs = GREETING_DELAY_MS }: GreetingHostProps) {
  const [greeting] = useState(() => {
    const today = greetingFor(now(), greetings)
    return today && !seen(today) && !isTvMode() ? today : null
  })
  const [closed, setClosed] = useState(false)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(isPlaybackOpen)
  const held = useNoticesHeld()
  // Open popups, not counting this card itself (it registers as one while on screen).
  const [onScreen, setOnScreen] = useState(false)
  const others = useOverlayCount() - (onScreen ? 1 : 0)
  const due = greeting !== null && !closed
  const visible = due && ready && others === 0 && !held && !playing

  useEffect(() => {
    if (!due) return
    const timer = window.setTimeout(() => setReady(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [due, delayMs])

  // The player is in the page, not a popup: look for it while waiting or showing.
  useEffect(() => {
    if (!due) return
    const timer = window.setInterval(() => setPlaying(isPlaybackOpen()), RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [due])

  useEffect(() => {
    if (visible && greeting) markSeen(greeting)
  }, [visible, greeting])

  if (!visible || !greeting) return null
  return <GreetingCard greeting={greeting} onClose={() => setClosed(true)} onScreen={setOnScreen} />
}

const SPARKLES = 14

interface GreetingCardProps {
  greeting: Greeting
  onClose: () => void
  onScreen: (on: boolean) => void
}

function GreetingCard({ greeting, onClose, onScreen }: GreetingCardProps) {
  useDismiss(true, onClose)
  // In the same commit as useDismiss's popup registration, so the host's count stays right.
  useEffect(() => {
    onScreen(true)
    return () => onScreen(false)
  }, [onScreen])
  const cardRef = useRef<HTMLDivElement>(null)

  // A tap anywhere else closes it (and still does what it was for).
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [onClose])

  return (
    <div ref={cardRef} className="greeting" role="dialog" aria-modal="false" aria-labelledby="greeting-title">
      <div className="greeting__sparkles" aria-hidden="true">
        {Array.from({ length: SPARKLES }, (_, i) => (
          <span key={i} style={{ left: `${(i * 73) % 100}%`, animationDelay: `${(i % 7) * 0.35}s` }} />
        ))}
      </div>
      <button type="button" className="greeting__close" aria-label="Close" onClick={onClose}>
        <X aria-hidden="true" />
      </button>
      <img src="/favicon.svg" alt="" className="greeting__logo" />
      <h2 id="greeting-title" className="greeting__title">
        {fillMonth(greeting.title, greeting)}
      </h2>
      {greeting.message.map((line) => (
        <p key={line} className="greeting__text">
          {fillMonth(line, greeting)}
        </p>
      ))}
      <p className="greeting__signature">{greeting.signature}</p>
      <button type="button" className="greeting__thanks" onClick={onClose}>
        {greeting.button}
      </button>
      {greeting.telegram && (
        <a className="greeting__telegram" href={TELEGRAM_CHANNEL_URL} target="_blank" rel="noopener noreferrer">
          {greeting.telegram} {TELEGRAM_CHANNEL_URL.replace(/^https:\/\//, '')}
        </a>
      )}
    </div>
  )
}
