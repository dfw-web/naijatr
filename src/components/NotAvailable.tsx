import { useEffect, useRef, useState } from 'react'
import { hasRequested, requestTitle, type TitleRequestInput } from '../live/titleRequests'
import { isTvMode } from '../tv/tvMode'

type Status = 'idle' | 'sending' | 'done' | 'limit' | 'failed'

export interface TitleRequestState {
  status: Status
  done: boolean
  sending: boolean
  send: () => void
}

/** The request for one title: "Requested" straight away if this device asked before. */
export function useTitleRequest(input: TitleRequestInput | null): TitleRequestState {
  const item = input?.item ?? null
  const [state, setState] = useState<{ item: string | null; status: Status }>(() => ({
    item,
    status: item && hasRequested(item) ? 'done' : 'idle',
  }))
  // Another title (or episode's series): its own state.
  if (state.item !== item) setState({ item, status: item && hasRequested(item) ? 'done' : 'idle' })
  const status = state.item === item ? state.status : 'idle'
  const send = () => {
    if (!input || status === 'sending' || status === 'done') return
    setState({ item: input.item, status: 'sending' })
    void requestTitle(input).then((outcome) =>
      setState((now) => (now.item !== input.item ? now : { item: input.item, status: outcome.ok ? 'done' : outcome.reason })),
    )
  }
  return { status, done: status === 'done', sending: status === 'sending', send }
}

/**
 * Under the player (never over it) when the title is on no server: what
 * "No server found" means, "🔔 Request this title" and "Watch something
 * similar". Inside the player section, so no tap reaches an ad script.
 */
export function NotAvailable({ request, onSimilar }: { request: TitleRequestState; onSimilar?: () => void }) {
  // TV: the remote lands on Request (the player has just left fullscreen).
  const requestRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!isTvMode()) return
    // Once the player has settled out of fullscreen (it puts the remote on the video).
    const timer = window.setTimeout(() => requestRef.current?.focus(), 300)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <section className="player__missing" aria-labelledby="player-missing-title">
      <h3 id="player-missing-title" className="player__missing-title">
        <span aria-hidden="true">😔 </span>Not available on NAIJA TR yet
      </h3>
      <p className="player__missing-text">
        ‘No server found’ means this title isn’t available on any of our servers right now, so there’s no need to switch servers.
        It’s usually added later, especially new releases.
      </p>
      <div className="player__missing-actions">
        <button ref={requestRef} type="button" className="btn btn--primary" onClick={request.send} disabled={request.sending || request.done}>
          {request.done ? (
            <>
              <span aria-hidden="true">✅ </span>Requested
            </>
          ) : (
            <>
              <span aria-hidden="true">🔔 </span>
              {request.sending ? 'Requesting…' : 'Request this title'}
            </>
          )}
        </button>
        {onSimilar && (
          <button type="button" className="btn btn--ghost" onClick={onSimilar}>
            Watch something similar
          </button>
        )}
      </div>
      <p className="player__missing-status" role="status">
        {request.done
          ? 'Thanks! Your request is saved.'
          : request.status === 'limit'
            ? 'You’ve sent a lot of requests today. Please try again tomorrow.'
            : request.status === 'failed'
              ? 'Couldn’t send your request. Please try again.'
              : ''}
      </p>
    </section>
  )
}
