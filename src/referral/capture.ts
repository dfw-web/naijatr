/**
 * Invite links: https://www.naijatr.com/r/CODE (or /?ref=CODE). Runs first
 * thing on every page load (the first import in main.tsx). The code is kept
 * for 7 days, in localStorage and a cookie, and the visitor moves on to the
 * home page. The first link a device opens is the one that counts; it's sent
 * to the server once they have an account (status.ts → claimReferral).
 */

export const REF_KEY = 'naijatr.ref'
const REF_COOKIE = 'naijatr_ref'
export const REF_TTL_MS = 7 * 24 * 60 * 60 * 1000
const INVITE_PATH = /^\/r\/([A-Za-z0-9]{4,12})\/?$/
const INVITE_QUERY = /[?&]ref=([A-Za-z0-9]{4,12})(?:&|$)/

export interface PendingRef {
  code: string
  /** When the link was opened. */
  at: number
}

function fromCookie(): PendingRef | null {
  const match = /(?:^|;\s*)naijatr_ref=([A-Z0-9]{4,12})\.(\d{10,16})/.exec(document.cookie)
  return match ? { code: match[1], at: Number(match[2]) } : null
}

/** The invite code this device came by, if it's under 7 days old. */
export function readRef(now = Date.now()): PendingRef | null {
  let ref: PendingRef | null = null
  try {
    ref = JSON.parse(window.localStorage.getItem(REF_KEY) ?? 'null') as PendingRef | null
  } catch {
    ref = null
  }
  ref = ref && typeof ref.code === 'string' && typeof ref.at === 'number' ? ref : fromCookie()
  return ref && now - ref.at < REF_TTL_MS ? ref : null
}

/** Sent to the server (or no longer needed): forgotten on this device. */
export function clearRef() {
  try {
    window.localStorage.removeItem(REF_KEY)
  } catch {
    // The cookie goes too.
  }
  document.cookie = `${REF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

export function captureReferral(path = window.location.pathname, now = Date.now()) {
  // ?ref=CODE is the same link after the redirect below, e.g. reopened from an in-app browser in Chrome.
  const match = INVITE_PATH.exec(path) ?? (path === '/' ? INVITE_QUERY.exec(window.location.search) : null)
  if (!match) return
  const code = match[1].toUpperCase()
  if (!readRef(now)) {
    const ref: PendingRef = { code, at: now }
    try {
      window.localStorage.setItem(REF_KEY, JSON.stringify(ref))
    } catch {
      // The cookie still has it.
    }
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${REF_COOKIE}=${code}.${now}; Path=/; Max-Age=${REF_TTL_MS / 1000}; SameSite=Lax${secure}`
  }
  // Keeps the code in the address bar: "Open in Chrome" from Telegram or WhatsApp starts a new browser with its own storage.
  const search = new URLSearchParams(window.location.search)
  search.set('ref', code)
  window.history.replaceState(null, '', `/?${search}`)
}

captureReferral()
