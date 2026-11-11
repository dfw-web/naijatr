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
 * - GET /api/subtitles/admin (ADMIN_PASSWORD) → today's numbers for /admin/live.
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
export const RATE_LIMITS = { perMinute: 60, missesPer10Min: 12 }
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

export const cacheKey = (r: SubtitleRequest) => `subs:${r.tmdbId}:${r.episode?.season ?? 0}:${r.episode?.episode ?? 0}:${r.lang}`
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
async function allowed(env: SubtitlesEnv, ip: string, bucket: 'all' | 'miss', now: number, f: Fetch): Promise<boolean> {
  const hash = createHash('sha256').update(`subs:${env.salt}:${ip}`).digest('hex').slice(0, 16)
  const windowS = bucket === 'all' ? 60 : 600
  const limit = bucket === 'all' ? RATE_LIMITS.perMinute : RATE_LIMITS.missesPer10Min
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

export interface Found {
  vtt: string
  step: string
  provider: 'opensubtitles' | 'subdl'
}

async function download(env: SubtitlesEnv, deps: Deps, c: Candidate, step: Step, now: number, osState: { token?: OsToken | null }): Promise<string | null> {
  let bytes: Uint8Array | null = null
  if (c.provider === 'opensubtitles') {
    if (osState.token === undefined) osState.token = await osToken(env, deps)
    let result = await downloadOpenSubtitles(env.osKey, osState.token, c.ref, deps.fetch)
    if (result === 'unauthorized') {
      osState.token = await osToken(env, deps, true)
      result = await downloadOpenSubtitles(env.osKey, osState.token, c.ref, deps.fetch)
    }
    if (result && result !== 'unauthorized') {
      bytes = result.bytes
      if (result.remaining !== null) {
        await redis(env.redis, [['HSET', statsKey(now), 'osRemaining', result.remaining], ['EXPIRE', statsKey(now), STATS_TTL_S]], deps.fetch)
        if (result.remaining <= 0) await markLimited(env, deps, now)
      }
    }
  } else {
    const zip = await downloadSubdl(c.ref, deps.fetch)
    if (zip) {
      try {
        bytes = pickZipFile(unzip(zip), step.zipEpisode)?.data ?? null
      } catch {
        bytes = zip
      }
    }
  }
  return bytes ? toVtt(decodeSubtitle(bytes)) : null
}

/** Runs the steps until one gives a subtitle in `lang`. Machine translations only when nothing else exists. */
export async function findSubtitle(env: SubtitlesEnv, r: SubtitleRequest, info: TitleInfo, deps: Deps): Promise<Found | null> {
  const now = deps.now()
  let osOff = !env.osKey || (await get(env, limitKey(now), deps.fetch)) === '1'
  const osState: { token?: OsToken | null } = {}
  const machineOnly: { c: Candidate; step: Step }[] = []
  const tryAll = async (list: { c: Candidate; step: Step }[]): Promise<Found | null> => {
    for (const { c, step } of list) {
      if (c.provider === 'opensubtitles' && osOff) continue
      try {
        const vtt = await download(env, deps, c, step, now, osState)
        if (vtt) return { vtt, step: step.name, provider: c.provider }
      } catch (error) {
        if (error instanceof QuotaError) {
          osOff = true
          await markLimited(env, deps, now)
        }
      }
    }
    return null
  }
  for (const step of steps(info, r.episode)) {
    if (step.provider === 'opensubtitles' && osOff) continue
    if (step.provider === 'subdl' && !env.subdlKey) continue
    let found: Candidate[]
    try {
      const search = step.search(r.lang)
      found =
        step.provider === 'opensubtitles'
          ? await searchOpenSubtitles(env.osKey, search as OsSearch, deps.fetch)
          : await searchSubdl(env.subdlKey, search as SubdlSearch, deps.fetch)
    } catch (error) {
      if (error instanceof QuotaError) {
        osOff = true
        await markLimited(env, deps, now)
      }
      continue
    }
    const ranked = rank(found.filter((c) => c.lang === r.lang || (r.lang.length === 2 && c.lang.slice(0, 2) === r.lang)))
    const human = ranked.filter((c) => !c.machine)
    machineOnly.push(...ranked.filter((c) => c.machine).map((c) => ({ c, step })))
    const hit = await tryAll(human.slice(0, TRIES_PER_STEP).map((c) => ({ c, step })))
    if (hit) return hit
  }
  return tryAll(machineOnly.slice(0, TRIES_PER_STEP))
}

/** The languages there are subtitles in: the first step with any results, every page. */
export async function findLanguages(env: SubtitlesEnv, r: SubtitleRequest, info: TitleInfo, deps: Deps): Promise<string[]> {
  const osOff = !env.osKey || (await get(env, limitKey(deps.now()), deps.fetch)) === '1'
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

// ——— HTTP ———

const sendJson = (res: ServerResponse, status: number, body: unknown, cache = 'no-store') => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', cache)
  res.end(JSON.stringify(body))
}

const sendVtt = (res: ServerResponse, vtt: string, source: string) => {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400')
  res.setHeader('X-Subtitle-Source', source)
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

export async function handleSubtitles(env: SubtitlesEnv, action: string, params: URLSearchParams, req: IncomingMessage, res: ServerResponse, deps: Deps = defaultDeps) {
  if (req.method && req.method !== 'GET') return sendJson(res, 405, { error: 'method' })
  const now = deps.now()
  const f = deps.fetch

  if (action === 'admin') {
    if (!isAdmin(env, req.headers.authorization)) return sendJson(res, 401, { error: 'unauthorized' })
    const r = await redis(env.redis, [['HGETALL', statsKey(now)], ['GET', limitKey(now)]], f)
    const flat = (Array.isArray(r?.[0]) ? r[0] : []) as string[]
    const stats: Record<string, number> = {}
    for (let i = 0; i + 1 < flat.length; i += 2) stats[flat[i]] = Number(flat[i + 1])
    const steps: Record<string, number> = {}
    for (const [k, v] of Object.entries(stats)) if (k.startsWith('step:')) steps[k.slice(5)] = v
    return sendJson(res, 200, {
      enabled: env.enabled,
      served: stats.served ?? 0,
      cacheHits: stats.hits ?? 0,
      downloads: stats.downloads ?? 0,
      notFound: stats.notFound ?? 0,
      subdlFallbacks: stats.subdl ?? 0,
      osRemaining: stats.osRemaining ?? null,
      osLimited: r?.[1] === '1',
      steps,
      day: lagosDay(now),
      configured: { opensubtitles: Boolean(env.osKey), login: Boolean(env.osUser && env.osPass), subdl: Boolean(env.subdlKey), redis: Boolean(env.redis.redisUrl) },
    })
  }

  if (!env.enabled || (!env.osKey && !env.subdlKey)) return sendJson(res, 404, { error: 'disabled' }, 'public, max-age=300')
  const request = parseRequest(params, action !== 'languages')
  if (!request) return sendJson(res, 400, { error: 'bad-request' })
  const ip = clientIp(req)
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

  if (action !== '') return sendJson(res, 404, { error: 'not-found' })

  const key = cacheKey(request)
  const cached = await get(env, key, f)
  if (cached) {
    void stat(env, now, cached === 'none' ? { notFound: 1 } : { served: 1, hits: 1 }, f)
    if (cached === 'none') return sendJson(res, 404, { error: 'not-found' }, 'public, max-age=3600')
    const at = cached.indexOf('\n')
    return sendVtt(res, cached.slice(at + 1), cached.slice(0, at))
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
  // Stored as "<step>\n<vtt>", so a cache hit still says where it came from.
  await Promise.all([
    redis(env.redis, [['SET', key, `${found.step}\n${found.vtt}`, 'EX', FOUND_TTL_S]], f),
    stat(env, now, { served: 1, downloads: 1, [`step:${found.step}`]: 1, ...(found.provider === 'subdl' ? { subdl: 1 } : {}) }, f),
  ])
  return sendVtt(res, found.vtt, found.step)
}
