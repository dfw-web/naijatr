/**
 * Football Live Stream API (RapidAPI) client for the match "Watch" tab. Used
 * only by server/football/handlers.ts, so RAPIDAPI_KEY is read and sent on the
 * server and never reaches the browser or any response body.
 *
 * The provider's listing is fetched once (and cached by the caller) and each
 * of our matches is paired with it by team names, since the two providers do
 * not share match ids. Its response shape is parsed defensively: anything
 * missing or unrecognised just means "no stream available".
 */

export const STREAM_ORIGIN = 'https://football-live-stream-api.p.rapidapi.com'
const STREAM_HOST = new URL(STREAM_ORIGIN).host

/** Upstream path of the provider's match listing ({ result: [...] }). */
export const STREAM_LISTING_PATH = '/all-match'

/** Upstream path of one listed match's stream link ({ url }), by the provider's id. */
const streamLinkPath = (id: string) => `/link/${encodeURIComponent(id)}`

const UPSTREAM_TIMEOUT_MS = 10000

export function readRapidApiKey(env: Record<string, string | undefined>) {
  return env.RAPIDAPI_KEY?.trim() ?? ''
}

export type StreamKind = 'embed' | 'hls' | 'link'

export interface StreamSource {
  label: string
  url: string
  kind: StreamKind
}

export interface CommentaryLine {
  minute: string | null
  text: string
}

/** What /api/football/stream sends to the browser. */
/** The provider's live status line for the match, when it lists it. */
export interface StreamStatus {
  status: string | null
  score: string | null
  minute: string | null
}

export interface MatchStream {
  available: boolean
  streams: StreamSource[]
  commentary: CommentaryLine[]
  status: StreamStatus | null
  /** The provider's own match id, used to ask for its stream link. Not sent to the browser. */
  providerId?: string
}

export const NO_STREAM: MatchStream = { available: false, streams: [], commentary: [], status: null }

export type StreamFetchResult =
  | { ok: true; items: unknown[] }
  | { ok: false; reason: 'rate-limited' | 'auth' | 'upstream-error' | 'unreachable' }

/** One upstream call. Never throws; never includes the key in what it returns. */
async function callStreamApi(key: string, path: string, fetchImpl: typeof fetch): Promise<
  { ok: true; body: unknown } | { ok: false; reason: 'rate-limited' | 'auth' | 'upstream-error' | 'unreachable' }
