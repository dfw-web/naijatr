import { useEffect, useState } from 'react'
import { contestOn, countdownTarget, endLabel, fetchClaim, fetchLeaderboard, naira, sendClaim, useContest, useCountdown, type Leaderboard } from './api'
import { TelegramLogin } from './Invite'
import { OPEN_GUIDE_KEY } from './guide'
import { useReferralSession } from './session'
import './invite.css'
import './challenge.css'

/**
 * The challenge pages, a separate root like Football:
 * /challenge (live leaderboard), /challenge/rules and /challenge/claim (winners only).
 */

export default function ChallengeApp() {
  const path = window.location.pathname.replace(/\/+$/, '')
  return (
    <div className="challenge">
      <header className="challenge__header">
        <a href="/" className="challenge__home">
          <img src="/favicon.svg" alt="" /> NAIJA TR
        </a>
        <nav className="challenge__nav" aria-label="Challenge">
          <a href="/challenge" aria-current={path === '/challenge' ? 'page' : undefined}>
            Leaderboard
          </a>
          <a href="/challenge/rules" aria-current={path === '/challenge/rules' ? 'page' : undefined}>
            Rules
          </a>
        </nav>
      </header>
      <main className="challenge__main">{path === '/challenge/rules' ? <Rules /> : path === '/challenge/claim' ? <Claim /> : <Board />}</main>
    </div>
  )
}

const MEDALS = ['🥇', '🥈', '🥉']

