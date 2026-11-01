import { useEffect, useRef, useState } from 'react'
import { Cloud, X } from 'lucide-react'
import { isPlaybackOpen, useOverlayCount } from '../ads/adManager'
import { SYNC_PROMPT } from '../config/account'
import { useTaste } from '../taste/profile'
import { isTvMode } from '../tv/tvMode'
import { useNoticesHeld } from '../ui/noticeQueue'
import { useDismiss } from '../ui/useDismiss'
import { useWatchLater } from '../utils/watchLater'
import { openSignIn, useAccount } from './account'
import './account.css'

const SNOOZE_KEY = 'naijatr.syncPrompt.closedAt'
/** Waits this long after the page opens, and re-checks for a player this often. */
const SHOW_AFTER_MS = 4000
const RECHECK_MS = 2000

function snoozed(now = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(SNOOZE_KEY))
    return Number.isFinite(at) && at > 0 && now - at < SYNC_PROMPT.snoozeMs
  } catch {
    return true
  }
}

function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now()))
  } catch {
    // Not shown again this visit anyway.
  }
}

/**
 * "Sign in to keep your progress & My List on all your devices": a card at
 * the bottom for signed-out visitors who've watched 2+ titles or saved one.
 * At most once every 7 days (shown counts, whatever they do), never during
 * playback, on TVs, or on top of another popup or notice.
 */
export function SyncPromptHost({ delayMs = SHOW_AFTER_MS }: { delayMs?: number }) {
  const { status } = useAccount()
  const watched = useTaste().titles.filter((t) => t.plays > 0).length
  const saved = useWatchLater().length
  const [dismissed, setDismissed] = useState(snoozed)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(isPlaybackOpen)
  const held = useNoticesHeld()
  const [onScreen, setOnScreen] = useState(false)
  const others = useOverlayCount() - (onScreen ? 1 : 0)
  const due = status === 'signedOut' && !dismissed && !isTvMode() && (watched >= SYNC_PROMPT.titlesWatched || saved > 0)
  const visible = due && ready && !playing && others === 0 && !held

  useEffect(() => {
    if (!due) return
    const timer = window.setTimeout(() => setReady(true), delayMs)
    const check = window.setInterval(() => setPlaying(isPlaybackOpen()), RECHECK_MS)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(check)
    }
  }, [due, delayMs])

  useEffect(() => {
    if (visible) snooze()
  }, [visible])

  if (!visible) return null
  return <SyncPromptCard onClose={() => setDismissed(true)} onScreen={setOnScreen} />
}

function SyncPromptCard({ onClose, onScreen }: { onClose: () => void; onScreen: (on: boolean) => void }) {
  useDismiss(true, onClose)
  useEffect(() => {
    onScreen(true)
    return () => onScreen(false)
  }, [onScreen])
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className="sync-prompt" role="dialog" aria-modal="false" aria-labelledby="sync-prompt-title">
      <Cloud className="sync-prompt__icon" aria-hidden="true" />
      <p id="sync-prompt-title" className="sync-prompt__text">
        Sign in to keep your progress &amp; My List on all your devices
      </p>
      <div className="sync-prompt__actions">
        <button
          type="button"
          className="sync-prompt__primary"
          onClick={() => {
            onClose()
            openSignIn()
          }}
        >
          Sign in
        </button>
        <button type="button" className="sync-prompt__later" onClick={onClose}>
          Not now
        </button>
      </div>
      <button type="button" className="sync-prompt__close" aria-label="Close" onClick={onClose}>
        <X aria-hidden="true" />
      </button>
    </div>
  )
}
