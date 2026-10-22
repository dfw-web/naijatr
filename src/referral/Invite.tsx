import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Copy, Gift, Share2, X } from 'lucide-react'
import { isTvMode } from '../tv/tvMode'
import { arrivedByInvite } from './capture'
import { contestOn, countdownTarget, endLabel, fetchMe, login, nairaShort, naira, updateProfile, useContest, useCountdown, type ContestInfo, type Me } from './api'
import { useReferralSession } from './session'
import { closeInviteGuide, OPEN_GUIDE_KEY, openInviteGuide, SHARE_TEXT, useGuideOpen } from './guide'
import { dismissInvitee, useInviteeDue } from './invitee'
import './invite.css'

/**
 * The referral program on the movie pages: the "Invite friends 🎁" button,
 * and, only while the Invite & Win contest runs, a once-per-session popup,
 * a slim countdown banner and the 5-step guide, plus a "You can win too"
 * popup, once per device, for invited visitors when they close the player
 * after their watch counted for their friend. After the contest, a winners
 * banner for 3 days. Nothing here blocks browsing or watching, and every
 * piece closes with X, a tap outside, Escape or Back.
 */

const STEP_KEY = 'naijatr.invite.step'
const BOT_USERNAME = 'naijatr_bot'

const session = {
  get: (key: string) => {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
}

/** Overlays open now; they share one extra history entry, so Back closes them. */
let openOverlays = 0
/** Our own history.back() (dropping the entry): its popstate isn't the visitor pressing Back. */
let ownBack = false

/** Closes on Escape and on the phone's Back button (an extra history entry while open). */
function useDismiss(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    if (!open) return
    if (openOverlays++ === 0 && !window.history.state?.naijatrOverlay) {
      window.history.pushState({ naijatrOverlay: true }, '', window.location.href)
    }
    const onPop = () => {
      if (ownBack) {
        ownBack = false
        // It removed the entry this overlay shares: put it back.
        window.history.pushState({ naijatrOverlay: true }, '', window.location.href)
        return
      }
      if (!window.history.state?.naijatrOverlay) closeRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    document.addEventListener('keydown', onKey)
    return () => {
      openOverlays -= 1
      window.removeEventListener('popstate', onPop)
      document.removeEventListener('keydown', onKey)
      // Closed some other way: drop the entry, unless another overlay took it over (popup → guide).
      window.setTimeout(() => {
        if (openOverlays === 0 && window.history.state?.naijatrOverlay) {
          ownBack = true
          // Cleared once it lands, even with no overlay open to see it; after this popstate's
          // other listeners, so an overlay that opened meanwhile still knows it's ours.
          window.addEventListener('popstate', () => window.setTimeout(() => (ownBack = false), 0), { once: true })
          window.history.back()
        }
      }, 0)
    }
  }, [open])
}

const prizeLine = (prizes: number[]) => prizes.map((p, i) => `${['🥇', '🥈', '🥉'][i]}${nairaShort(p)}`).join(' · ')

/** Mount once in App: popup, banners and the guide. */
export function ContestHost() {
  const contest = useContest()
  const open = useGuideOpen()
  const inviteeDue = useInviteeDue()
  const signedIn = Boolean(useReferralSession())
  // Every visit, until the contest ends (not when /challenge sent them here for the guide).
  const [popup, setPopup] = useState(() => !session.get(OPEN_GUIDE_KEY))
  // Came from /challenge's "Get my invite link".
  useEffect(() => {
    if (!session.get(OPEN_GUIDE_KEY)) return
    try {
      window.sessionStorage.removeItem(OPEN_GUIDE_KEY)
    } catch {
      // Opens once anyway.
    }
    openInviteGuide()
  }, [])
  if (isTvMode() || !contest) return null
  const live = contestOn(contest)
  const dismissPopup = () => setPopup(false)
  return (
    <>
      {live && !popup && !open && <ContestBanner contest={contest} />}
      {contest.winners?.length === 3 && <WinnersBanner winners={contest.winners} />}
      {live && popup && !open && <ContestPopup contest={contest} onClose={dismissPopup} />}
      {live && inviteeDue && !signedIn && !popup && !open && <InviteePopup contest={contest} onClose={dismissInvitee} />}
      {open && <InviteGuide contest={contest} onClose={closeInviteGuide} />}
    </>
  )
}

