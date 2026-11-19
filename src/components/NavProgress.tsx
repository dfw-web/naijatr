import { useEffect, useRef, useState } from 'react'
import { isLoading, subscribeLoading } from '../ui/loadingTracker'
import './NavProgress.css'

/** Quicker than this, nothing shows (no flicker for answers already in the cache). */
export const PROGRESS_SHOW_AFTER_MS = 150
/** Slower than this: the little bouncing NT logo in the corner too. */
export const PROGRESS_SLOW_AFTER_MS = 300
/** The bar fills to the end and fades. */
export const PROGRESS_DONE_MS = 450

type Phase = 'idle' | 'loading' | 'done'

/**
 * Moving inside the app: a slim red bar across the top while the page's
 * titles load (src/ui/loadingTracker.ts), with a glowing tip, and after
 * 300 ms a small bouncing NT logo in the corner. The full splash is only for
 * page loads (index.html). Both sit under the details panel and the players,
 * so they never cover a video that's playing.
 */
export function NavProgress() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [slow, setSlow] = useState(false)
  // A new key per load restarts the bar from the start.
  const [run, setRun] = useState(0)
  const bar = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let was = false
    let show = 0
    let slowTimer = 0
    const update = () => {
      const now = isLoading()
      if (now === was) return
      was = now
      window.clearTimeout(show)
      window.clearTimeout(slowTimer)
      if (now) {
        show = window.setTimeout(() => {
          setPhase('loading')
          setRun((n) => n + 1)
        }, PROGRESS_SHOW_AFTER_MS)
        slowTimer = window.setTimeout(() => setSlow(true), PROGRESS_SLOW_AFTER_MS)
        return
      }
      // Done: from wherever the bar got to (measured before it changes), to the end.
      const el = bar.current
      if (el?.parentElement) {
        const at = (el.getBoundingClientRect().width / (el.parentElement.getBoundingClientRect().width || 1)) * 100
        el.style.setProperty('--nav-progress-from', `${Math.min(100, at)}%`)
      }
      setSlow(false)
      setPhase((current) => (current === 'loading' ? 'done' : current))
    }
    update()
    const unsubscribe = subscribeLoading(update)
    return () => {
      unsubscribe()
      window.clearTimeout(show)
      window.clearTimeout(slowTimer)
    }
  }, [])

  // Then gone.
  useEffect(() => {
    if (phase !== 'done') return
    const timer = window.setTimeout(() => setPhase('idle'), PROGRESS_DONE_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  return (
    <>
      {phase !== 'idle' && (
        <div key={run} className={`nav-progress nav-progress--${phase}`} data-testid="nav-progress" aria-hidden="true">
          <span ref={bar} className="nav-progress__bar" />
        </div>
      )}
      {slow && (
        <div className="nav-progress__logo" data-testid="nav-progress-logo" aria-hidden="true">
          <img src="/favicon.svg" alt="" width="34" height="34" />
        </div>
      )}
    </>
  )
}
