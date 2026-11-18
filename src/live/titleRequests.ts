/**
 * "🔔 Request this title" (server/live/requests.ts): a title that's on no
 * server ("No server found"). Sent with the live counter's random device id,
 * and the account's access token when signed in (so we can email them when
 * it's added). The titles this device asked for are remembered, so the
 * button says "Requested" next time.
 */
import { accessToken } from '../account/client'
import { sessionId } from './heartbeat'

const REQUESTED_KEY = 'naijatr.requestedTitles'
const KEEP = 200

export interface TitleRequestInput {
  /** "movie:550" or "tv:1399". */
  item: string
  title: string
  /** Series: "s1e3". */
  ep: string | null
}

export type RequestOutcome = { ok: true; email: boolean } | { ok: false; reason: 'limit' | 'failed' }

function readRequested(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(REQUESTED_KEY) ?? '[]') as unknown
    return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** True if this device has requested the title. */
export const hasRequested = (item: string) => readRequested().includes(item)

function remember(item: string) {
  try {
    const list = [item, ...readRequested().filter((x) => x !== item)].slice(0, KEEP)
    localStorage.setItem(REQUESTED_KEY, JSON.stringify(list))
  } catch {
    // Asked again next time.
  }
}

export async function requestTitle(input: TitleRequestInput, fetchImpl: typeof fetch = fetch): Promise<RequestOutcome> {
  try {
    const token = await accessToken()
    const response = await fetchImpl('/api/live/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...input, title: input.title.slice(0, 120), device: sessionId() }),
    })
    if (response.status === 429) return { ok: false, reason: 'limit' }
    if (!response.ok) return { ok: false, reason: 'failed' }
    const body = (await response.json().catch(() => null)) as { email?: unknown } | null
    remember(input.item)
    return { ok: true, email: body?.email === true }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
