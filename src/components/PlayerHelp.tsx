import { useEffect, useRef, useState, type RefObject } from 'react'
import { X } from 'lucide-react'
import type { ProblemKind } from '../live/playerProblems'

/**
 * Help for a stream that's slow or stuck:
 *
 * - <PlayerNotes>: two small notes under the player's buttons, never over the
 *   video: "⚡ slow to load? switch server" (dismissed for 3 days) and the
 *   audio-language note (7 days), one under the other in the same style.
 * - usePlaybackHealth + <SlowHint>: a yellow hint in a slot kept above the
 *   player (so it never moves the video or its buttons) when the player has
 *   given no ready/play/time event 12 seconds after opening, or stopped
 *   moving for 10 seconds while playing. It goes once the video plays again,
 *   has a ✕, and shows even when the ⚡ note was dismissed.
 *
 * Everything here is inside the player section, a quiet zone: no taps reach
 * an ad script.
 */

/** No sign of life from the player this long after opening: slow. */
export const SLOW_LOAD_MS = 12_000
/** Playing, but the time hasn't moved for this long: stalled. */
export const STALL_MS = 10_000

const PLAYER_EVENTS = 'embedmaster_player'
/** Events that mean the player has loaded the video (or is playing it). */
const READY_EVENTS = new Set(['ready', 'play', 'playing', 'time', 'duration', 'loadedmetadata', 'loadeddata', 'canplay', 'pause'])

/** True when `win` is `frame`'s window or one nested inside it. */
const isInside = (win: MessageEventSource | null, frame: Window | null | undefined) => {
  let w = win as Window | null
  for (let depth = 0; w && frame && depth < 4; depth++) {
    if (w === frame) return true
    if (w === w.parent) break
    w = w.parent
  }
  return false
}

export interface HealthProblem {
  kind: ProblemKind
  /** The source picked in the player's own menu, when it said. */
  source: string | null
}

/**
 * Watches one player (`runKey`: a new key for each player opened, null when
 * none) through its postMessage events. Returns the problem to show now, if
 * any, and a ✕ for it. `onProblem` runs once per kind per player (logging).
 */
export function usePlaybackHealth(
  runKey: string | null,
  frameRef: RefObject<HTMLIFrameElement | null>,
  onProblem: (problem: HealthProblem) => void,
): { problem: ProblemKind | null; dismiss: () => void } {
  // Each problem raised gets a new id, so a later stall shows again after a ✕.
  const [shown, setShown] = useState<{ runKey: string; kind: ProblemKind; id: number } | null>(null)
  const [dismissedId, setDismissedId] = useState(0)
  const onProblemRef = useRef(onProblem)
  useEffect(() => {
    onProblemRef.current = onProblem
  })

  useEffect(() => {
    if (!runKey) return
    let ready = false
    let playing = false
    let stalled = false
    let lastTime: number | null = null
    let lastMoveAt = Date.now()
    let source: string | null = null
    const reported = new Set<ProblemKind>()
    const raise = (kind: ProblemKind) => {
      setShown({ runKey, kind, id: Date.now() + Math.random() })
      if (reported.has(kind)) return
      reported.add(kind)
      onProblemRef.current({ kind, source })
    }
    const clear = () => setShown((now) => (now?.runKey === runKey ? null : now))

    const slow = window.setTimeout(() => {
      if (!ready) raise('slow')
    }, SLOW_LOAD_MS)
    const tick = window.setInterval(() => {
      // Paused, or the tab hidden (the player's messages slow down then): no stall.
      if (!playing || document.visibilityState === 'hidden') {
        lastMoveAt = Date.now()
        return
      }
      if (!stalled && Date.now() - lastMoveAt >= STALL_MS) {
        stalled = true
        raise('stall')
      }
    }, 1000)

    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown; info?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      const event = typeof data.event === 'string' ? data.event : ''
      if (event === 'serverchange' && typeof data.info === 'string') source = data.info.slice(0, 24)
      if (READY_EVENTS.has(event) && !ready) {
        ready = true
        window.clearTimeout(slow)
        clear()
      }
      if (event === 'play' || event === 'playing') {
        playing = true
        lastMoveAt = Date.now()
      }
      if (event === 'pause' || event === 'ended') playing = false
      if (event === 'time' && typeof data.info === 'number') {
        const time = data.info
        if (lastTime === null || Math.abs(time - lastTime) > 0.05) {
          // Moving: playing (smoothly again, if it was stuck).
          if (lastTime !== null) playing = true
          lastMoveAt = Date.now()
          if (stalled) {
            stalled = false
            clear()
          }
        }
        lastTime = time
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.clearTimeout(slow)
      window.clearInterval(tick)
      window.removeEventListener('message', onMessage)
    }
  }, [runKey, frameRef])

  const current = shown && shown.runKey === runKey && shown.id !== dismissedId ? shown : null
  return { problem: current?.kind ?? null, dismiss: () => current && setDismissedId(current.id) }
}

