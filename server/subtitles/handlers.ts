import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readRedisEnv, redis, type Command, type RedisEnv } from '../redis.js'
import { readTmdbCredentials, type TmdbCredentials } from '../handlers.js'
import { decodeSubtitle, pickZipFile, toVtt, unzip } from './format.js'
import {
  downloadOpenSubtitles,
  downloadSubdl,
  loginOpenSubtitles,
  QuotaError,
  rank,
  releaseTag,
  sameTitle,
  searchOpenSubtitles,
  searchSubdl,
  subdlLang,
  type Candidate,
  type Episode,
  type Fetch,
  type OsSearch,
  type OsToken,
  type SubdlSearch,
  type TitleInfo,
} from './providers.js'

/**
 * /api/subtitles: external subtitles for the player overlay, free for everyone.
 *
 * - GET /api/subtitles?tmdbId=&type=movie|tv&season=&episode=&lang=en → WebVTT
 *   (404 { error: 'not-found' } when there's none). Cached in Upstash for 30
 *   days (subs:{tmdbId}:{s}:{e}:{lang}), "not found" for 24 hours. On a miss
 *   the steps in `steps()` run in order until one finds something.
 * - GET /api/subtitles/languages?tmdbId=&type=&season=&episode= → the
 *   languages there are subtitles in ({ languages: [{ code, name }] }).
 * - GET /api/subtitles?…&version=os:123 → that file instead ("Try another version").
 * - GET /api/subtitles/versions?… → up to 6 files for the episode, the one playing first.
 * - POST /api/subtitles/vote { …, version, offset, speed } → after 3 different viewers
 *   pick the same setting, it's the episode's default (served with X-Subtitle-Offset/-Speed).
 * - POST /api/subtitles/report → "Subtitles out of sync?", listed on /admin/live.
 * - GET /api/subtitles/admin, POST admin-flush?tmdbId= (ADMIN_PASSWORD) → /admin/live.
 *
 * OPENSUBTITLES_API_KEY, OPENSUBTITLES_USERNAME / _PASSWORD and SUBDL_API_KEY
 * are read here only (never from src/), so they never reach the browser.
 */

export interface SubtitlesEnv {
  enabled: boolean
  osKey: string
  osUser: string
  osPass: string
  subdlKey: string
  tmdb: TmdbCredentials
  redis: RedisEnv
  adminPassword: string
  salt: string
}

export function readSubtitlesEnv(env: Record<string, string | undefined>): SubtitlesEnv {
  return {
    enabled: (env.SUBTITLES_ENABLED ?? '').trim().toLowerCase() === 'true',
    osKey: env.OPENSUBTITLES_API_KEY?.trim() ?? '',
    osUser: env.OPENSUBTITLES_USERNAME?.trim() ?? '',
    osPass: env.OPENSUBTITLES_PASSWORD ?? '',
    subdlKey: env.SUBDL_API_KEY?.trim() ?? '',
    tmdb: readTmdbCredentials(env),
    redis: readRedisEnv(env),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    salt: env.REFERRAL_SALT ?? env.NAIJATR_GATE_SECRET ?? 'subs',
  }
}

const DAY_S = 24 * 60 * 60
export const FOUND_TTL_S = 30 * DAY_S
export const NOT_FOUND_TTL_S = DAY_S
const TITLE_TTL_S = 7 * DAY_S
const TOKEN_TTL_S = 23 * 60 * 60
const STATS_TTL_S = 40 * DAY_S
/** Per IP: any requests a minute, and new searches (cache misses: they use the quota) per 10 minutes. */
export const RATE_LIMITS = { perMinute: 60, missesPer10Min: 12, feedbackPer10Min: 10 }
/** Downloads tried per step before moving on (a broken file, a pack without the episode). */
const TRIES_PER_STEP = 3
const LAGOS_OFFSET_MS = 60 * 60 * 1000

const LANG = /^[a-z]{2}(-[a-z]{2})?$/
const ID = /^[1-9]\d{0,9}$/

export interface SubtitleRequest {
  type: 'movie' | 'tv'
  tmdbId: number
  episode: Episode | null
  lang: string
}

export function parseRequest(params: URLSearchParams, needLang = true): SubtitleRequest | null {
  const type = params.get('type')
  const id = params.get('tmdbId') ?? ''
  const lang = (params.get('lang') ?? 'en').toLowerCase()
  if ((type !== 'movie' && type !== 'tv') || !ID.test(id) || (needLang && !LANG.test(lang))) return null
  let episode: Episode | null = null
  if (type === 'tv') {
    const s = params.get('season') ?? ''
    const e = params.get('episode') ?? ''
    if (!/^\d{1,4}$/.test(s) || !ID.test(e)) return null
    episode = { season: Number(s), episode: Number(e) }
  }
  return { type, tmdbId: Number(id), episode, lang }
}

/** "{tmdbId}:{season}:{episode}:{lang}": one episode (or movie) in one language. */
export const slotOf = (r: SubtitleRequest) => `${r.tmdbId}:${r.episode?.season ?? 0}:${r.episode?.episode ?? 0}:${r.lang}`
export const cacheKey = (r: SubtitleRequest) => `subs:${slotOf(r)}`
const versionKey = (r: SubtitleRequest, version: string) => `subs:v:${slotOf(r)}:${version}`
const versionsKey = (r: SubtitleRequest) => `subs:versions:${slotOf(r)}`
const defaultKey = (r: SubtitleRequest) => `subs:default:${slotOf(r)}`
const langsKey = (r: SubtitleRequest) => `subs:langs:${r.type}:${r.tmdbId}:${r.episode?.season ?? 0}:${r.episode?.episode ?? 0}`

