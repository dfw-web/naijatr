import { useEffect, useState, type ReactNode } from 'react'
import { Cloud, KeyRound, X } from 'lucide-react'
import { isPlaybackOpen, useOverlayCount } from '../ads/adManager'
import { SYNC_PROMPT } from '../config/account'
import { useTaste } from '../taste/profile'
import { isTvMode } from '../tv/tvMode'
import { useNoticesHeld } from '../ui/noticeQueue'
import { useDismiss } from '../ui/useDismiss'
import { useWatchLater } from '../utils/watchLater'
import { openSignIn, useAccount } from './account'
import { Benefits } from './authParts'
import { goToPage, pageFromPath } from './pages'
import { snooze, snoozed, type Reminder } from './reminders'
import './account.css'

/** Waits this long after the page opens, and re-checks for a player this often. */
const SHOW_AFTER_MS = 4000
const RECHECK_MS = 2000

/**
 * A reminder card at the bottom of the page, when `due`: at most once every
 * 7 days (shown counts, whatever they do), never during playback, on TVs, on
 * the sign-in pages, or on top of another popup or notice.
 */
function useReminder(reminder: Reminder, wanted: boolean, delayMs: number) {
  const [dismissed, setDismissed] = useState(() => snoozed(reminder))
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(isPlaybackOpen)
  const held = useNoticesHeld()
  const [onScreen, setOnScreen] = useState(false)
  const others = useOverlayCount() - (onScreen ? 1 : 0)
  const onAuthPage = pageFromPath(window.location.pathname)?.startsWith('auth/') ?? false
  const due = wanted && !dismissed && !isTvMode() && !onAuthPage
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
    if (visible) snooze(reminder)
  }, [visible, reminder])

  return { visible, close: () => setDismissed(true), setOnScreen }
}

/**
 * "Sign in to keep your progress & My List on all your devices", with why:
 * for signed-out visitors who've watched 2+ titles or saved one.
 */
export function SyncPromptHost({ delayMs = SHOW_AFTER_MS }: { delayMs?: number }) {
  const { status } = useAccount()
  const watched = useTaste().titles.filter((t) => t.plays > 0).length
  const saved = useWatchLater().length
  const wanted = status === 'signedOut' && (watched >= SYNC_PROMPT.titlesWatched || saved > 0)
  const { visible, close, setOnScreen } = useReminder('sync', wanted, delayMs)
  if (!visible) return null
  return (
    <ReminderCard
      id="sync-prompt-title"
      icon={<Cloud className="sync-prompt__icon" aria-hidden="true" />}
      title="Sign in to keep your progress & My List on all your devices"
      action="Create free account"
      onAction={() => {
        close()
        openSignIn()
      }}
      onClose={close}
      onScreen={setOnScreen}
    >
      <Benefits compact />
    </ReminderCard>
  )
}

/** "Set a password to log in on other devices": signed in by email link, no password yet. */
export function PasswordReminderHost({ delayMs = SHOW_AFTER_MS }: { delayMs?: number }) {
  const { status, user } = useAccount()
  const wanted = status === 'signedIn' && user !== null && !user.passwordSet
  const { visible, close, setOnScreen } = useReminder('password', wanted, delayMs)
  if (!visible) return null
  return (
    <ReminderCard
      id="password-reminder-title"
      icon={<KeyRound className="sync-prompt__icon" aria-hidden="true" />}
      title="Set a password to log in on other devices"
      action="Set a password"
      onAction={() => {
        close()
        goToPage('account')
      }}
      onClose={close}
      onScreen={setOnScreen}
    />
  )
}

interface ReminderCardProps {
  id: string
  icon: ReactNode
  title: string
  action: string
  onAction: () => void
  onClose: () => void
  onScreen: (on: boolean) => void
  children?: ReactNode
}

function ReminderCard({ id, icon, title, action, onAction, onClose, onScreen, children }: ReminderCardProps) {
  useDismiss(true, onClose)
  useEffect(() => {
    onScreen(true)
    return () => onScreen(false)
  }, [onScreen])
  return (
    <div className="sync-prompt" role="dialog" aria-modal="false" aria-labelledby={id}>
      {icon}
      <p id={id} className="sync-prompt__text">
        {title}
      </p>
      {children && <div className="sync-prompt__body">{children}</div>}
      <div className="sync-prompt__actions">
        <button type="button" className="sync-prompt__primary" onClick={onAction}>
          {action}
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