> {
  let upstream: Response
  try {
    upstream = await fetchImpl(`${STREAM_ORIGIN}${path}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': STREAM_HOST, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (upstream.status === 429) return { ok: false, reason: 'rate-limited' }
  if (upstream.status === 401 || upstream.status === 403) return { ok: false, reason: 'auth' }
  if (!upstream.ok) return { ok: false, reason: 'upstream-error' }
  try {
    return { ok: true, body: await upstream.json() }
  } catch {
    return { ok: false, reason: 'upstream-error' }
  }
}

/** The provider's match listing. */
export async function fetchStreamListing(key: string, fetchImpl: typeof fetch = fetch): Promise<StreamFetchResult> {
  const result = await callStreamApi(key, STREAM_LISTING_PATH, fetchImpl)
  return result.ok ? { ok: true, items: listFrom(result.body) } : result
}

/**
 * One listed match's stream sources. The provider usually answers { url: "" },
 * so an empty list here is normal and never an error.
 */
export async function fetchStreamLink(key: string, providerId: string, fetchImpl: typeof fetch = fetch) {
  const result = await callStreamApi(key, streamLinkPath(providerId), fetchImpl)
  return result.ok && isObject(result.body) ? collectStreams(result.body) : []
}

/**
 * Whether an HLS link answers with a playlist. The provider's links wrap the
 * source in its own relay (?url=<playlist>), so both are tried. A dead source
 * answers 403, or the relay passes on its error page instead of a playlist.
 * Unreachable or slow counts as not playing too: it only means asking the
 * provider for its link again sooner.
 */
export async function hlsPlays(url: string, fetchImpl: typeof fetch = fetch) {
  const candidates = [url]
  try {
    const inner = new URL(url).searchParams.get('url')
    if (inner && new URL(inner).protocol === 'https:') candidates.push(inner)
  } catch {
    // Not a URL: nothing to try.
  }
  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (response.ok && (await response.text()).trimStart().startsWith('#EXTM3U')) return true
    } catch {
      // Try the next address.
    }
  }
  return false
}

const PROBE_TIMEOUT_MS = 6000

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The match array, whether the body is the array itself or wraps it. */
function listFrom(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (!isObject(body)) return []
  for (const key of ['data', 'matches', 'response', 'result', 'results', 'events', 'items']) {
    const value = body[key]
    if (Array.isArray(value)) return value
    if (isObject(value)) {
      const nested = listFrom(value)
      if (nested.length) return nested
    }
  }
  return []
}

/** First string found under any of `keys` (a string, or an object with a name). */
function pickName(item: Json, keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (isObject(value)) {
      const name = value.name ?? value.team_name ?? value.teamName ?? value.title
      if (typeof name === 'string' && name.trim()) return name.trim()
    }
  }
  return null
}

const HOME_KEYS = ['home_team', 'homeTeam', 'home', 'team1', 'team_home', 'home_name', 'homeName', 'localteam']
const AWAY_KEYS = ['away_team', 'awayTeam', 'away', 'team2', 'team_away', 'away_name', 'awayName', 'visitorteam']

function teamsOf(item: Json): [string, string] | null {
  let home = pickName(item, HOME_KEYS)
  let away = pickName(item, AWAY_KEYS)
  if ((!home || !away) && isObject(item.teams)) {
    home ??= pickName(item.teams, HOME_KEYS)
    away ??= pickName(item.teams, AWAY_KEYS)
  }
  if (!home || !away) {
    const title = [item.title, item.name, item.match, item.match_name].find((v) => typeof v === 'string')
    const parts = typeof title === 'string' ? title.split(/\s+(?:vs\.?|v|-|–)\s+/i) : []
    if (parts.length === 2) [home, away] = [parts[0].trim(), parts[1].trim()]
  }
  return home && away ? [home, away] : null
}

const NOISE = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'ss', 'cd', 'fk', 'sk', 'bk', 'club', 'de', 'the', 'calcio', 'sv', 'vfb', 'vfl', 'as', 'rc', 'ud', 'sd', 'ca'])

/** Lowercase words without accents, punctuation or "FC"-style affixes. */
function words(name: string) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NOISE.has(w))
}

/** Loose team-name match: "Man United" ~ "Manchester United FC", "Inter" ~ "Inter Milan". */
export function sameTeam(a: string, b: string) {
  const x = words(a)
  const y = words(b)
  if (!x.length || !y.length) return false
  const joinedX = x.join(' ')
  const joinedY = y.join(' ')
  if (joinedX === joinedY || joinedX.includes(joinedY) || joinedY.includes(joinedX)) return true
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x]
  return shorter.every((w) => longer.some((v) => v === w || (w.length >= 3 && v.startsWith(w)) || (v.length >= 3 && w.startsWith(v))))
}

/** Same team, or at least the same distinctive first word ("Mahasarakham United" ~ "Mahasarakham SBT"). */
function nearTeam(a: string, b: string) {
  if (sameTeam(a, b)) return true
  const [x] = words(a)
  const [y] = words(b)
  return Boolean(x && x.length >= 4 && x === y)
}

const URL_KEYS = ['url', 'link', 'src', 'stream', 'stream_url', 'streamUrl', 'embed', 'embed_url', 'embedUrl', 'iframe', 'm3u8', 'hls']
const LIST_KEYS = ['streams', 'links', 'servers', 'sources', 'stream_links', 'streamLinks', 'channels']

/** Only absolute https URLs are passed on, so nothing else can be embedded. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  // Some providers put a whole <iframe src="..."> in the field.
  const fromIframe = /src=["']([^"']+)["']/i.exec(trimmed)?.[1]
  try {
    const url = new URL(fromIframe ?? trimmed)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function kindOf(url: string, hint: string): StreamKind {
  if (/\.m3u8(\?|$)/i.test(url) || /hls|m3u8/i.test(hint)) return 'hls'
  if (/embed|iframe|player/i.test(`${hint} ${url}`)) return 'embed'
  return 'link'
}

function collectStreams(item: Json): StreamSource[] {
  const found: StreamSource[] = []
  const add = (value: unknown, label: unknown, hint: string) => {
    const url = safeUrl(value)
    if (!url || found.some((s) => s.url === url)) return
    found.push({
      label: typeof label === 'string' && label.trim() ? label.trim() : `Stream ${found.length + 1}`,
      url,
      kind: kindOf(url, hint),
    })
  }
  for (const key of URL_KEYS) add(item[key], null, key)
  for (const key of LIST_KEYS) {
    const list = item[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (typeof entry === 'string') add(entry, null, key)
      else if (isObject(entry)) {
        const label = entry.name ?? entry.label ?? entry.title ?? entry.server ?? entry.language
        for (const urlKey of URL_KEYS) add(entry[urlKey], label, `${urlKey} ${String(entry.type ?? '')}`)
      }
    }
  }
  return found.slice(0, 10)
}

const COMMENTARY_KEYS = ['commentary', 'commentaries', 'comments', 'live_commentary', 'liveCommentary', 'timeline', 'events']

function collectCommentary(item: Json): CommentaryLine[] {
  for (const key of COMMENTARY_KEYS) {
    const list = item[key]
    if (!Array.isArray(list) || !list.length) continue
    const lines: CommentaryLine[] = []
    for (const entry of list) {
      if (typeof entry === 'string' && entry.trim()) {
        lines.push({ minute: null, text: entry.trim() })
      } else if (isObject(entry)) {
        const text = [entry.text, entry.comment, entry.commentary, entry.description, entry.message, entry.detail].find(
          (v) => typeof v === 'string' && v.trim(),
        )
        if (typeof text !== 'string') continue
        const minute = entry.minute ?? entry.time ?? entry.elapsed ?? entry.min
        lines.push({
          minute: typeof minute === 'number' || (typeof minute === 'string' && minute.trim()) ? String(minute).trim() : null,
          text: text.trim().slice(0, 1000),
        })
      }
    }
    if (lines.length) return lines.slice(0, 200)
  }
  return []
}

/** Finds our match (by home and away team names) in the provider's listing. */
export function findMatchStream(items: unknown[], home: string, away: string): MatchStream {
  for (const item of items) {
    if (!isObject(item)) continue
    const teams = teamsOf(item)
    if (!teams) continue
    const [h, a] = teams
    // One team must match closely; the other may differ in suffixes ("United" vs "SBT FC").
    const pairs = (x: string, y: string) =>
      (sameTeam(x, home) && nearTeam(y, away)) || (nearTeam(x, home) && sameTeam(y, away))
    const matches = pairs(h, a) || pairs(a, h)
    if (!matches) continue
    const streams = collectStreams(item)
    const commentary = collectCommentary(item)
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : null
    return {
      available: streams.length > 0 || commentary.length > 0,
      streams,
      commentary,
      status: { status: text(item.status), score: text(item.score), minute: text(item.currentMinutes ?? item.minute) },
      providerId: text(item.id) ?? undefined,
    }
  }
  return NO_STREAM
}

/*
 * Fallback match data. When API-Football is unavailable, the provider's
 * listing is turned into API-Football-shaped fixtures, so the Football section
 * keeps showing matches, scores and streams. Its ids are strings, so they are
 * mapped into a numeric range API-Football never uses (from 9,000,000,000),
 * which keeps every route and link unchanged.
 */

export const PROVIDER_MATCH_BASE = 9_000_000_000

/** FNV-1a, for stable numeric ids from the provider's string ids and names. */
function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export const providerMatchId = (id: string) => PROVIDER_MATCH_BASE + (hash(id) % 999_999_999)
export const isProviderMatchId = (id: number) => id >= PROVIDER_MATCH_BASE

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

const STATUS: Record<string, { short: string; long: string }> = {
  live: { short: 'LIVE', long: 'In Play' },
  finished: { short: 'FT', long: 'Match Finished' },
  upcoming: { short: 'NS', long: 'Not Started' },
}

/** One provider listing entry as an API-Football fixture, or null if it lacks teams or an id. */
export function providerFixture(item: unknown) {
  if (!isObject(item)) return null
  const providerId = str(item.id)
  const teams = teamsOf(item)
  if (!providerId || !teams) return null
  const [homeName, awayName] = teams
  const status = STATUS[(str(item.status) ?? '').toLowerCase()] ?? { short: 'TBD', long: str(item.status) ?? 'Unknown' }
  const started = status.short !== 'NS' && status.short !== 'TBD'
  const [home, away] = (str(item.score) ?? '').split('-').map((n) => Number.parseInt(n, 10))
  const goals = started && Number.isFinite(home) && Number.isFinite(away) ? { home, away } : { home: null, away: null }
  const kickoff = Date.parse(str(item.kickoff) ?? `${str(item.date)}T${str(item.time) ?? '00:00:00'}Z`)
  const date = Number.isNaN(kickoff) ? new Date(0) : new Date(kickoff)
  const minute = Number.parseInt(String(item.currentMinutes ?? ''), 10)
  const league = str(item.league) ?? 'Other matches'
  const winner = (mine: number | null, theirs: number | null) =>
    status.short === 'FT' && mine !== null && theirs !== null ? (mine === theirs ? null : mine > theirs) : null
  return {
    fixture: {
      id: providerMatchId(providerId),
      date: date.toISOString(),
      timestamp: Math.floor(date.getTime() / 1000),
      status: { ...status, elapsed: status.short === 'LIVE' && Number.isFinite(minute) ? minute : null },
    },
    league: { id: PROVIDER_MATCH_BASE + (hash(league) % 999_999_999), name: league, country: '', logo: '' },
    teams: {
      home: { id: hash(homeName), name: homeName, logo: str(item.home_flag) ?? '', winner: winner(goals.home, goals.away) },
      away: { id: hash(awayName), name: awayName, logo: str(item.away_flag) ?? '', winner: winner(goals.away, goals.home) },
    },
    goals,
    events: [],
    lineups: [],
    statistics: [],
  }
}

export type ProviderFixture = NonNullable<ReturnType<typeof providerFixture>>

/** The listing as fixtures, with each one's provider id. */
export function providerFixtures(items: unknown[]) {
  const out: { fixture: ProviderFixture; providerId: string }[] = []
  for (const item of items) {
    const fixture = providerFixture(item)
    if (fixture && isObject(item)) out.push({ fixture, providerId: String(item.id).trim() })
  }
  return out
}