export const lagosDay = (now: number) => new Date(now + LAGOS_OFFSET_MS).toISOString().slice(0, 10)
const statsKey = (now: number) => `subs:stats:${lagosDay(now)}`

export interface Deps {
  fetch: Fetch
  now: () => number
  log: (message: string) => void
}

const defaultDeps: Deps = { fetch, now: Date.now, log: (m) => console.info(m) }

// ——— Redis helpers (all best-effort: no Redis, no cache) ———

async function get(env: SubtitlesEnv, key: string, f: Fetch): Promise<string | null> {
  const r = await redis(env.redis, [['GET', key]], f)
  return typeof r?.[0] === 'string' ? (r[0] as string) : null
}

function stat(env: SubtitlesEnv, now: number, fields: Record<string, number>, f: Fetch, extra: Command[] = []) {
  const key = statsKey(now)
  const commands: Command[] = Object.entries(fields).map(([field, n]) => ['HINCRBY', key, field, n])
  return redis(env.redis, [...commands, ...extra, ['EXPIRE', key, STATS_TTL_S]], f)
}

/** Counts this IP's requests; false once it's over a limit. Open when Redis is down. */
const ipHash = (env: SubtitlesEnv, ip: string) => createHash('sha256').update(`subs:${env.salt}:${ip}`).digest('hex').slice(0, 16)

async function allowed(env: SubtitlesEnv, ip: string, bucket: 'all' | 'miss' | 'feedback', now: number, f: Fetch): Promise<boolean> {
  const hash = ipHash(env, ip)
  const windowS = bucket === 'all' ? 60 : 600
  const limit = bucket === 'all' ? RATE_LIMITS.perMinute : bucket === 'miss' ? RATE_LIMITS.missesPer10Min : RATE_LIMITS.feedbackPer10Min
  const key = `subs:rl:${bucket}:${hash}:${Math.floor(now / 1000 / windowS)}`
  const r = await redis(env.redis, [['INCR', key], ['EXPIRE', key, windowS]], f)
  return typeof r?.[0] !== 'number' || (r[0] as number) <= limit
}

// ——— TMDB ———