/** "Starts in 1d 02h…" before the start, "Ends in …" after. */
function useContestCountdown(contest: ContestInfo) {
  const on = contestOn(contest)
  const countdown = useCountdown(on ? countdownTarget(contest) : null)
  return `${contest.phase === 'upcoming' ? 'Starts in' : 'Ends in'} ${countdown}`
}

/** "Starts Friday 6:00 PM · ends Sunday 11:59 PM." or "Ends Sunday 11:59 PM." */
const whenLine = (contest: ContestInfo) =>
  contest.phase === 'upcoming' && contest.start
    ? `Starts ${endLabel(contest.start)} · ends ${endLabel(contest.end!)}.`
    : `Ends ${endLabel(contest.end!)}.`

function ContestPopup({ contest, onClose }: { contest: ContestInfo; onClose: () => void }) {
  const countdown = useContestCountdown(contest)
  useDismiss(true, onClose)
  const prizes = contest.prizes!
  return createPortal(
    <div className="invite-popup" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="invite-popup__panel" role="dialog" aria-modal="true" aria-labelledby="invite-popup-title">
        <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        {contest.preview && <p className="invite-popup__preview">Preview: only you see this. The challenge isn’t running yet.</p>}
        {arrivedByInvite() && <p className="invite-popup__invited">Your friend invited you 👋</p>}
        <h2 id="invite-popup-title" className="invite-popup__title">
          🎉 Invite friends &amp; win up to {naira(Math.max(...prizes))}!
        </h2>
        <p className="invite-popup__prizes">{prizeLine(prizes)}</p>
        <p className="invite-popup__ends">{whenLine(contest)}</p>
        <p className="invite-countdown">⏳ {countdown}</p>
        <div className="invite-popup__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onClose()
              openInviteGuide()
            }}
          >
            I&apos;m interested 👀
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Maybe later
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** "Sunday 25 Oct, 11:59 PM", Lagos time. */
const endDate = (end: number) => {
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', ...options }).format(new Date(end))
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(end))
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })}, ${time}`
}

/** For a friend's invitee, after their watch counted: they can win too. */
function InviteePopup({ contest, onClose }: { contest: ContestInfo & { end: number; prizes: number[] }; onClose: () => void }) {
  const countdown = useContestCountdown(contest)
  useDismiss(true, onClose)
  // The contest ends while it's open: it goes away.
  useEffect(() => {
    const timer = window.setTimeout(onClose, Math.max(0, contest.end - Date.now()))
    return () => window.clearTimeout(timer)
  }, [contest.end, onClose])
  return createPortal(
    <div className="invite-popup" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="invite-popup__panel" role="dialog" aria-modal="true" aria-labelledby="invitee-popup-title">
        <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        <img src="/favicon.svg" alt="NAIJA TR" className="invite-popup__logo" />
        <p className="invite-popup__invited">👋 Your friend invited you to NAIJA TR!</p>
        <h2 id="invitee-popup-title" className="invite-popup__title">
          🎁 You too can win cash prizes!
        </h2>
        <p className="invite-popup__prizes invite-popup__prizes--gold">
          {contest.prizes.map((p, i) => `${['🥇', '🥈', '🥉'][i]} ${naira(p)}`).join(' · ')}
        </p>
        <p className="invite-popup__ends">Invite your own friends and climb the leaderboard. Ends {endDate(contest.end)}.</p>
        <p className="invite-countdown">⏳ {countdown}</p>
        <div className="invite-popup__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onClose()
              openInviteGuide()
            }}
          >
            Yes, I&apos;m interested 👀
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Maybe later
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ContestBanner({ contest }: { contest: ContestInfo }) {
  const countdown = useContestCountdown(contest)
  return (
    <div className="invite-banner" role="region" aria-label="Invite and win">
      <span>
        🎁 Invite &amp; win up to {nairaShort(Math.max(...contest.prizes!))} · <span className="invite-banner__time">⏳ {countdown}</span>
      </span>
      <button type="button" onClick={openInviteGuide}>
        I&apos;m interested
      </button>
    </div>
  )
}

function WinnersBanner({ winners }: { winners: string[] }) {
  return (
    <div className="invite-banner invite-banner--winners" role="region" aria-label="Challenge winners">
      🏆 Challenge winners: 🥇{winners[0]} · 🥈{winners[1]} · 🥉{winners[2]}. Thanks to everyone who joined! 🙏
    </div>
  )
}

/** The header's "Invite friends 🎁". */
export function InviteButton({ className = '' }: { className?: string }) {
  if (isTvMode()) return null
  return (
    <button type="button" className={`invite-button ${className}`} onClick={openInviteGuide}>
      <Gift aria-hidden="true" />
      <span className="invite-button__long">Invite friends 🎁</span>
      <span className="invite-button__short">Invite</span>
    </button>
  )
}

// ---- The guide ----

const readStep = () => {
  try {
    return Math.min(4, Math.max(0, Number(window.localStorage.getItem(STEP_KEY)) || 0))
  } catch {
    return 0
  }
}
const saveStep = (step: number) => {
  try {
    window.localStorage.setItem(STEP_KEY, String(step))
  } catch {
    // Starts over next time.
  }
}

function InviteGuide({ contest, onClose }: { contest: ContestInfo; onClose: () => void }) {
  const signedIn = Boolean(useReferralSession())
  const live = contestOn(contest)
  // Joined already, or no contest: straight to the link.
  const [step, setStep] = useState(() => (signedIn || !live ? 4 : readStep()))
  const touch = useRef<number | null>(null)
  useDismiss(true, onClose)
  const go = (next: number) => {
    const clamped = Math.min(4, Math.max(0, next))
    setStep(clamped)
    saveStep(clamped)
  }
  const steps: { title: string; body: ReactNode }[] = live
    ? [
        { title: 'The Prizes 🏆', body: <PrizesStep contest={contest} /> },
        { title: 'How it works 🔗', body: <HowStep /> },
        { title: 'What counts (and what doesn’t) ✅❌', body: <CountsStep /> },
        { title: 'The rules 📜', body: <RulesStep contest={contest} /> },
        { title: 'Get started 🚀', body: <StartStep live preview={contest.preview} /> },
      ]
    : [{ title: 'Invite friends 🎁', body: <StartStep live={false} /> }]
  const index = live ? step : 0
  const current = steps[index]
  return createPortal(
    <div className="invite-guide" role="dialog" aria-modal="true" aria-labelledby="invite-guide-title">
      <div
        className="invite-guide__panel"
        onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touch.current === null || !live) return
          const dx = e.changedTouches[0].clientX - touch.current
          touch.current = null
          if (Math.abs(dx) > 60) go(step + (dx < 0 ? 1 : -1))
        }}
      >
        <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        {live && (
          <div className="invite-guide__dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((s, i) => (
              <button key={s.title} type="button" aria-label={`Step ${i + 1}: ${s.title}`} aria-current={i === index} className="invite-guide__dot" onClick={() => go(i)} />
            ))}
          </div>
        )}
        <h2 id="invite-guide-title" className="invite-guide__title">
          {current.title}
        </h2>
        <div className="invite-guide__body">{current.body}</div>
        {live && (
          <div className="invite-guide__nav">
            <button type="button" className="btn btn--ghost" disabled={index === 0} onClick={() => go(step - 1)}>
              <ChevronLeft aria-hidden="true" /> Back
            </button>
            {index < steps.length - 1 ? (
              <button type="button" className="btn btn--primary" onClick={() => go(step + 1)}>
                Next <ChevronRight aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Done
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function Countdown({ contest }: { contest: ContestInfo }) {
  const countdown = useContestCountdown(contest)
  return (
    <>
      <p className="invite-countdown">⏳ {countdown}</p>
      {contest.phase === 'upcoming' && <p className="invite-note">Get your link now: points count from the start.</p>}
    </>
  )
}

const PRIZE_PLACES = ['🥇 1st', '🥈 2nd', '🥉 3rd']

function PrizesStep({ contest }: { contest: ContestInfo }) {
  return (
    <>
      <p className="invite-lead">Invite friends and win cash!</p>
      <ul className="invite-prizes">
        {contest.prizes!.map((p, i) => (
          <li key={i}>
            <span>{PRIZE_PLACES[i]}</span>
            <strong>{naira(p)}</strong>
          </li>
        ))}
      </ul>
      <Countdown contest={contest} />
    </>
  )
}

function HowStep() {
  return (
    <ol className="invite-list">
      <li>Get your personal invite link.</li>
      <li>Share it with friends on WhatsApp, Telegram, X…</li>
      <li>
        Each friend who opens <strong>your unique link</strong> on a <strong>new phone</strong> AND then <strong>watches a movie or an episode of a
        series</strong> on that same phone counts as 1 point for you.
      </li>
      <li>The top 3 with the most points win.</li>
    </ol>
  )
}

function CountsStep() {
  return (
    <div className="invite-counts">
      <p className="invite-counts__head">✅ Counts</p>
      <ul>
        <li>New friends who open your unique link, then watch a movie or an episode of a series on that same phone.</li>
      </ul>
      <p className="invite-counts__head">❌ Doesn’t count</p>
      <ul>
        <li>Friends who come to NAIJA TR without your link (typing the address, searching, someone else’s link).</li>
        <li>Friends who open your link but watch on a different phone.</li>
        <li>Friends who only open the link, browse, or watch a trailer or live football.</li>
        <li>Opening your own link.</li>
        <li>The same phone twice.</li>
        <li>Fake or bot visits (instant disqualification).</li>
      </ul>
    </div>
  )
}

function RulesStep({ contest }: { contest: ContestInfo }) {
  return (
    <>
      <ul className="invite-list invite-list--plain">
        <li>Free to enter</li>
        <li>A friend only counts after opening your unique link and then watching a movie or an episode of a series</li>
        <li>One account per person</li>
        <li>{whenLine(contest).replace(/\.$/, '')}</li>
        <li>Fake/bot referrals are disqualified</li>
        <li>Winners claim within 48h</li>
        <li>Prizes paid by bank transfer within 3 working days</li>
        <li>Prizes are paid to a Nigerian bank account (or a mobile money account in Nigeria)</li>
      </ul>
      <a className="invite-link" href="/challenge/rules" target="_blank" rel="noreferrer">
        Read full rules
      </a>
    </>
  )
}

/** Step 5: sign in with Telegram, then the link and share buttons. */
const PREVIEW_LINK = 'https://www.naijatr.com/r/PREVIEW'

function StartStep({ live, preview = false }: { live: boolean; preview?: boolean }) {
  const current = useReferralSession()
  if (!current) {
    return (
      <>
        <p className="invite-lead">Join with Telegram to get your link.</p>
        <TelegramLogin />
        {preview && (
          <div className="invite-share invite-share--preview">
            <p className="invite-share__label">Preview: after joining, their own link goes here</p>
            <p className="invite-share__link">{PREVIEW_LINK}</p>
            <ShareButtons message={`${SHARE_TEXT} ${PREVIEW_LINK}`} link={PREVIEW_LINK} />
          </div>
        )}
      </>
    )
  }
  return <SharePanel live={live} />
}

/** The Telegram Login Widget for @naijatr_bot (it may message you, e.g. if you win). */
export function TelegramLogin() {
  const box = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const holder = box.current
    if (!holder) return
    ;(window as unknown as { naijatrTelegramAuth: (user: unknown) => void }).naijatrTelegramAuth = (user) => {
      void login(user).then((ok) => setError(!ok))
    }
    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.async = true
    script.setAttribute('data-telegram-login', BOT_USERNAME)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '10')
    script.setAttribute('data-onauth', 'naijatrTelegramAuth(user)')
    script.setAttribute('data-request-access', 'write')
    holder.replaceChildren(script)
    return () => holder.replaceChildren()
  }, [])
  return (
    <>
      <div ref={box} className="invite-login" />
      {error && (
        <p className="invite-error" role="alert">
          Couldn’t sign you in. Please try again.
        </p>
      )}
    </>
  )
}

const onPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** Each button opens that app's "send to…" screen with the message ready; on a computer, its web page. */
const SHARE_TARGETS: { id: string; name: string; href: (message: string, link: string) => string }[] = [
  {
    id: 'wa',
    name: 'WhatsApp',
    href: (message) => `${onPhone() ? 'whatsapp://send' : 'https://wa.me/'}?text=${encodeURIComponent(message)}`,
  },
  {
    id: 'tg',
    name: 'Telegram',
    href: (_message, link) =>
      `${onPhone() ? 'tg://msg_url' : 'https://t.me/share/url'}?url=${encodeURIComponent(link)}&text=${encodeURIComponent(SHARE_TEXT)}`,
  },
  // x.com links open the X app on phones that have it.
  { id: 'x', name: 'X', href: (message) => `https://x.com/intent/post?text=${encodeURIComponent(message)}` },
]

