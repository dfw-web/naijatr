/**
 * Football Live Streaming API (RapidAPI, football-live-streaming-api), the
 * main source of match streams. Its one endpoint, GET /matches, lists matches
 * with their stream servers inline; `?status=live` narrows it to the matches
 * in play (usually one page of 20), so one request covers every live match.
 *
 * Only "direct" HLS (.m3u8) servers are passed on: they play in the browser
 * as they are. "referer" servers need headers a browser can't send, "drm"
 * ones can't be played, and .flv isn't HLS.
 *
 * Used only on the server, so RAPIDAPI_KEY never reaches the browser.
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { StreamSource } from './stream.js'

export const STREAMING_ORIGIN = 'https://football-live-streaming-api.p.rapidapi.com'
const STREAMING_HOST = new URL(STREAMING_ORIGIN).host
const TIMEOUT_MS = 10_000
/** Pages of live matches read at most (20 each). */
const MAX_PAGES = 3
/** Servers offered per match. */
const MAX_SERVERS = 8

export interface StreamingMatch {
  /** Stable id for this listing entry: league, teams and kick-off. */
  key: string
  home: string
  away: string
  league: string
  /** Kick-off, epoch ms (0 when unknown). */
  kickoff: number
  live: boolean
  score: string | null
  streams: StreamSource[]
}

export interface StreamingQuota {
  limit: number
  remaining: number
}

export type StreamingResult =
  | { ok: true; matches: StreamingMatch[]; quota: StreamingQuota | null; requests: number; status: number }
  | { ok: false; reason: 'rate-limited' | 'auth' | 'upstream-error' | 'unreachable'; quota: StreamingQuota | null; requests: number; status: number }

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

function directHls(servers: unknown): StreamSource[] {
  if (!Array.isArray(servers)) return []
  const found: StreamSource[] = []
  for (const server of servers) {
    if (!isObject(server) || server.type !== 'direct') continue
    const raw = str(server.url)
    if (!raw) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || !/\.m3u8$/i.test(url.pathname)) continue
    if (found.some((s) => s.url === url.href)) continue
    found.push({ label: `Server ${found.length + 1}`, url: url.href, kind: 'hls' })
    if (found.length >= MAX_SERVERS) break
  }
  return found
}

/** One listing entry, or null without both teams. */
export function parseStreamingMatch(item: unknown): StreamingMatch | null {
  if (!isObject(item)) return null
  const home = str(item.home_team_name)
  const away = str(item.away_team_name)
  if (!home || !away) return null
  const league = str(item.league_name) ?? ''
  const seconds = Number(item.match_time)
  const kickoff = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
  const homeScore = str(String(item.homeTeamScore ?? ''))
  const awayScore = str(String(item.awayTeamScore ?? ''))
  return {
    key: `${league}|${home}|${away}|${kickoff}`,
    home,
    away,
    league,
    kickoff,
    live: item.match_status === 'live',
    score: homeScore !== null && awayScore !== null ? `${homeScore} - ${awayScore}` : null,
    streams: directHls(item.servers),
  }
}

function quotaFrom(headers: Headers): StreamingQuota | null {
  const limit = Number(headers.get('x-ratelimit-requests-limit'))
  const remaining = Number(headers.get('x-ratelimit-requests-remaining'))
  return Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && headers.has('x-ratelimit-requests-remaining')
    ? { limit, remaining }
    : null
}

/** The live matches, every page (up to MAX_PAGES). Never throws; never returns the key. */
export async function fetchStreamingLive(key: string, fetchImpl: typeof fetch = fetch): Promise<StreamingResult> {
  const matches: StreamingMatch[] = []
  let quota: StreamingQuota | null = null
  let requests = 0
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let response: Response
    requests += 1
    try {
      response = await fetchImpl(`${STREAMING_ORIGIN}/matches?status=live${page > 1 ? `&page=${page}` : ''}`, {
        headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': STREAMING_HOST, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return { ok: false, reason: 'unreachable', quota, requests, status: 0 }
    }
    quota = quotaFrom(response.headers) ?? quota
    const status = response.status
    if (status === 429) return { ok: false, reason: 'rate-limited', quota, requests, status }
    if (status === 401 || status === 403) return { ok: false, reason: 'auth', quota, requests, status }
    let body: unknown
    try {
      body = response.ok ? await response.json() : null
    } catch {
      body = null
    }
    if (!isObject(body) || !Array.isArray(body.matches)) return { ok: false, reason: 'upstream-error', quota, requests, status }
    for (const item of body.matches) {
      const match = parseStreamingMatch(item)
      if (match?.live) matches.push(match)
    }
    const pagination = isObject(body.pagination) ? body.pagination : {}
    if (pagination.hasNext !== true) return { ok: true, matches, quota, requests, status }
  }
  return { ok: true, matches, quota, requests, status: 200 }
}