async function tmdb(env: SubtitlesEnv, path: string, f: Fetch): Promise<Record<string, unknown> | null> {
  const url = new URL(`https://api.themoviedb.org/3${path}`)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (env.tmdb.readToken) headers.Authorization = `Bearer ${env.tmdb.readToken}`
  else url.searchParams.set('api_key', env.tmdb.apiKey)
  try {
    const response = await f(url, { headers, signal: AbortSignal.timeout(8000) })
    return response.ok ? ((await response.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function titleInfo(env: SubtitlesEnv, r: SubtitleRequest, f: Fetch): Promise<TitleInfo | null> {
  const key = `subs:title:${r.type}:${r.tmdbId}`
  const cached = await get(env, key, f)
  if (cached) return JSON.parse(cached) as TitleInfo
  const body = await tmdb(env, `/${r.type}/${r.tmdbId}?append_to_response=external_ids`, f)
  if (!body) return null
  const ext = (body.external_ids ?? {}) as { imdb_id?: string | null }
  const date = String((r.type === 'movie' ? body.release_date : body.first_air_date) ?? '')
  const genres = (body.genres as { id: number }[] | undefined) ?? []
  const countries = (body.origin_country as string[] | undefined) ?? []
  const seasons = (body.seasons as { season_number: number; episode_count: number }[] | undefined) ?? []
  const seasonEpisodes: number[] = []
  for (const s of seasons) if (s.season_number > 0) seasonEpisodes[s.season_number] = s.episode_count
  const info: TitleInfo = {
    type: r.type,
    tmdbId: r.tmdbId,
    imdbId: (ext.imdb_id ?? (body.imdb_id as string | undefined) ?? null) || null,
    title: String((r.type === 'movie' ? body.title : body.name) ?? ''),
    originalTitle: String((r.type === 'movie' ? body.original_title : body.original_name) ?? ''),
    year: /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null,
    anime: genres.some((g) => g.id === 16) && (body.original_language === 'ja' || countries.includes('JP')),
    seasonEpisodes,
  }
  await redis(env.redis, [['SET', key, JSON.stringify(info), 'EX', TITLE_TTL_S]], f)
  return info
}

/** An episode's number counted from the first episode of season 1 (anime is often numbered that way). */
export function absoluteEpisode(info: TitleInfo, ep: Episode): number | null {
  if (ep.season <= 1) return null
  let total = 0
  for (let s = 1; s < ep.season; s++) {
    const n = info.seasonEpisodes[s]
    if (!n) return null
    total += n
  }
  return total + ep.episode
}

// ——— The search steps ———

export interface Step {
  name: string
  provider: 'opensubtitles' | 'subdl'
  /** Pack files are matched by this episode (absolute numbering included). */
  zipEpisode?: Episode & { absolute?: number }
  search: (lang: string | null) => OsSearch | SubdlSearch
}

const imdbNumber = (id: string | null) => (id ? String(Number(id.replace(/^tt/, ''))) : '')

/** The searches, in order. `lang` null: every language (the languages endpoint). */
export function steps(info: TitleInfo, ep: Episode | null): Step[] {
  const imdb = imdbNumber(info.imdbId)
  const titles = [...new Set([info.title, info.originalTitle].filter(Boolean))]
  const out: Step[] = []
  const os = (name: string, params: OsSearch['params'], accept?: OsSearch['accept']) =>
    out.push({ name, provider: 'opensubtitles', zipEpisode: ep ?? undefined, search: (lang) => ({ params: { ...params, languages: lang ?? undefined }, accept }) })
  const subdl = (name: string, params: SubdlSearch['params'], episode: Episode | undefined = ep ?? undefined, absolute?: number) =>
    out.push({
      name,
      provider: 'subdl',
      zipEpisode: ep ? { ...ep, absolute } : undefined,
      search: (lang) => ({ params: { ...params, languages: lang ? subdlLang(lang) : undefined }, episode }),
    })
  const absolute = ep && info.anime ? absoluteEpisode(info, ep) : null

  if (!ep) {
    os('opensubtitles:tmdb', { tmdb_id: info.tmdbId, type: 'movie' })
    if (imdb) os('opensubtitles:imdb', { imdb_id: imdb, type: 'movie' })
    for (const title of titles) {
      if (info.year) {
        os('opensubtitles:title+year', { query: title, year: info.year, type: 'movie' }, (f) =>
          sameTitle(f.title ?? f.movie_name ?? '', title) && (!f.year || Math.abs(f.year - info.year!) <= 1),
        )
      }
    }
    for (const title of titles) os('opensubtitles:title', { query: title, type: 'movie' }, (f) => sameTitle(f.title ?? f.movie_name ?? '', title))
    subdl('subdl:tmdb', { tmdb_id: info.tmdbId, type: 'movie' })
    if (info.imdbId) subdl('subdl:imdb', { imdb_id: info.imdbId, type: 'movie' })
    for (const title of titles) subdl('subdl:title', { film_name: title, type: 'movie', year: info.year ?? undefined })
    return out
  }

  const se = { season_number: ep.season, episode_number: ep.episode }
  const isEpisode = (f: { season_number?: number; episode_number?: number }) =>
    (!f.season_number || f.season_number === ep.season) && (!f.episode_number || f.episode_number === ep.episode)
  os('opensubtitles:tmdb', { parent_tmdb_id: info.tmdbId, ...se, type: 'episode' }, isEpisode)
  if (imdb) os('opensubtitles:imdb', { parent_imdb_id: imdb, ...se, type: 'episode' }, isEpisode)
  for (const title of titles) {
    os('opensubtitles:title', { query: title, ...se, type: 'episode' }, (f) => isEpisode(f) && sameTitle(f.parent_title ?? f.title ?? '', title))
  }
  if (info.anime) {
    // Anime counted from the first episode: OpenSubtitles may keep the real season (S2E29), put it all in
    // season 1 (S1E29), or file TMDB's one long season under several (TMDB S1E30 = S2E30): any season, that number.
    const n = absolute ?? ep.episode
    const isN = (f: { episode_number?: number }) => !f.episode_number || f.episode_number === n
    if (absolute) {
      for (const season of [...new Set([ep.season, 1])]) {
        os('opensubtitles:anime-absolute', { parent_tmdb_id: info.tmdbId, season_number: season, episode_number: n, type: 'episode' }, isN)
      }
    }
    os('opensubtitles:anime-any-season', { parent_tmdb_id: info.tmdbId, episode_number: n, type: 'episode' }, isN)
    if (imdb) os('opensubtitles:anime-any-season', { parent_imdb_id: imdb, episode_number: n, type: 'episode' }, isN)
    for (const title of titles) {
      os('opensubtitles:anime-title', { query: title, episode_number: n, type: 'episode' }, (f) => isN(f) && sameTitle(f.parent_title ?? f.title ?? '', title))
    }
  }
  const tv = { type: 'tv', ...se }
  subdl('subdl:tmdb', { tmdb_id: info.tmdbId, ...tv })
  if (info.imdbId) subdl('subdl:imdb', { imdb_id: info.imdbId, ...tv })
  for (const title of titles) subdl('subdl:title', { film_name: title, ...tv })
  if (absolute) {
    for (const season of [...new Set([ep.season, 1])]) {
      subdl('subdl:anime-absolute', { tmdb_id: info.tmdbId, type: 'tv', season_number: season, episode_number: absolute }, { season, episode: absolute }, absolute)
    }
  }
  return out
}

// ——— OpenSubtitles session and daily limit ———

const TOKEN_KEY = 'subs:os:token'
const limitKey = (now: number) => `subs:os:limited:${new Date(now).toISOString().slice(0, 10)}`

async function osToken(env: SubtitlesEnv, deps: Deps, fresh = false): Promise<OsToken | null> {
  if (!env.osUser || !env.osPass) return null
  if (!fresh) {
    const cached = await get(env, TOKEN_KEY, deps.fetch)
    if (cached) return JSON.parse(cached) as OsToken
  }
  const token = await loginOpenSubtitles(env.osKey, env.osUser, env.osPass, deps.fetch).catch(() => null)
  if (token) await redis(env.redis, [['SET', TOKEN_KEY, JSON.stringify(token), 'EX', TOKEN_TTL_S]], deps.fetch)
  else deps.log('[subtitles] OpenSubtitles login failed: downloads go without a token')
  return token
}

/** OpenSubtitles is out of downloads (or searches) until its daily reset (UTC midnight): SubDL only. */
async function markLimited(env: SubtitlesEnv, deps: Deps, now: number) {
  const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1)
  const ttl = Math.max(60, Math.ceil((midnight - now) / 1000))
  await stat(env, now, { osLimited: 1 }, deps.fetch, [['SET', limitKey(now), '1', 'EX', ttl], ['HSET', statsKey(now), 'osRemaining', 0]])
  deps.log('[subtitles] OpenSubtitles daily limit reached: SubDL only until reset')
}

// ——— Finding and downloading ———

/** A subtitle file the browser can ask for again: "os:{file_id}" or "sd:/subtitle/….zip" (no key in it). */
export const versionId = (c: Pick<Candidate, 'provider' | 'ref'>) => `${c.provider === 'opensubtitles' ? 'os' : 'sd'}:${c.ref}`
export const VERSION_ID = /^(os:\d{1,12}|sd:\/subtitle\/[\w.-]{1,120}\.zip)$/
const candidateOf = (id: string): Pick<Candidate, 'provider' | 'ref'> | null =>
  VERSION_ID.test(id) ? { provider: id.startsWith('os:') ? 'opensubtitles' : 'subdl', ref: id.slice(3) } : null

/** The speeds the menu offers (subtitles timed for one frame rate, video at another). */
export const SPEEDS = ['1', '23.976-25', '25-23.976', '24-25', '25-24'] as const

export interface Found {
  vtt: string
  step: string
  provider: 'opensubtitles' | 'subdl'
  version: string
}

/** The episode a pack's file is matched by (anime: its absolute number too). */
const zipEpisodeOf = (r: SubtitleRequest, info: TitleInfo) =>
  r.episode ? { ...r.episode, absolute: info.anime ? (absoluteEpisode(info, r.episode) ?? undefined) : undefined } : undefined

interface OsState {
  token?: OsToken | null
  off: boolean
}

async function download(
  env: SubtitlesEnv,
  deps: Deps,
  c: Pick<Candidate, 'provider' | 'ref'>,
  zipEpisode: (Episode & { absolute?: number }) | undefined,
  now: number,
  os: OsState,
): Promise<string | null> {
  let bytes: Uint8Array | null = null
  if (c.provider === 'opensubtitles') {
    if (os.off) return null
    try {
      if (os.token === undefined) os.token = await osToken(env, deps)
      let result = await downloadOpenSubtitles(env.osKey, os.token, c.ref, deps.fetch)
      if (result === 'unauthorized') {
        os.token = await osToken(env, deps, true)
        result = await downloadOpenSubtitles(env.osKey, os.token, c.ref, deps.fetch)
      }
      if (result && result !== 'unauthorized') {
        bytes = result.bytes
        if (result.remaining !== null) {
          await redis(env.redis, [['HSET', statsKey(now), 'osRemaining', result.remaining], ['EXPIRE', statsKey(now), STATS_TTL_S]], deps.fetch)
          if (result.remaining <= 0) await markLimited(env, deps, now)
        }
      }
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error
      os.off = true
      await markLimited(env, deps, now)
      return null
    }
  } else {
    const zip = await downloadSubdl(c.ref, env.subdlKey, deps.fetch)
    if (zip) {
      try {
        bytes = pickZipFile(unzip(zip), zipEpisode)?.data ?? null
      } catch {
        bytes = zip
      }
    }
  }
  return bytes ? toVtt(decodeSubtitle(bytes)) : null
}

const osOffNow = async (env: SubtitlesEnv, deps: Deps) => !env.osKey || (await get(env, limitKey(deps.now()), deps.fetch)) === '1'

const matchesLang = (c: Candidate, lang: string) => c.lang === lang || (lang.length === 2 && c.lang.slice(0, 2) === lang)

/** One search step's candidates in `lang`, ranked. [] on any failure (a quota error turns OpenSubtitles off). */
async function runStep(env: SubtitlesEnv, deps: Deps, step: Step, lang: string, os: OsState): Promise<Candidate[]> {
  if (step.provider === 'opensubtitles' && os.off) return []
  if (step.provider === 'subdl' && !env.subdlKey) return []
  try {
    const search = step.search(lang)
    const found =
      step.provider === 'opensubtitles'
        ? await searchOpenSubtitles(env.osKey, search as OsSearch, deps.fetch)
        : await searchSubdl(env.subdlKey, search as SubdlSearch, deps.fetch)
    return rank(found.filter((c) => matchesLang(c, lang)))
  } catch (error) {
    if (error instanceof QuotaError) {
      os.off = true
      await markLimited(env, deps, deps.now())
    }
    return []
  }
}

/** Runs the steps until one gives a subtitle in `lang`. Machine translations only when nothing else exists. */
export async function findSubtitle(env: SubtitlesEnv, r: SubtitleRequest, info: TitleInfo, deps: Deps): Promise<Found | null> {
  const now = deps.now()
  const os: OsState = { off: await osOffNow(env, deps) }
  const zipEpisode = zipEpisodeOf(r, info)
  const machineOnly: { c: Candidate; step: Step }[] = []
  const tryAll = async (list: { c: Candidate; step: Step }[]): Promise<Found | null> => {
    for (const { c, step } of list) {
      const episode = step.zipEpisode ? { ...step.zipEpisode, absolute: step.zipEpisode.absolute ?? zipEpisode?.absolute } : zipEpisode
      const vtt = await download(env, deps, c, episode, now, os).catch(() => null)
      if (vtt) return { vtt, step: step.name, provider: c.provider, version: versionId(c) }
    }
    return null
  }
  for (const step of steps(info, r.episode)) {
    const ranked = await runStep(env, deps, step, r.lang, os)
    machineOnly.push(...ranked.filter((c) => c.machine).map((c) => ({ c, step })))
    const hit = await tryAll(ranked.filter((c) => !c.machine).slice(0, TRIES_PER_STEP).map((c) => ({ c, step })))
    if (hit) return hit
  }
  return tryAll(machineOnly.slice(0, TRIES_PER_STEP))
}

export interface Version {
  id: string
  label: string
  provider: 'opensubtitles' | 'subdl'
  release: string
}

/** How many versions the menu lists: the one playing, and up to 5 others. */
export const MAX_VERSIONS = 6

/** Files for this episode and language, from OpenSubtitles and SubDL (the first step of each that finds any). */
export async function findVersions(env: SubtitlesEnv, r: SubtitleRequest, info: TitleInfo, deps: Deps): Promise<Omit<Version, 'label'>[]> {
  const os: OsState = { off: await osOffNow(env, deps) }
  const byProvider: Partial<Record<Candidate['provider'], Candidate[]>> = {}
  for (const step of steps(info, r.episode)) {
    if (byProvider[step.provider]?.length) continue
    const ranked = await runStep(env, deps, step, r.lang, os)
    if (ranked.length) byProvider[step.provider] = ranked
    if (byProvider.opensubtitles?.length && byProvider.subdl?.length) break
  }
  const all = [...(byProvider.opensubtitles ?? []), ...(byProvider.subdl ?? [])]
  const human = all.filter((c) => !c.machine)
  const pool = rank(human.length ? human : all)
  // Both providers in the list when both have some: each one's best, then the rest.
  const firsts = [byProvider.opensubtitles?.find((c) => pool.includes(c)), byProvider.subdl?.find((c) => pool.includes(c))].filter((c): c is Candidate => Boolean(c))
  const seen = new Set<string>()
  const out: Omit<Version, 'label'>[] = []
  for (const c of [...firsts, ...pool]) {
    const id = versionId(c)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, provider: c.provider, release: c.release.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 90) })
    if (out.length >= MAX_VERSIONS * 2) break
  }
  return out
}

