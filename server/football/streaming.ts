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
/** Pages of live matches read at most (20 each): a busy Saturday has 75+ in play, and a featured match can be on page 4. */
const MAX_PAGES = 8
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
  homeLogo?: string
  awayLogo?: string
  leagueLogo?: string
  /** Kept from the previous list, which this read skipped (see withMissed). */
  missed?: boolean
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

/**
 * Lighter feeds first: "_lsd" ones run at about 0.8 Mbps and "_lhd" at about
 * 1.6, while others can be 1080p60 at 4 Mbps, too much for many phones. The
 * player starts with Server 1 and moves on if it can't keep up.
 */
const weight = (url: string) => (isEnglish(url) ? -1 : /_lsd\b/i.test(url) ? 0 : /_lhd\b/i.test(url) ? 1 : 2)

/** Feeds tagged English in their path ("/live/hd-en-….m3u8"): first in the list, and named so. */
const isEnglish = (url: string) => /(^|[-_/])en([-_.]|$)/i.test(new URL(url).pathname)

export const serverLabel = (url: string, index: number) => `Server ${index + 1}${isEnglish(url) ? ' (English)' : ''}`

function directHls(servers: unknown): StreamSource[] {
  if (!Array.isArray(servers)) return []
  const found: { url: string }[] = []
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
    found.push({ url: url.href })
  }
  return found
    .map((s, index) => ({ ...s, index }))
    .sort((a, b) => weight(a.url) - weight(b.url) || a.index - b.index)
    .slice(0, MAX_SERVERS)
    .map(({ url }, i) => ({ label: serverLabel(url, i), url, kind: 'hls' as const }))
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
    homeLogo: logo(item.home_team_logo),
    awayLogo: logo(item.away_team_logo),
    leagueLogo: logo(item.league_logo),
  }
}

/** An https image, but not the provider's "no logo" placeholder. */
function logo(value: unknown) {
  const url = str(value)
  return url && url.startsWith('https://') && !/nologo/i.test(url) ? url : undefined
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

/** GET with the key; the parsed body, or null on any failure. Never throws. */
async function getJson(key: string, path: string, fetchImpl: typeof fetch): Promise<Json | null> {
  try {
    const response = await fetchImpl(`${STREAMING_ORIGIN}${path}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': STREAMING_HOST, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return isObject(body) ? body : null
  } catch {
    return null
  }
}

/** League listing pages read at most (20 each). */
const MAX_LEAGUE_PAGES = 40

/** Every league name the API has matches for (it lists some under two names, e.g. "Spanish La Liga" and "Spain La Liga"). */
export async function fetchStreamingLeagues(key: string, fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  const names: string[] = []
  for (let page = 1; page <= MAX_LEAGUE_PAGES; page += 1) {
    const body = await getJson(key, `/leagues?page=${page}`, fetchImpl)
    if (!body || !Array.isArray(body.leagues)) return names.length ? names : null
    for (const league of body.leagues) {
      const name = isObject(league) ? str(league.name) : null
      if (name) names.push(name)
    }
    const pagination = isObject(body.pagination) ? body.pagination : {}
    if (pagination.hasNext !== true) break
  }
  return names
}

/** Pages read per league: its filter matches any league containing the name ("Premier League" also brings Kenya's, Wales'…). */
const MAX_LEAGUE_MATCH_PAGES = 15

/** One league's matches, live and upcoming (the API keeps about the next two days, and no results). Null on failure. */
export async function fetchStreamingLeague(key: string, league: string, fetchImpl: typeof fetch = fetch): Promise<StreamingMatch[] | null> {
  const matches: StreamingMatch[] = []
  for (let page = 1; page <= MAX_LEAGUE_MATCH_PAGES; page += 1) {
    const body = await getJson(key, `/matches?league=${encodeURIComponent(league)}${page > 1 ? `&page=${page}` : ''}`, fetchImpl)
    if (!body || !Array.isArray(body.matches)) return page > 1 ? matches : null
    for (const item of body.matches) {
      const match = parseStreamingMatch(item)
      if (match?.league === league) matches.push(match)
    }
    const pagination = isObject(body.pagination) ? body.pagination : {}
    if (pagination.hasNext !== true) break
  }
  return matches
}
