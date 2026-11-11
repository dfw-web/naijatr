/**
 * OpenSubtitles (api.opensubtitles.com, REST v1) and SubDL (api.subdl.com):
 * searching, ranking and downloading. Keys stay here, server-side.
 */

export const OS_API = 'https://api.opensubtitles.com/api/v1'
export const SUBDL_API = 'https://api.subdl.com/api/v1/subtitles'
export const SUBDL_DL = 'https://dl.subdl.com'
/** OpenSubtitles wants a User-Agent naming the client. */
export const USER_AGENT = 'SubtitleFetcher v1.0'
const TIMEOUT_MS = 8000
/** All result pages are read, up to this many (each page is 50-60 results). */
export const MAX_PAGES = 10

export interface Candidate {
  provider: 'opensubtitles' | 'subdl'
  /** OpenSubtitles file_id, or SubDL's zip URL. */
  ref: string
  lang: string
  downloads: number
  hearingImpaired: boolean
  machine: boolean
  release: string
}

export interface Episode {
  season: number
  episode: number
}

/** What the search knows about the title, from TMDB. */
export interface TitleInfo {
  type: 'movie' | 'tv'
  tmdbId: number
  imdbId: string | null
  title: string
  originalTitle: string
  year: number | null
  anime: boolean
  /** Episodes per regular season (index = season number), for absolute numbering. */
  seasonEpisodes: number[]
}

export type Fetch = typeof fetch

const signal = () => AbortSignal.timeout(TIMEOUT_MS)

/** OpenSubtitles redirects (and charges a request) unless the query is sorted and lower-case. */
export function osQuery(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    // Spaces as "+", the way it redirects to.
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
    .join('&')
}

const normTitle = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export const sameTitle = (a: string, b: string) => {
  const x = normTitle(a)
  const y = normTitle(b)
  return x !== '' && (x === y || x === y.replace(/^the /, '') || y === x.replace(/^the /, ''))
}

interface OsFeature {
  title?: string
  movie_name?: string
  parent_title?: string
  year?: number
  season_number?: number
  episode_number?: number
  feature_type?: string
}

interface OsSubtitle {
  attributes?: {
    language?: string
    download_count?: number
    hearing_impaired?: boolean
    machine_translated?: boolean
    ai_translated?: boolean
    release?: string
    feature_details?: OsFeature
    files?: { file_id?: number }[]
  }
}

export interface OsSearch {
  /** Search parameters, without page. */
  params: Record<string, string | number | undefined>
  /** Keeps only results that are really this title (query searches). */
  accept?: (feature: OsFeature) => boolean
}

export class QuotaError extends Error {}

/** Every page of an OpenSubtitles search, as candidates. */
export async function searchOpenSubtitles(apiKey: string, search: OsSearch, fetchImpl: Fetch): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchImpl(`${OS_API}/subtitles?${osQuery({ ...search.params, page })}`, {
      headers: { 'Api-Key': apiKey, 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: signal(),
    })
    if (response.status === 429) throw new QuotaError('opensubtitles rate limit')
    if (!response.ok) break
    const body = (await response.json()) as { data?: OsSubtitle[]; total_pages?: number }
    for (const item of body.data ?? []) {
      const a = item.attributes
      const fileId = a?.files?.[0]?.file_id
      if (!a || !fileId) continue
      if (search.accept && !search.accept(a.feature_details ?? {})) continue
      out.push({
        provider: 'opensubtitles',
        ref: String(fileId),
        lang: (a.language ?? '').toLowerCase(),
        downloads: a.download_count ?? 0,
        hearingImpaired: Boolean(a.hearing_impaired),
        machine: Boolean(a.machine_translated || a.ai_translated),
        release: (a.release ?? '').normalize('NFKC'),
      })
    }
    if (page >= (body.total_pages ?? 1)) break
  }
  return out
}

export interface OsToken {
  token: string
  /** The API host the login says to use for downloads (VIP accounts get their own). */
  base: string
}

export async function loginOpenSubtitles(apiKey: string, username: string, password: string, fetchImpl: Fetch): Promise<OsToken | null> {
  const response = await fetchImpl(`${OS_API}/login`, {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: signal(),
  })
  if (!response.ok) return null
  const body = (await response.json()) as { token?: string; base_url?: string }
  if (!body.token) return null
  const host = (body.base_url ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return { token: body.token, base: host ? `https://${host}/api/v1` : OS_API }
}

export interface OsDownload {
  bytes: Uint8Array
  remaining: number | null
  resetAt: string | null
}

/**
 * Downloads one OpenSubtitles file. QuotaError when today's downloads are used
 * up; 'unauthorized' when the token has expired.
 */
export async function downloadOpenSubtitles(apiKey: string, token: OsToken | null, fileId: string, fetchImpl: Fetch): Promise<OsDownload | 'unauthorized' | null> {
  const headers: Record<string, string> = { 'Api-Key': apiKey, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token.token}`
  const response = await fetchImpl(`${token?.base ?? OS_API}/download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_id: Number(fileId) }),
    signal: signal(),
  })
  if (response.status === 401) return 'unauthorized'
  const body = (await response.json().catch(() => ({}))) as { link?: string; remaining?: number; reset_time_utc?: string; message?: string }
  if (response.status === 406 || response.status === 429 || (!response.ok && /quota|limit/i.test(body.message ?? ''))) {
    throw new QuotaError(body.message ?? 'opensubtitles download quota')
  }
  if (!response.ok || !body.link) return null
  const file = await fetchImpl(body.link, { headers: { 'User-Agent': USER_AGENT }, signal: signal() })
  if (!file.ok) return null
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    remaining: typeof body.remaining === 'number' ? body.remaining : null,
    resetAt: body.reset_time_utc ?? null,
  }
}