/** "Version 2 (WEB-DL)". */
export const labelVersions = (list: Omit<Version, 'label'>[]): Version[] =>
  list.map((v, i) => ({ ...v, label: `Version ${i + 1} (${releaseTag(v.release) ?? (v.provider === 'opensubtitles' ? 'OpenSubtitles' : 'SubDL')})` }))

/** The languages there are subtitles in: the first step with any results, every page. */
export async function findLanguages(env: SubtitlesEnv, r: SubtitleRequest, info: TitleInfo, deps: Deps): Promise<string[]> {
  const osOff = await osOffNow(env, deps)
  const langs = new Set<string>()
  for (const step of steps(info, r.episode)) {
    if (step.provider === 'opensubtitles' && osOff) continue
    if (step.provider === 'subdl' && !env.subdlKey) continue
    // One step from each provider is enough for the list; title searches are for finding, not listing.
    if (/title/.test(step.name) && langs.size) break
    try {
      const search = step.search(null)
      const found =
        step.provider === 'opensubtitles'
          ? await searchOpenSubtitles(env.osKey, search as OsSearch, deps.fetch)
          : await searchSubdl(env.subdlKey, search as SubdlSearch, deps.fetch)
      for (const c of found) if (LANG.test(c.lang)) langs.add(c.lang)
    } catch {
      // Next step.
    }
    if (langs.size) break
  }
  return [...langs]
}

