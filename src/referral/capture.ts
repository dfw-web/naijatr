import { sessionId } from '../live/heartbeat'

/**
 * Runs first thing on every page load (the first import in main.tsx), before
 * anything else writes to storage, so it can tell a new device from a
 * returning one.
 *
 * - Any earlier NAIJA TR visit leaves "naijatr…" keys in localStorage or
 *   cookies; without any, this device is new.
 * - /r/CODE (an invite link) keeps the code for 7 days (localStorage and a
 *   cookie), tells the server about the arrival, and moves on to the home page.
 *   The first link a device opens is the one that counts.
 */

export const REF_KEY = 'naijatr.ref'
const SEEN_KEY = 'naijatr.seen'
const REF_COOKIE = 'naijatr_ref'
export const INVITED_KEY = 'naijatr.ref.invited'
export const REF_TTL_MS = 7 * 24 * 60 * 60 * 1000
const INVITE_PATH = /^\/r\/([A-Za-z0-9]{4,12})\/?$/
const INVITE_QUERY = /[?&]ref=([A-Za-z0-9]{4,12})(?:&|$)/

export interface PendingRef {
  code: string
  at: number
  newDevice: boolean
  reported: boolean
  /** The contest (its start) it was reported for: a new contest reports it again. */
  reportedFor?: number | null
}

function priorVisit(): boolean {
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      if (window.localStorage.key(i)?.startsWith('naijatr')) return true
    }
  } catch {
    // Storage blocked: go by cookies.
  }
  return /(^|;\s*)naijatr/.test(document.cookie)
}

export function readRef(): PendingRef | null {
  try {
    const ref = JSON.parse(window.localStorage.getItem(REF_KEY) ?? 'null') as PendingRef | null
    return ref && typeof ref.code === 'string' && Date.now() - ref.at < REF_TTL_MS ? ref : null
  } catch {
    return null
  }
}

export function saveRef(ref: PendingRef) {
  try {
    window.localStorage.setItem(REF_KEY, JSON.stringify(ref))
  } catch {
    // The cookie still has the code.
  }
}

/** Whether this visit came in by an invite link (the popup says so). */
export function arrivedByInvite() {
  try {
    return window.sessionStorage.getItem(INVITED_KEY) === '1'
  } catch {
    return false
  }
}

/** ?preview=contest: shows the contest's popup, banner and guide on this device only, without starting it. */
export const PREVIEW_KEY = 'naijatr.contest.preview'

export function isContestPreview() {
  try {
    return window.sessionStorage.getItem(PREVIEW_KEY) === '1'
  } catch {
    return false
  }
}

export function captureReferral(path = window.location.pathname) {
  if (new URLSearchParams(window.location.search).get('preview') === 'contest') {
    try {
      window.sessionStorage.setItem(PREVIEW_KEY, '1')
      // Show the popup again on each preview.
      window.sessionStorage.removeItem('naijatr.contest.popup')
    } catch {
      // No preview without storage.
    }
  }
  const prior = priorVisit()
  try {
    window.localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Fine.
  }
  // ?ref=CODE is the same link after the redirect below, e.g. reopened from an in-app browser in Chrome.
  const match = INVITE_PATH.exec(path) ?? (path === '/' ? INVITE_QUERY.exec(window.location.search) : null)
  if (!match) return
  const code = match[1].toUpperCase()
  try {
    window.sessionStorage.setItem(INVITED_KEY, '1')
  } catch {
    // Only changes the popup's wording.
  }
  if (!readRef()) {
    saveRef({ code, at: Date.now(), newDevice: !prior, reported: false })
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${REF_COOKIE}=${code}; Path=/; Max-Age=${REF_TTL_MS / 1000}; SameSite=Lax${secure}`
    void fetch('/api/referral/arrive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, device: sessionId(), newDevice: !prior }),
      keepalive: true,
    }).catch(() => {})
  }
  // Keeps the code in the address bar: "Open in Chrome" from Telegram or WhatsApp starts a new browser with its own storage.
  const search = new URLSearchParams(window.location.search)
  search.set('ref', code)
  window.history.replaceState(null, '', `/?${search}`)
}

captureReferral()