/** Our language codes (OpenSubtitles': en, fr, pt-br, zh-cn) ↔ SubDL's (EN, FR, BR_PT, ZH). */
export function subdlLang(code: string): string {
  const special: Record<string, string> = { 'pt-br': 'BR_PT', 'pt-pt': 'PT', 'zh-cn': 'ZH', 'zh-tw': 'ZH_BG' }
  return special[code] ?? code.slice(0, 2).toUpperCase()
}

export function fromSubdlLang(code: string): string {
  const special: Record<string, string> = { BR_PT: 'pt-br', ZH_BG: 'zh-tw', ZH: 'zh-cn' }
  const upper = code.toUpperCase()
  return special[upper] ?? upper.slice(0, 2).toLowerCase()
}

interface SubdlSubtitle {
  release_name?: string
  name?: string
  language?: string
  lang?: string
  url?: string
  season?: number | null
  episode?: number | null
  episode_from?: number | null
  episode_end?: number | null
  full_season?: boolean
  hi?: boolean
}

export interface SubdlSearch {
  params: Record<string, string | number | undefined>
  episode?: Episode
}

/** Every page of a SubDL search, as candidates (exact episodes first, then season packs). */
export async function searchSubdl(apiKey: string, search: SubdlSearch, fetchImpl: Fetch): Promise<Candidate[]> {
  const exact: Candidate[] = []
  const packs: Candidate[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ api_key: apiKey, subs_per_page: '30', page: String(page) })
    for (const [k, v] of Object.entries(search.params)) if (v !== undefined && v !== '') query.set(k, String(v))
    const response = await fetchImpl(`${SUBDL_API}?${query}`, { headers: { Accept: 'application/json' }, signal: signal() })
    if (!response.ok) break
    const body = (await response.json()) as { status?: boolean; subtitles?: SubdlSubtitle[]; totalPages?: number }
    if (!body.status) break
    for (const s of body.subtitles ?? []) {
      if (!s.url || !subdlPath(s.url)) continue
      const ep = search.episode
      if (ep && s.season && s.season !== ep.season) continue
      // A pack of episodes 1-6 is listed as episode 1, its range in episode_from / episode_end.
      const from = s.episode_from ?? s.episode ?? null
      const to = s.episode_end && from && s.episode_end >= from ? s.episode_end : from
      const inRange = ep !== undefined && from !== null && to !== null && ep.episode >= from && ep.episode <= to
      if (ep && s.episode && !inRange && !s.full_season) continue
      const candidate: Candidate = {
        provider: 'subdl',
        // The path only: SubDL's URL carries our API key in its query, and versions go to the browser.
        ref: subdlPath(s.url),
        lang: fromSubdlLang(s.language ?? s.lang ?? ''),
        downloads: 0,
        hearingImpaired: Boolean(s.hi) || /\b(HI|SDH)\b/.test(`${s.release_name ?? ''} ${s.name ?? ''}`),
        machine: /machine|auto[- ]?translat|google translat/i.test(`${s.release_name ?? ''} ${s.name ?? ''}`.normalize('NFKC')),
        release: (s.release_name ?? s.name ?? '').normalize('NFKC'),
      }
      ;(ep && (s.full_season || !s.episode || from !== to) ? packs : exact).push(candidate)
    }
    if (page >= (body.totalPages ?? 1)) break
  }
  return [...exact, ...packs]
}

const SUBDL_PATH = /^\/subtitle\/[\w.-]+\.zip$/

/** "/subtitle/3595858-8513190.zip" from SubDL's url (its query, with the API key, dropped); '' when it isn't one. */
export function subdlPath(url: string): string {
  const path = (url.startsWith('/') ? url : `/${url}`).split('?')[0]
  return SUBDL_PATH.test(path) ? path : ''
}

export async function downloadSubdl(path: string, apiKey: string, fetchImpl: Fetch): Promise<Uint8Array | null> {
  if (!SUBDL_PATH.test(path)) return null
  const response = await fetchImpl(`${SUBDL_DL}${path}?api_key=${encodeURIComponent(apiKey)}`, { signal: signal() })
  if (!response.ok) return null
  return new Uint8Array(await response.arrayBuffer())
}

/** The release's source, for "Version 2 (WEB-DL)". */
export function releaseTag(release: string): string | null {
  const tags: [RegExp, string][] = [
    [/web[-. ]?dl/i, 'WEB-DL'],
    [/web[-. ]?rip/i, 'WEBRip'],
    [/blu[-. ]?ray|bdrip|brrip|\bbd\b/i, 'BluRay'],
    [/hdtv/i, 'HDTV'],
    [/dvd[-. ]?rip|\bdvd\b/i, 'DVD'],
    [/hd[-. ]?rip/i, 'HDRip'],
    [/\b(nf|netflix)\b/i, 'Netflix'],
    [/\b(amzn|amazon)\b/i, 'Amazon'],
    [/\bweb\b/i, 'WEB'],
  ]
  for (const [pattern, tag] of tags) if (pattern.test(release)) return tag
  return null
}

/**
 * Best first: people's own subtitles before machine/AI translations, not
 * hearing-impaired before hearing-impaired, then most downloads. (A search's
 * HI-only or machine-only result still comes through: it's the only one.)
 */
export function rank(candidates: Candidate[]): Candidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Number(a.c.machine) - Number(b.c.machine) || Number(a.c.hearingImpaired) - Number(b.c.hearingImpaired) || b.c.downloads - a.c.downloads || a.i - b.i)
    .map(({ c }) => c)
}