// ——— Community sync ———

/** This many different viewers settling on the same version + offset + speed makes it the episode's default. */
export const COMMUNITY_VOTES = 3
const VOTE_TTL_S = 90 * DAY_S
const DEFAULT_TTL_S = 180 * DAY_S

export interface SyncSetting {
  version: string
  /** Seconds, in 0.5 steps. */
  offset: number
  speed: (typeof SPEEDS)[number]
}

export function parseSetting(body: Record<string, unknown>): SyncSetting | null {
  const version = String(body.version ?? '')
  const offset = Math.round(Number(body.offset ?? 0) * 2) / 2
  const speed = String(body.speed ?? '1') as SyncSetting['speed']
  if (!VERSION_ID.test(version) || !Number.isFinite(offset) || Math.abs(offset) > 600 || !SPEEDS.includes(speed)) return null
  return { version, offset, speed }
}

/** A cached entry is "<step>|<version>\n<vtt>" (older ones: "<step>\n<vtt>"). */
function readEntry(entry: string): { step: string; version: string | null; vtt: string } {
  const at = entry.indexOf('\n')
  const [step, version = null] = entry.slice(0, at).split('|')
  return { step, version, vtt: entry.slice(at + 1) }
}

// ——— HTTP ———

const sendJson = (res: ServerResponse, status: number, body: unknown, cache = 'no-store') => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', cache)
  res.end(JSON.stringify(body))
}

/** Browser cache only (not the CDN): the counts stay right and a new community default shows within the hour. */
const sendVtt = (res: ServerResponse, vtt: string, source: string, version: string | null, setting?: SyncSetting) => {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('X-Subtitle-Source', source)
  if (version) res.setHeader('X-Subtitle-Version', version)
  if (setting) {
    res.setHeader('X-Subtitle-Community', '1')
    res.setHeader('X-Subtitle-Offset', String(setting.offset))
    res.setHeader('X-Subtitle-Speed', setting.speed)
  }
  res.end(vtt)
}