/** WhatsApp, Telegram, X, Copy and (on phones) the phone's own share menu. */
function ShareButtons({ message, link }: { message: string; link: string }) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator.share === 'function'
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="invite-share__buttons">
      {SHARE_TARGETS.map((target) => {
        const href = target.href(message, link)
        // App links open in place; web links in a new tab.
        const web = href.startsWith('http')
        return (
          <a
            key={target.name}
            className={`invite-share__btn invite-share__btn--${target.id}`}
            href={href}
            target={web ? '_blank' : undefined}
            rel={web ? 'noreferrer' : undefined}
          >
            {target.name}
          </a>
        )
      })}
      <button type="button" className="invite-share__btn" onClick={() => void copy()}>
        <Copy aria-hidden="true" /> {copied ? 'Copied!' : 'Copy'}
      </button>
      {canShare && (
        <button
          type="button"
          className="invite-share__btn"
          onClick={() => void navigator.share({ text: message }).catch(() => {})}
        >
          <Share2 aria-hidden="true" /> More apps…
        </button>
      )}
    </div>
  )
}

export function SharePanel({ live }: { live: boolean }) {
  const current = useReferralSession()
  const [me, setMe] = useState<Me | null>(null)
  const [nickname, setNickname] = useState(current?.user.nickname ?? '')
  const [saved, setSaved] = useState<'idle' | 'saved' | 'bad'>('idle')
  useEffect(() => {
    let active = true
    void fetchMe().then((data) => {
      if (active) setMe(data)
    })
    return () => {
      active = false
    }
  }, [])
  if (!current) return null
  const { link, hidden } = current.user
  const message = `${SHARE_TEXT} ${link}`
  return (
    <div className="invite-share">
      <p className="invite-share__label">Your invite link</p>
      <p className="invite-share__link">{link}</p>
      <ShareButtons message={message} link={link} />
      <p className="invite-share__message">{message}</p>
      {live && (
        <div className="invite-share__stats">
          <p>
            <strong>{me?.points ?? '–'}</strong> points
          </p>
          <p>
            <strong>{me?.rank ? `#${me.rank}` : '–'}</strong> rank
          </p>
        </div>
      )}
      {!live && me && <p className="invite-share__total">{me.total} friends joined with your link</p>}
      {live && (
        <a className="btn btn--primary invite-share__board" href="/challenge">
          See leaderboard
        </a>
      )}
      <details className="invite-share__name">
        <summary>Your name on the leaderboard</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void updateProfile({ nickname }).then((status) => setSaved(status === 200 ? 'saved' : 'bad'))
          }}
        >
          <input value={nickname} maxLength={24} aria-label="Nickname" onChange={(e) => setNickname(e.target.value)} />
          <button type="submit" className="btn btn--ghost">
            Save
          </button>
        </form>
        {saved !== 'idle' && <p role="status">{saved === 'saved' ? 'Saved.' : 'Use 2–24 letters or numbers.'}</p>}
        <label className="invite-share__hide">
          <input type="checkbox" checked={hidden} onChange={(e) => void updateProfile({ hidden: e.target.checked })} /> Hide my name
          on the leaderboard
        </label>
      </details>
    </div>
  )
}
