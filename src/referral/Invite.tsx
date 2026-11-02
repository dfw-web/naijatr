import { useEffect, useState } from 'react'
import { Check, Copy, Gift, Sparkles, X } from 'lucide-react'
import { openSignIn, useAccount, useSignInSheet } from '../account/account'
import { hasStoredSession } from '../account/client'
import { goToPage } from '../account/pages'
import { holdAdsThisTap, isPlaybackOpen, useAdOverlay, useOverlayOpen } from '../ads/adManager'
import { isTvMode } from '../tv/tvMode'
import { useHoldNotices, useNoticesHeld } from '../ui/noticeQueue'
import { readRef } from './capture'
import { AD_FREE_PLANS, buyLink, FROM_PRICE, naira } from '../config/adFree'
import {
  dismissRenewToday,
  lagosDate,
  markPromoShown,
  progressText,
  promoShownToday,
  promoTiming,
  RENEW_REMINDER_MS,
  renewDismissedToday,
  requestBuyOption,
  shareMessage,
  takeBuyRequest,
} from './copy'
import {
  dismissActivation,
  dismissUnlock,
  goalNow,
  refreshReferralStatus,
  useActivationDue,
  useAdFree,
  useReferralStatus,
  useUnlockDue,
  type ReferralStatus,
} from './status'
import './referral.css'

/**
 * The ad-free screens: /invite (invite friends for free, or buy ad-free),
 * /invite/rules, the header's "Go ad-free" button, the home page card, the
 * daily popup, the unlock and paid-activation notices, the renew reminder and
 * the account page's ad-free card.
 * Promotions never say how long ad-free lasts; only the account page shows
 * the user's own end date. Everything promotional hides for ad-free accounts.
 */

const weekText = (n: number) => `You've invited ${n} ${n === 1 ? 'person' : 'people'} this week`

/** The referral screens show only where accounts exist (Supabase set up) and off TVs. */
const useReferralsOn = () => useAccount().status !== 'disabled' && !isTvMode()

const openInvite = () => {
  holdAdsThisTap()
  goToPage('invite')
}

export function ShareButtons({ link }: { link: string }) {
  const [copied, setCopied] = useState(false)
  const text = shareMessage(link)
  const copy = async () => {
    holdAdsThisTap()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy your invite message:', text)
    }
  }
  const shares = [
    { name: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(text)}`, className: 'invite-share--whatsapp' },
    {
      name: 'Telegram',
      href: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text.replace(` ${link}`, ''))}`,
      className: 'invite-share--telegram',
    },
    { name: 'X', href: `https://x.com/intent/post?text=${encodeURIComponent(text)}`, className: 'invite-share--x' },
  ]
  return (
    <div className="invite-share" role="group" aria-label="Share your invite link">
      {shares.map((share) => (
        <a key={share.name} className={`invite-share__button ${share.className}`} href={share.href} target="_blank" rel="noopener noreferrer" onClick={() => holdAdsThisTap()}>
          {share.name}
        </a>
      ))}
      <button type="button" className="invite-share__button invite-share--copy" onClick={() => void copy()}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}

function Progress({ status }: { status: ReferralStatus }) {
  const goal = status.goal
  const counted = status.counted ?? 0
  const towards = counted % goal
  return (
    <div className="invite-progress">
      <p className="invite-progress__text">{progressText(counted, goal)}</p>
      <div className="invite-progress__bar" role="progressbar" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={towards}>
        <span style={{ width: `${(towards / goal) * 100}%` }} />
      </div>
    </div>
  )
}