const clientIp = (req: IncomingMessage) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || String(req.headers['x-real-ip'] ?? '') || req.socket?.remoteAddress || 'unknown'

const digest = (s: string) => createHash('sha256').update(s).digest()
const isAdmin = (env: SubtitlesEnv, authorization: string | undefined) => {
  if (!env.adminPassword) return false
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? ''
  return timingSafeEqual(digest(given), digest(env.adminPassword))
}

const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** A small JSON body (votes and reports): Vercel's parsed req.body, or the stream. {} when there's none. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const given = (req as IncomingMessage & { body?: unknown }).body
  try {
    if (given && typeof given === 'object') return given as Record<string, unknown>
    if (typeof given === 'string') return JSON.parse(given) as Record<string, unknown>
    if (typeof (req as Partial<IncomingMessage>)[Symbol.asyncIterator] !== 'function') return {}
    let text = ''
    for await (const chunk of req) {
      text += String(chunk)
      if (text.length > 8192) return {}
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const requestFromBody = (body: Record<string, unknown>) => {
  const q = new URLSearchParams()
  for (const k of ['tmdbId', 'type', 'season', 'episode', 'lang']) if (body[k] !== undefined && body[k] !== null) q.set(k, String(body[k]))
  return parseRequest(q)
}

const cleanText = (value: unknown, max: number) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max)

/** "Subtitles out of sync?" reports, kept for /admin/live. */
const REPORTS_KEY = 'subs:reports'
const BAD_KEY = 'subs:bad'
const BAD_NAMES_KEY = 'subs:bad:names'
const MAX_REPORTS = 200

const pairs = (value: unknown) => {
  const flat = (Array.isArray(value) ? value : []) as string[]
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1]
  return out
}

async function handleAdmin(env: SubtitlesEnv, action: string, params: URLSearchParams, req: IncomingMessage, res: ServerResponse, deps: Deps) {
  if (!isAdmin(env, req.headers.authorization)) return sendJson(res, 401, { error: 'unauthorized' })
  const now = deps.now()
  const f = deps.fetch

  // Clears one title's cached subtitles (a stale "not found", a bad file), so the next play searches again.
  if (action === 'admin-flush') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
    const id = params.get('tmdbId') ?? ''
    if (!ID.test(id)) return sendJson(res, 400, { error: 'bad-request' })
    let deleted = 0
    for (const pattern of [`subs:${id}:*`, `subs:v:${id}:*`, `subs:versions:${id}:*`, `subs:langs:*:${id}:*`]) {
      let cursor = '0'
      for (let round = 0; round < 50; round++) {
        const r = await redis(env.redis, [['SCAN', cursor, 'MATCH', pattern, 'COUNT', 500]], f)
        const [next, keys] = (Array.isArray(r?.[0]) ? r[0] : ['0', []]) as [string, string[]]
        if (keys.length) {
          await redis(env.redis, [['DEL', ...keys]], f)
          deleted += keys.length
        }
        cursor = String(next)
        if (cursor === '0') break
      }
    }
    deps.log(`[subtitles] admin cleared ${deleted} cached entries for tmdb ${id}`)
    return sendJson(res, 200, { deleted })
  }

  const r = await redis(
    env.redis,
    [['HGETALL', statsKey(now)], ['GET', limitKey(now)], ['LRANGE', REPORTS_KEY, 0, 19], ['HGETALL', BAD_KEY], ['HGETALL', BAD_NAMES_KEY]],
    f,
  )
  const stats = Object.fromEntries(Object.entries(pairs(r?.[0])).map(([k, v]) => [k, Number(v)]))
  const steps: Record<string, number> = {}
  for (const [k, v] of Object.entries(stats)) if (k.startsWith('step:')) steps[k.slice(5)] = v
  const names = pairs(r?.[4])
  const badTitles = Object.entries(pairs(r?.[3]))
    .map(([slot, n]) => ({ slot, title: names[slot] ?? slot, reports: Number(n) }))
    .sort((a, b) => b.reports - a.reports)
    .slice(0, 15)
  const reports = ((Array.isArray(r?.[2]) ? r[2] : []) as string[]).flatMap((x) => {
    try {
      return [JSON.parse(x) as Record<string, unknown>]
    } catch {
      return []
    }
  })
  return sendJson(res, 200, {
    enabled: env.enabled,
    served: stats.served ?? 0,
    cacheHits: stats.hits ?? 0,
    downloads: stats.downloads ?? 0,
    notFound: stats.notFound ?? 0,
    subdlFallbacks: stats.subdl ?? 0,
    versionSwitches: stats.versions ?? 0,
    communityDefaults: stats.communityDefaults ?? 0,
    outOfSyncToday: stats.outOfSync ?? 0,
    osRemaining: stats.osRemaining ?? null,
    osLimited: r?.[1] === '1',
    steps,
    badTitles,
    reports,
    day: lagosDay(now),
    configured: { opensubtitles: Boolean(env.osKey), login: Boolean(env.osUser && env.osPass), subdl: Boolean(env.subdlKey), redis: Boolean(env.redis.redisUrl) },
  })
}