/**
 * The slot above the player: always there while a stream is open (so the
 * hint never moves the video), the hint in it only when needed. Hidden in
 * fullscreen, where it would cover or shrink the video.
 */
export function SlowHint({ problem, onDismiss }: { problem: ProblemKind | null; onDismiss: () => void }) {
  return (
    <div className="player__status" aria-live="polite">
      {problem && (
        <p className="player__slow" data-problem={problem}>
          <span>
            Taking too long? <span aria-hidden="true">👉</span> Switch server from the menu at the top-left of the player.
          </span>
          <button type="button" className="player__note-close" onClick={onDismiss} aria-label="Dismiss switch-server hint">
            <X aria-hidden="true" />
          </button>
        </p>
      )}
    </div>
  )
}

// ---- The notes under the player ----

/** Dismissing the audio note hides it this long (on this device). */
export const AUDIO_NOTE_KEY = 'naijatr.audioNoteDismissedAt'
export const AUDIO_NOTE_HIDE_MS = 7 * 24 * 60 * 60 * 1000
/** Dismissing the "slow to load?" note hides it this long. */
export const SLOW_NOTE_KEY = 'naijatr.slowNoteDismissedAt'
export const SLOW_NOTE_HIDE_MS = 3 * 24 * 60 * 60 * 1000

const hiddenFor = (key: string, ms: number) => () => {
  try {
    const at = Number(localStorage.getItem(key))
    return at > 0 && Date.now() - at < ms
  } catch {
    return false
  }
}

function Note({ storageKey, hideMs, icon, label, children }: { storageKey: string; hideMs: number; icon: string; label: string; children: React.ReactNode }) {
  // Read before the first paint, so it never pops in and moves things.
  const [hidden, setHidden] = useState(hiddenFor(storageKey, hideMs))
  if (hidden) return null
  const dismiss = () => {
    try {
      localStorage.setItem(storageKey, String(Date.now()))
    } catch {
      // This visit only.
    }
    setHidden(true)
  }
  return (
    <li className="player__hint player__note">
      <span>
        <span aria-hidden="true">{icon} </span>
        {children}
      </span>
      <button type="button" className="player__note-close" onClick={dismiss} aria-label={label}>
        <X aria-hidden="true" />
      </button>
    </li>
  )
}

/** Under the player's buttons, never over the video. */
export function PlayerNotes() {
  return (
    <ul className="player__notes">
      <Note storageKey={SLOW_NOTE_KEY} hideMs={SLOW_NOTE_HIDE_MS} icon="⚡" label="Dismiss slow-loading tip">
        Movie slow to load or not playing? Tap the server menu at the top-left of the player and switch to another server (e.g.
        MovieJoy, VidStore). Pick one that loads fast and doesn’t freeze mid-show.
      </Note>
      <Note storageKey={AUDIO_NOTE_KEY} hideMs={AUDIO_NOTE_HIDE_MS} icon="🔊" label="Dismiss audio note">
        Different sources in the player menu may have different audio languages. Tap the source menu at the top-left of the
        player to switch.
      </Note>
    </ul>
  )
}