function Board() {
  const contest = useContest()
  const signedIn = useReferralSession()
  const [board, setBoard] = useState<Leaderboard | null>(null)
  const countdown = useCountdown(contestOn(contest) ? countdownTarget(contest) : null)
  useEffect(() => {
    let active = true
    const load = () =>
      void fetchLeaderboard().then((data) => {
        if (active && data) setBoard(data)
      })
    load()
    // Live: refresh every 30 seconds.
    const timer = window.setInterval(load, 30_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [signedIn])
  if (!contest) return <p className="challenge__muted">Loading…</p>
  const live = contestOn(contest)
  const inTop = board?.top.some((row) => row.me)
  return (
    <>
      <h1 className="challenge__title">{live ? 'NAIJA TR Invite Challenge 🏆' : 'Invite Challenge'}</h1>
      {live && (
        <>
          <p className="challenge__prizes">{contest.prizes!.map((p, i) => `${MEDALS[i]} ${naira(p)}`).join(' · ')}</p>
          <p className="invite-countdown">
            ⏳ {contest.phase === 'upcoming' ? `Starts in ${countdown} · ${endLabel(contest.start!)}` : `${countdown} · ends ${endLabel(contest.end!)}`}
          </p>
        </>
      )}
      {contest.phase === 'upcoming' && <p className="challenge__muted">The challenge hasn’t started yet: get your link now, points count from the start.</p>}
      {(contest.phase === 'ended' || contest.phase === 'off') && (
        <p className="challenge__muted">
          {contest.winners ? `🏆 Winners: 🥇${contest.winners[0]} · 🥈${contest.winners[1]} · 🥉${contest.winners[2]}. Thanks to everyone who joined! 🙏` : 'The challenge has ended. Thanks to everyone who joined! 🙏'}
        </p>
      )}
      <ol className="challenge__board" aria-label="Top 10">
        {board?.top.map((row) => (
          <li key={row.rank} className={row.me ? 'challenge__row challenge__row--me' : 'challenge__row'}>
            <span className="challenge__rank">{row.rank <= 3 ? MEDALS[row.rank - 1] : `#${row.rank}`}</span>
            <span className="challenge__name">
              {row.name}
              {row.me && ' (you)'}
            </span>
            <span className="challenge__points">{row.points} pts</span>
            {live && row.rank <= 3 && <span className="challenge__prize">{naira(contest.prizes![row.rank - 1])}</span>}
          </li>
        ))}
      </ol>
      {board && board.top.length === 0 && <p className="challenge__muted">No points yet. Be the first!</p>}
      {board?.me && !inTop && (
        <p className="challenge__me">
          You: {board.me.rank ? `#${board.me.rank}` : 'not ranked yet'} · {board.me.points} pts
        </p>
      )}
      <a className="btn btn--primary challenge__cta" href="/" onClick={(e) => (e.preventDefault(), openFromHome())}>
        Get my invite link
      </a>
    </>
  )
}

/** The guide lives on the movie pages: go there and open it. */
function openFromHome() {
  try {
    window.sessionStorage.setItem(OPEN_GUIDE_KEY, '1')
  } catch {
    // Opens the home page anyway.
  }
  window.location.assign('/')
}

function Rules() {
  const contest = useContest()
  return (
    <article className="challenge__rules">
      <h1 className="challenge__title">Invite Challenge: full rules</h1>
      <ol>
        <li>Free to enter, no purchase needed. One account per person.</li>
        <li>
          The top 3 by verified referrals win
          {contest?.prizes ? ` (🥇 ${naira(contest.prizes[0])} · 🥈 ${naira(contest.prizes[1])} · 🥉 ${naira(contest.prizes[2])})` : ''}; ties go to whoever
          reached the score first.
        </li>
        <li>
          A referral is verified only when a friend opens your link on a new phone and then watches a movie or an episode of a series on NAIJA TR during the challenge
          {contest?.end && contest.phase !== 'off' ? ` (it ends ${endLabel(contest.end)}, Lagos time)` : ''}. Only opening the link,
          browsing, or watching a trailer or live football doesn’t count, and neither does opening your own link or using the same phone twice.
        </li>
        <li>Fake/bot referrals are disqualified; NAIJA TR’s decision is final.</li>
        <li>Each winner must claim within 48 hours, or the prize passes to the next eligible person.</li>
        <li>Prizes are paid by transfer to a Nigerian bank account (or a mobile money account in Nigeria) within 3 working days.</li>
      </ol>
    </article>
  )
}

function Claim() {
  const signedIn = useReferralSession()
  const token = new URLSearchParams(window.location.search).get('t') ?? ''
  const [claim, setClaim] = useState<{ place: string; amount: number } | 'expired' | null>(null)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'bad' | 'failed'>('idle')
  useEffect(() => {
    if (!signedIn || !token) return
    let active = true
    void fetchClaim(token).then(({ data }) => {
      if (active) setClaim(data ?? 'expired')
    })
    return () => {
      active = false
    }
  }, [signedIn, token])

  if (!token) return <p className="challenge__muted">This claim link isn’t complete. Use the link from @naijatr_bot.</p>
  if (!signedIn) {
    return (
      <>
        <h1 className="challenge__title">Claim your prize</h1>
        <p>Sign in with the same Telegram account that won.</p>
        <TelegramLogin />
      </>
    )
  }
  if (!claim) return <p className="challenge__muted">Checking your link…</p>
  if (claim === 'expired') return <p className="challenge__muted">This link has expired, was already used, or belongs to another account.</p>
  if (state === 'sent') return <p className="challenge__done">✅ Got it! We’ll send your {naira(claim.amount)} within 3 working days. Your details are deleted once you’re paid.</p>
  return (
    <>
      <h1 className="challenge__title">
        🎉 You placed {claim.place}: {naira(claim.amount)}
      </h1>
      <p className="challenge__muted">Where should we send it? Only NAIJA TR’s admin can see this, and it’s deleted after payment.</p>
      <form
        className="challenge__form"
        onSubmit={(event) => {
          event.preventDefault()
          const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>
          setState('sending')
          void sendClaim({ t: token, ...data }).then(({ status }) => setState(status === 200 ? 'sent' : status === 400 ? 'bad' : 'failed'))
        }}
      >
        <label>
          Account name
          <input name="accountName" required maxLength={80} autoComplete="name" />
        </label>
        <label>
          Bank or mobile-money provider
          <input name="provider" required maxLength={60} placeholder="e.g. GTBank, OPay, Moniepoint" />
        </label>
        <label>
          Account number
          <input name="accountNumber" required inputMode="numeric" pattern="\d{6,20}" maxLength={20} />
        </label>
        <label>
          Phone number
          <input name="phone" required inputMode="tel" maxLength={20} autoComplete="tel" />
        </label>
        {state === 'bad' && <p className="invite-error" role="alert">Please check the details (account number: digits only).</p>}
        {state === 'failed' && <p className="invite-error" role="alert">Couldn’t send it. Please try again.</p>}
        <button type="submit" className="btn btn--primary" disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Send my details'}
        </button>
      </form>
    </>
  )
}