/** One version's subtitle (cached 30 days), or null. */
async function versionVtt(env: SubtitlesEnv, request: SubtitleRequest, id: string, ip: string, deps: Deps): Promise<{ vtt: string; step: string } | null | 'rate-limited'> {
  const f = deps.fetch
  const now = deps.now()
  const key = versionKey(request, id)
  const cached = await get(env, key, f)
  if (cached === 'none') return null
  if (cached) {
    void stat(env, now, { served: 1, hits: 1 }, f)
    const entry = readEntry(cached)
    return { vtt: entry.vtt, step: entry.step }
  }
  // The episode's own subtitle may be this version: no download needed.
  const main = await get(env, cacheKey(request), f)
  if (main && main !== 'none' && readEntry(main).version === id) {
    void stat(env, now, { served: 1, hits: 1 }, f)
    const entry = readEntry(main)
    return { vtt: entry.vtt, step: entry.step }
  }
  if (!(await allowed(env, ip, 'miss', now, f))) return 'rate-limited'
  const c = candidateOf(id)
  const info = c ? await titleInfo(env, request, f) : null
  const vtt = c && info ? await download(env, deps, c, zipEpisodeOf(request, info), now, { off: await osOffNow(env, deps) }).catch(() => null) : null
  const step = `version:${c?.provider ?? 'unknown'}`
  await Promise.all([
    redis(env.redis, [['SET', key, vtt ? `${step}|${id}\n${vtt}` : 'none', 'EX', vtt ? FOUND_TTL_S : NOT_FOUND_TTL_S]], f),
    stat(env, now, vtt ? { served: 1, downloads: 1, versions: 1, ...(c?.provider === 'subdl' ? { subdl: 1 } : {}) } : { notFound: 1 }, f),
  ])
  return vtt ? { vtt, step } : null
}

async function handleFeedback(env: SubtitlesEnv, action: 'vote' | 'report', req: IncomingMessage, res: ServerResponse, ip: string, deps: Deps) {
  const now = deps.now()
  const f = deps.fetch
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' })
  if (!(await allowed(env, ip, 'feedback', now, f))) return sendJson(res, 429, { error: 'rate-limited' })
  const body = await readBody(req)
  const request = requestFromBody(body)
  if (!request) return sendJson(res, 400, { error: 'bad-request' })
  const slot = slotOf(request)
  const setting = parseSetting(body)

  if (action === 'report') {
    const where = request.episode ? ` S${request.episode.season}E${request.episode.episode}` : ''
    const title = `${cleanText(body.title, 120) || `TMDB ${request.tmdbId}`}${where}`
    const report = {
      at: new Date(now).toISOString(),
      title,
      type: request.type,
      tmdbId: request.tmdbId,
      season: request.episode?.season ?? null,
      episode: request.episode?.episode ?? null,
      lang: request.lang,
      version: setting?.version ?? null,
      offset: setting?.offset ?? 0,
      speed: setting?.speed ?? '1',
      server: cleanText(body.server, 30) || null,
    }
    deps.log(`[subtitles] out of sync: ${title} (${slot}) version ${report.version ?? '?'} offset ${report.offset}s speed ${report.speed}`)
    await stat(env, now, { outOfSync: 1 }, f, [
      ['LPUSH', REPORTS_KEY, JSON.stringify(report)],
      ['LTRIM', REPORTS_KEY, 0, MAX_REPORTS - 1],
      ['HINCRBY', BAD_KEY, slot, 1],
      ['HSET', BAD_NAMES_KEY, slot, `${title} (${request.lang})`],
    ])
    return sendJson(res, 200, { ok: true })
  }

  if (!setting) return sendJson(res, 400, { error: 'bad-request' })
  // Nothing changed from what everyone gets: not a fix.
  const main = await get(env, cacheKey(request), f)
  const auto = main && main !== 'none' ? readEntry(main).version : null
  if (setting.offset === 0 && setting.speed === '1' && (!auto || setting.version === auto)) return sendJson(res, 200, { ok: true, counted: false })
  const choice = `${setting.version}|${setting.offset}|${setting.speed}`
  const votersKey = `subs:voters:${slot}:${choice}`
  const r = await redis(env.redis, [['SADD', votersKey, ipHash(env, ip)], ['EXPIRE', votersKey, VOTE_TTL_S], ['SCARD', votersKey]], f)
  const voters = typeof r?.[2] === 'number' ? (r[2] as number) : 0
  const isDefault = voters >= COMMUNITY_VOTES
  if (isDefault && (await get(env, defaultKey(request), f)) !== JSON.stringify(setting)) {
    await Promise.all([redis(env.redis, [['SET', defaultKey(request), JSON.stringify(setting), 'EX', DEFAULT_TTL_S]], f), stat(env, now, { communityDefaults: 1 }, f)])
    deps.log(`[subtitles] community default for ${slot}: ${choice} (${voters} viewers)`)
  }
  return sendJson(res, 200, { ok: true, counted: true, voters, isDefault })
}