/** "💳 Buy ad-free": the plans, and the Telegram chat to pay in (src/config/adFree.ts). */
export function BuyAdFree() {
  const { status: account, user } = useAccount()
  const [plan, setPlan] = useState(AD_FREE_PLANS[0])
  const [copied, setCopied] = useState(false)
  const email = account === 'signedIn' ? (user?.email ?? null) : null
  const copyEmail = async () => {
    if (!email) return
    holdAdsThisTap()
    try {
      await navigator.clipboard.writeText(email)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy your account email:', email)
    }
  }
  return (
    <div className="account-card buy-ad-free">
      <h2 className="account-card__title">🚫 Tired of ads? Get NAIJA TR AD-FREE! 🍿⚽</h2>
      <p className="account-card__muted">
        Watch movies, series, anime, K-drama &amp; live football with no ads, no pop-ups, no interruptions 😎
      </p>
      <p className="buy-ad-free__pricing">💰 Pricing:</p>
      <div className="buy-ad-free__plans" role="radiogroup" aria-label="Plan">
        {AD_FREE_PLANS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={option.id === plan.id}
            className={option.id === plan.id ? 'buy-ad-free__plan buy-ad-free__plan--on' : 'buy-ad-free__plan'}
            onClick={() => setPlan(option)}
          >
            ✅ {option.label}: {naira(option.price)}
            {option.extra ? ` ${option.extra}` : ''}
          </button>
        ))}
      </div>
      {account === 'signedIn' && email ? (
        <>
          <p className="buy-ad-free__email">
            Your account email: <strong>{email}</strong>. Send this to us on Telegram so we can activate it.{' '}
            <button type="button" className="account-page__ghost buy-ad-free__copy" onClick={() => void copyEmail()}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copied ? 'Copied!' : 'Copy email'}
            </button>
          </p>
          <a className="account-page__primary buy-ad-free__chat" href={buyLink(plan, email)} target="_blank" rel="noopener noreferrer" onClick={() => holdAdsThisTap()}>
            Chat on Telegram to buy
          </a>
        </>
      ) : account === 'checking' ? (
        <p className="account-card__muted" role="status">
          Signing you in…
        </p>
      ) : (
        <>
          <p className="buy-ad-free__email">Create a free account first, so we can activate ad-free on it.</p>
          <div className="account-card__actions">
            <button type="button" className="account-page__primary" onClick={() => openSignIn('create')}>
              Sign up
            </button>
            <button type="button" className="account-page__ghost" onClick={() => openSignIn('login')}>
              Log in
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** /invite: the two ways to go ad-free (invite friends, free; or buy), and the invite link. */
export function InvitePage() {
  const { status: account } = useAccount()
  const status = useReferralStatus()
  const adFree = useAdFree()
  const [option, setOption] = useState<'invite' | 'buy'>(() => (takeBuyRequest() ? 'buy' : 'invite'))
  useEffect(() => {
    if (account === 'signedIn') void refreshReferralStatus()
  }, [account])
  const goal = status?.goal ?? goalNow()

  return (
    <section className="account-page invite-page" aria-labelledby="invite-title">
      <h1 id="invite-title" className="account-page__title">
        🎁 Go ad-free
      </h1>
      {adFree ? (
        <p className="invite-page__badge">
          <Sparkles aria-hidden="true" /> You're enjoying NAIJA TR ad-free. Keep inviting for the weekly mystery prize!
        </p>
      ) : (
        <div className="adfree-options" role="group" aria-label="Ways to go ad-free">
          <button type="button" className="adfree-options__option" aria-pressed={option === 'invite'} onClick={() => setOption('invite')}>
            🤝 Invite {goal} friends (free)
          </button>
          <button type="button" className="adfree-options__option" aria-pressed={option === 'buy'} onClick={() => setOption('buy')}>
            💳 Buy ad-free
          </button>
        </div>
      )}

      {!adFree && option === 'buy' ? <BuyAdFree /> : <InviteOption goal={goal} adFree={adFree} />}
    </section>
  )
}

function InviteOption({ goal, adFree }: { goal: number; adFree: boolean }) {
  const { status: account } = useAccount()
  const status = useReferralStatus()
  return (
    <>
      {!adFree && (
        <p className="account-page__lead">
          Invite {goal} friends to NAIJA TR and get the ad-free version. 🏆 Bonus: invite the most people this week and win a
          mystery prize 🎁
        </p>
      )}

      {account === 'signedIn' ? (
        status?.signedIn && status.link ? (
          <>
            <div className="account-card">
              <h2 className="account-card__title">Your invite link</h2>
              <input className="invite-page__link" readOnly value={status.link} aria-label="Your invite link" onFocus={(e) => e.currentTarget.select()} />
              <ShareButtons link={status.link} />
            </div>
            <div className="account-card">
              <h2 className="account-card__title">Your progress</h2>
              <Progress status={status} />
              <p className="account-card__muted">{weekText(status.weekCount ?? 0)}</p>
              {(status.pending ?? 0) > 0 && (
                <p className="account-card__muted">
                  {status.pending} {status.pending === 1 ? 'friend has' : 'friends have'} signed up and will count once they confirm
                  their email and watch something.
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="account-page__lead" role="status">
            Loading your invite link…
          </p>
        )
      ) : account === 'checking' ? (
        <p className="account-page__lead" role="status">
          Signing you in…
        </p>
      ) : (
        <div className="account-card">
          <h2 className="account-card__title">Start inviting</h2>
          <p className="account-card__muted">You need a free account to get your own invite link. Browsing and watching never need one.</p>
          <div className="account-card__actions">
            <button type="button" className="account-page__primary" onClick={() => openSignIn('create')}>
              Create a free account to start inviting
            </button>
            <button type="button" className="account-page__ghost" onClick={() => openSignIn('login')}>
              Log in
            </button>
          </div>
        </div>
      )}

      <div className="account-card">
        <h2 className="account-card__title">How it works</h2>
        <ol className="invite-steps">
          <li>Share your link with friends.</li>
          <li>They create a free NAIJA TR account with it and confirm their email.</li>
          <li>They watch a movie, an episode or a match. That's it: they count!</li>
        </ol>
        <a href="/invite/rules" className="account-page__link" onClick={(e) => (e.preventDefault(), goToPage('invite/rules'))}>
          Full rules
        </a>
      </div>
    </>
  )
}

/** /invite/rules */
export function InviteRulesPage() {
  const goal = useReferralStatus()?.goal ?? goalNow()
  return (
    <article className="account-page account-page--text" aria-labelledby="rules-title">
      <h1 id="rules-title" className="account-page__title">
        Invite rules
      </h1>
      <h2>How counting works</h2>
      <p>
        Everyone with a free NAIJA TR account gets their own invite link. A friend counts for you when they open your link,
        create a <strong>new</strong> NAIJA TR account within 7 days, confirm their email address, and watch a movie, an
        episode or a football match.
      </p>
      <h2>What doesn't count</h2>
      <ul>
        <li>Inviting yourself, or making extra accounts for yourself.</li>
        <li>
          Accounts that already existed, or a second account for the same inbox (for Gmail, dots and “+” extras in the address
          don't make a new inbox).
        </li>
        <li>Each new account counts once, for the first link it came by.</li>
        <li>
          Too many sign-ups from the same network in one day are held for review. We look out for suspicious patterns, and
          referrals that break these rules are removed.
        </li>
      </ul>
      <h2>The ad-free reward</h2>
      <p>
        Every {goal} friends who count unlock the ad-free version of NAIJA TR on every device you're signed in on. You can see
        how long yours lasts on your Account page. Ad-free access duration may change; NAIJA TR will let you know before it
        ends.
      </p>
      <h2>The weekly mystery prize</h2>
      <p>
        Each week (Monday 00:00 to Sunday 23:59, Lagos time), the person whose invites count the most wins a mystery prize. If
        two people tie, the one who reached that number first wins. There's no public leaderboard: you only see your own
        count. Winners are contacted by email at the address on their account.
      </p>
      <h2>Final say</h2>
      <p>NAIJA TR may change these rules, and NAIJA TR's decision on referrals, rewards and prizes is final.</p>
      <p>
        <a href="/invite" className="account-page__link" onClick={(e) => (e.preventDefault(), goToPage('invite'))}>
          ← Get your invite link
        </a>
      </p>
    </article>
  )
}

/** The header's "🎁 Go ad-free" (hidden for ad-free accounts). */
export function GoAdFreeButton() {
  const on = useReferralsOn()
  const adFree = useAdFree()
  if (!on || adFree) return null
  return (
    <button type="button" className="go-ad-free" onClick={openInvite}>
      <span aria-hidden="true">🎁</span> Go ad-free
    </button>
  )
}

/** The home page's invite card (hidden for ad-free accounts). */
export function InviteCard() {
  const on = useReferralsOn()
  const adFree = useAdFree()
  const { status: account } = useAccount()
  const status = useReferralStatus()
  if (!on || adFree) return null
  const invited = account !== 'signedIn' && readRef() !== null
  return (
    <aside className="invite-card" aria-label="Invite friends">
      <Gift className="invite-card__icon" aria-hidden="true" />
      <div className="invite-card__body">
        <p className="invite-card__title">
          {invited ? 'A friend invited you to NAIJA TR 🎉' : `Want NAIJA TR ad-free? Invite ${status?.goal ?? goalNow()} friends!`}
        </p>
        <p className="invite-card__text">
          {account === 'signedIn' && status?.signedIn
            ? progressText(status.counted ?? 0, status.goal)
            : invited
              ? 'Create a free account, then invite your own friends to go ad-free.'
              : '🏆 Bonus: invite the most people this week and win a mystery prize 🎁'}
        </p>
      </div>
      <button type="button" className="invite-card__button" onClick={account === 'signedIn' ? openInvite : () => openSignIn('create')}>
        {account === 'signedIn' ? 'Invite friends' : 'Create a free account'}
      </button>
    </aside>
  )
}

// ---- The daily popup ----

/** Another popup, sheet or the player is on screen: the promo waits. */
const somethingOpen = () => isPlaybackOpen() || document.querySelector('[role="dialog"], [aria-modal="true"]') !== null

/**
 * At most once a day per device (signed in or not), after the page has been
 * open a while, never during playback or over another popup, and never for
 * ad-free accounts.
 */
export function DailyPromoHost() {
  const on = useReferralsOn()
  const adFree = useAdFree()
  const { status: account } = useAccount()
  const status = useReferralStatus()
  const overlayOpen = useOverlayOpen()
  const noticesHeld = useNoticesHeld()
  const sheet = useSignInSheet()
  const unlock = useUnlockDue()
  const [waited, setWaited] = useState(false)
  const [open, setOpen] = useState(false)
  // A signed-in device waits for the server's ad-free answer first.
  const known = !hasStoredSession() || status !== null || account === 'signedOut'
  const onInvitePages = /^\/invite(\/|$)/.test(window.location.pathname)
  const [alreadyToday] = useState(() => promoShownToday())
  const due = on && !adFree && known && !onInvitePages && !alreadyToday

  useEffect(() => {
    if (!due) return
    const timer = window.setTimeout(() => setWaited(true), promoTiming.delayMs)
    return () => window.clearTimeout(timer)
  }, [due])

  const blocked = overlayOpen || noticesHeld || sheet !== null || unlock
  useEffect(() => {
    if (!due || !waited || blocked || open) return
    const tryShow = () => {
      if (somethingOpen() || promoShownToday()) return false
      markPromoShown()
      setOpen(true)
      return true
    }
    if (tryShow()) return
    const timer = window.setInterval(() => {
      if (tryShow()) window.clearInterval(timer)
    }, promoTiming.pollMs)
    return () => window.clearInterval(timer)
  }, [due, waited, blocked, open])

  const visible = open && !adFree
  useAdOverlay(visible)
  useHoldNotices(visible)
  if (!visible) return null

  const close = () => {
    holdAdsThisTap()
    setOpen(false)
  }
  const signedIn = account === 'signedIn'
  return (
    <div className="promo" role="dialog" aria-modal="true" aria-labelledby="promo-title">
      <div className="promo__panel">
        <button type="button" className="promo__close" aria-label="Close" onClick={close}>
          <X aria-hidden="true" />
        </button>
        <p id="promo-title" className="promo__title">
          🚫 Want NAIJA TR ad-free?
        </p>
        <p className="promo__text">
          Invite {status?.goal ?? goalNow()} friends and get the ad-free version! 🏆 Bonus: invite the most people this week and
          win a mystery prize 🎁
        </p>
        <div className="promo__actions">
          <button
            type="button"
            className="promo__primary"
            onClick={() => {
              close()
              if (signedIn) openInvite()
              else openSignIn('create')
            }}
          >
            {signedIn ? 'Invite friends' : 'Create a free account to start inviting'}
          </button>
          <button type="button" className="promo__ghost" onClick={close}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}

/** "🎉 You've unlocked NAIJA TR ad-free!" once, after an unlock. */
export function UnlockNoticeHost() {
  const due = useUnlockDue()
  useAdOverlay(due)
  if (!due) return null
  return (
    <div className="promo" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
      <div className="promo__panel">
        <p id="unlock-title" className="promo__title">
          🎉 You've unlocked NAIJA TR ad-free!
        </p>
        <p className="promo__text">Your friends joined, so ads are off on every device you're signed in on. Thank you! ❤️</p>
        <div className="promo__actions">
          <button
            type="button"
            className="promo__primary"
            onClick={() => {
              holdAdsThisTap()
              dismissUnlock()
            }}
          >
            Enjoy 🍿
          </button>
        </div>
      </div>
    </div>
  )
}

/** Opens /invite on "Buy ad-free". */
const openBuy = () => {
  requestBuyOption()
  openInvite()
}

/**
 * The account page's ad-free card: the only place the end date shows, with
 * "Renew" (the Telegram chat); or, not ad-free, "Go ad-free" with both options.
 */
export function AdFreeCard() {
  const status = useReferralStatus()
  const { user } = useAccount()
  useEffect(() => {
    void refreshReferralStatus()
  }, [])
  if (!status?.signedIn) return null
  if (status.adFree) {
    const timed = !status.permanent && status.adFreeUntil
    return (
      <div className="account-card">
        <h2 className="account-card__title">Ad-free</h2>
        <p className="account-card__value">
          <Sparkles aria-hidden="true" /> {timed ? `Ad-free until ${lagosDate(status.adFreeUntil!)}` : 'Ad-free on all your devices'}
        </p>
        <div className="account-card__actions">
          {timed && (
            <a className="account-page__primary" href={buyLink(AD_FREE_PLANS[0], user?.email)} target="_blank" rel="noopener noreferrer" onClick={() => holdAdsThisTap()}>
              Renew
            </a>
          )}
          <button type="button" className="account-page__ghost" onClick={openInvite}>
            <Gift aria-hidden="true" /> Keep inviting
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="account-card">
      <h2 className="account-card__title">🎁 Go ad-free</h2>
      <p className="account-card__muted">{progressText(status.counted ?? 0, status.goal)}</p>
      <div className="account-card__actions">
        <button type="button" className="account-page__ghost" onClick={openInvite}>
          <Gift aria-hidden="true" /> Invite {status.goal} friends (free)
        </button>
        <button type="button" className="account-page__primary" onClick={openBuy}>
          💳 Buy ad-free from {naira(FROM_PRICE)}
        </button>
      </div>
    </div>
  )
}

/** "🎉 NAIJA TR ad-free is active until…", once after a paid grant. */
export function ActivationNoticeHost() {
  const due = useActivationDue()
  const status = useReferralStatus()
  useAdOverlay(due)
  if (!due || !status?.adFreeUntil) return null
  return (
    <div className="promo" role="dialog" aria-modal="true" aria-labelledby="activation-title">
      <div className="promo__panel">
        <p id="activation-title" className="promo__title">
          🎉 NAIJA TR ad-free is active until {lagosDate(status.adFreeUntil)}.
        </p>
        <p className="promo__text">Thank you! ❤️</p>
        <div className="promo__actions">
          <button
            type="button"
            className="promo__primary"
            onClick={() => {
              holdAdsThisTap()
              dismissActivation()
            }}
          >
            Enjoy 🍿
          </button>
        </div>
      </div>
    </div>
  )
}

/** In the last 3 days of a timed ad-free: "Your ad-free ends on… Renew", at most once a day. */
export function RenewReminderHost() {
  const status = useReferralStatus()
  const { user } = useAccount()
  const activation = useActivationDue()
  const unlock = useUnlockDue()
  const [closed, setClosed] = useState(() => renewDismissedToday())
  const [now] = useState(() => Date.now())
  const until = status?.signedIn && status.adFree && !status.permanent && status.adFreeUntil ? Date.parse(status.adFreeUntil) : NaN
  const due = !closed && !activation && !unlock && until > now && until - now <= RENEW_REMINDER_MS
  useHoldNotices(due)
  if (!due) return null
  const close = () => {
    dismissRenewToday()
    setClosed(true)
  }
  return (
    <div className="ads-back renew-reminder" role="status">
      <p className="ads-back__text">Your ad-free ends on {lagosDate(status!.adFreeUntil!)}. Renew to keep watching without ads.</p>
      <a
        className="ads-back__ok"
        href={buyLink(AD_FREE_PLANS[0], user?.email)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          holdAdsThisTap()
          close()
        }}
      >
        Renew
      </a>
      <button type="button" className="renew-reminder__close" aria-label="Close" onClick={close}>
        <X aria-hidden="true" />
      </button>
    </div>
  )
}