export async function handleSubtitles(env: SubtitlesEnv, action: string, params: URLSearchParams, req: IncomingMessage, res: ServerResponse, deps: Deps = defaultDeps) {
  const now = deps.now()
  const f = deps.fetch

  if (action === 'admin' || action === 'admin-flush') return handleAdmin(env, action, params, req, res, deps)
  if (!env.enabled || (!env.osKey && !env.subdlKey)) return sendJson(res, 404, { error: 'disabled' }, 'public, max-age=300')
  const ip = clientIp(req)

  // POST vote: this viewer's version + offset + speed worked (COMMUNITY_VOTES viewers on the same one: the episode's default).
  // POST report: "Subtitles out of sync?", for /admin/live.
  if (action === 'vote' || action === 'report') return handleFeedback(env, action, req, res, ip, deps)

  if (req.method && req.method !== 'GET') return sendJson(res, 405, { error: 'method' })
  const request = parseRequest(params, action !== 'languages')
  if (!request) return sendJson(res, 400, { error: 'bad-request' })
  if (!(await allowed(env, ip, 'all', now, f))) return sendJson(res, 429, { error: 'rate-limited' })

  if (action === 'languages') {
    const key = langsKey(request)
    const cached = await get(env, key, f)
    let codes: string[]
    if (cached) codes = JSON.parse(cached) as string[]
    else {
      if (!(await allowed(env, ip, 'miss', now, f))) return sendJson(res, 429, { error: 'rate-limited' })
      const info = await titleInfo(env, request, f)
      codes = info ? await findLanguages(env, request, info, deps) : []
      await redis(env.redis, [['SET', key, JSON.stringify(codes), 'EX', codes.length ? 7 * DAY_S : NOT_FOUND_TTL_S]], f)
    }
    const languages = [...new Set(['en', ...codes])]
      .filter((c) => c === 'en' || codes.includes(c))
      .map((code) => ({ code, name: languageName(code), available: codes.includes(code) }))
      .sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.name.localeCompare(b.name)))
    return sendJson(res, 200, { languages }, 'public, max-age=3600')
  }

  // "Try another version": the files for this episode and language, the one playing first.
  if (action === 'versions') {
    const key = versionsKey(request)
    let list: Omit<Version, 'label'>[]
    const cached = await get(env, key, f)
    if (cached) list = JSON.parse(cached) as Omit<Version, 'label'>[]
    else {
      if (!(await allowed(env, ip, 'miss', now, f))) return sendJson(res, 429, { error: 'rate-limited' })
      const info = await titleInfo(env, request, f)
      list = info ? await findVersions(env, request, info, deps) : []
      await redis(env.redis, [['SET', key, JSON.stringify(list), 'EX', list.length ? 7 * DAY_S : NOT_FOUND_TTL_S]], f)
    }
    const [main, community] = await Promise.all([get(env, cacheKey(request), f), get(env, defaultKey(request), f)])
    const playing = main && main !== 'none' ? readEntry(main).version : null
    if (playing) {
      const current = list.find((v) => v.id === playing) ?? { id: playing, provider: playing.startsWith('os:') ? ('opensubtitles' as const) : ('subdl' as const), release: '' }
      list = [current, ...list.filter((v) => v.id !== playing)]
    }
    return sendJson(res, 200, { versions: labelVersions(list.slice(0, MAX_VERSIONS)), community: community ? (JSON.parse(community) as SyncSetting) : null }, 'public, max-age=600')
  }

  if (action !== '') return sendJson(res, 404, { error: 'not-found' })

  // A version the viewer picked.
  const version = params.get('version')
  if (version) {
    if (!VERSION_ID.test(version)) return sendJson(res, 400, { error: 'bad-request' })
    const got = await versionVtt(env, request, version, ip, deps)
    if (got === 'rate-limited') return sendJson(res, 429, { error: 'rate-limited' })
    if (!got) return sendJson(res, 404, { error: 'not-found' }, 'public, max-age=3600')
    return sendVtt(res, got.vtt, got.step, version)
  }

  // Viewers fixed this episode's sync together: theirs first.
  const community = await get(env, defaultKey(request), f)
  if (community) {
    try {
      const setting = JSON.parse(community) as SyncSetting
      const got = await versionVtt(env, request, setting.version, ip, deps)
      if (got && got !== 'rate-limited') return sendVtt(res, got.vtt, `community:${got.step}`, setting.version, setting)
    } catch {
      // The usual one, then.
    }
  }

  const key = cacheKey(request)
  const cached = await get(env, key, f)
  if (cached) {
    void stat(env, now, cached === 'none' ? { notFound: 1 } : { served: 1, hits: 1 }, f)
    if (cached === 'none') return sendJson(res, 404, { error: 'not-found' }, 'public, max-age=3600')
    const entry = readEntry(cached)
    return sendVtt(res, entry.vtt, entry.step, entry.version)
  }
  if (!(await allowed(env, ip, 'miss', now, f))) return sendJson(res, 429, { error: 'rate-limited' })

  const info = await titleInfo(env, request, f)
  const found = info ? await findSubtitle(env, request, info, deps).catch(() => null) : null
  if (!found) {
    deps.log(`[subtitles] none: ${key}`)
    await Promise.all([redis(env.redis, [['SET', key, 'none', 'EX', NOT_FOUND_TTL_S]], f), stat(env, now, { notFound: 1 }, f)])
    return sendJson(res, 404, { error: 'not-found' }, 'public, max-age=3600')
  }
  deps.log(`[subtitles] ${key} found by ${found.step}`)
  // Stored as "<step>|<version>\n<vtt>": a cache hit still says where it came from and which file it is.
  await Promise.all([
    redis(env.redis, [['SET', key, `${found.step}|${found.version}\n${found.vtt}`, 'EX', FOUND_TTL_S]], f),
    stat(env, now, { served: 1, downloads: 1, [`step:${found.step}`]: 1, ...(found.provider === 'subdl' ? { subdl: 1 } : {}) }, f),
  ])
  return sendVtt(res, found.vtt, found.step, found.version)
}
