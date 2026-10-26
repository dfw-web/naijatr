/**
 * The Download button's options, from the MovieBox Cloudflare Worker
 * (GET /api/download/options). Playback never comes through here: the Watch
 * streams stay in handlers.ts / nextstream.ts.
 *
 * The Worker's /search is broken, so titles are found in an index built from
 * its working discovery endpoints (/home/rows, then /home/subjects for each
 * row), cached for hours. A confident match is saved per title (TMDB id), and
 * misses are remembered for a while, so most clicks cost one Worker call.
 *
 * The Worker secret is only ever sent from here, in the X-Worker-Secret header.
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { ServerResponse } from 'node:http'
import { hasRedis, redis, type RedisEnv } from './redis.js'

export const DEFAULT_WORKER_URL = 'https://spun-moviebox-api.nextloft-clientr.workers.dev'

const WORKER_TIMEOUT_MS = 10_000
/** The Worker's /download goes through its relay and often takes 10-15s. */
const DOWNLOAD_TIMEOUT_MS = 25_000
/** Building the index stops fetching rows after this and keeps what it has. */
const INDEX_BUDGET_MS = 8000
const INDEX_ROW_LIMIT = 40
const INDEX_PAGES = 2
const INDEX_PER_PAGE = 50
const INDEX_CONCURRENCY = 6
const INDEX_MAX_ENTRIES = 5000

const INDEX_TTL_S = 6 * 60 * 60
const MATCH_TTL_S = 30 * 24 * 60 * 60
const NO_MATCH_TTL_S = 6 * 60 * 60
const NO_DOWNLOADS_TTL_S = 60 * 60

const INDEX_KEY = 'moviebox:index:v1'
const mapKey = (type: MediaKind, movieId: string) => `moviebox:map:v1:${type}:${movieId}`
const noDownloadsKey = (subjectId: string, season: number | null, episode: number | null) =>
  `moviebox:nodl:v1:${subjectId}:${season ?? '-'}:${episode ?? '-'}`

export interface MovieboxConfig {
  workerUrl: string
  secret: string
  redis: RedisEnv
}

export function readMovieboxConfig(env: Record<string, string | undefined>, redisEnv: RedisEnv): MovieboxConfig {
  return {
    workerUrl: (env.MOVIEBOX_WORKER_URL?.trim() || DEFAULT_WORKER_URL).replace(/\/+$/, ''),
    secret: env.MOVIEBOX_WORKER_SECRET?.trim() ?? '',
    redis: redisEnv,
  }
}

export const isMovieboxConfigured = (config: MovieboxConfig) => Boolean(config.workerUrl && config.secret)

// ---- Small key/value cache: Upstash Redis when configured, else this instance's memory ----

export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
}

export function createStore(redisEnv: RedisEnv, fetchImpl: typeof fetch = fetch): KeyValueStore {
  const memory = new Map<string, { value: string; expires: number }>()
  const fromMemory = (key: string) => {
    const hit = memory.get(key)
    if (hit && hit.expires > Date.now()) return hit.value
    memory.delete(key)
    return null
  }
  return {
    async get(key) {
      const local = fromMemory(key)
      if (local !== null || !hasRedis(redisEnv)) return local
      const result = await redis(redisEnv, [['GET', key]], fetchImpl)
      const value = result?.[0]
      return typeof value === 'string' ? value : null
    },
    async set(key, value, ttlSeconds) {
      if (memory.size > 2000) memory.clear()
      memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 })
      if (hasRedis(redisEnv)) await redis(redisEnv, [['SET', key, value, 'EX', ttlSeconds]], fetchImpl)
    },
  }
}

// ---- Titles ----

export type MediaKind = 'movie' | 'series'

/** Lowercase, no accents or punctuation, apostrophes dropped ("Ocean’s" → "oceans"), single spaces. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** normalizeTitle without harmless extras: "[Hindi]", "(2019)", a trailing year or "S2" / "Season 2". */
export function looseTitle(title: string): string {
  return normalizeTitle(title.replace(/\[[^\]]*\]|\([^)]*\)/g, ' '))
    .replace(/ (s\d{1,2}|season \d{1,2})$/, '')
    .replace(/ (19|20)\d{2}$/, '')
    .trim()
}

/** Minutes, from 95, "95", "95 min", "1h 35m"; numbers over 600 are taken as seconds. */
export function parseRuntime(value: unknown): number | null {
  if (typeof value === 'number' && value > 0) return Math.round(value > 600 ? value / 60 : value)
  if (typeof value !== 'string') return null
  const hm = /(\d+)\s*h(?:\s*(\d+)\s*m)?/i.exec(value)
  if (hm) return Number(hm[1]) * 60 + Number(hm[2] ?? 0)
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? parseRuntime(n) : null
}

export interface IndexEntry {
  id: string
  title: string
  year: number | null
  type: MediaKind | null
  runtime: number | null
  country: string
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every object in `value` (any depth) that `pick` accepts. */
function collect<T>(value: unknown, pick: (o: Json) => T | null, skipKey?: RegExp, depth = 0, out: T[] = []): T[] {
  if (depth > 8) return out
  if (Array.isArray(value)) {
    for (const v of value) collect(v, pick, skipKey, depth + 1, out)
  } else if (isObject(value)) {
    const found = pick(value)
    if (found !== null) out.push(found)
    for (const [key, v] of Object.entries(value)) {
      if (!skipKey?.test(key)) collect(v, pick, skipKey, depth + 1, out)
    }
  }
  return out
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** MovieBox subjectType 1 is a movie, 2 a series; otherwise a `type` like "movie" / "tv". */
function kindOf(subject: Json): MediaKind | null {
  const subjectType = Number(subject.subjectType)
  if (subjectType === 1) return 'movie'
  if (subjectType === 2) return 'series'
  const type = str(subject.type).toLowerCase()
  if (/movie|film/.test(type)) return 'movie'
  if (/tv|series|show/.test(type)) return 'series'
  return null
}

export function subjectToEntry(subject: Json): IndexEntry | null {
  const id = str(subject.subjectId)
  const title = str(subject.title)
  if (!id || !title) return null
  const date = str(subject.releaseDate) || str(subject.year)
  const year = /^(\d{4})/.exec(date)
  return {
    id,
    title,
    year: year ? Number(year[1]) : null,
    type: kindOf(subject),
    runtime: parseRuntime(subject.runtime ?? subject.duration),
    country: str(subject.countryName) || str(subject.country),
  }
}

// ---- Matching ----

export interface WantedTitle {
  title: string
  originalTitle: string
  year: number | null
  type: MediaKind
  runtime: number | null
  /** ISO 3166-1 codes, e.g. ["US"]. */
  countries: string[]
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()

/** Picks one subject among the candidates by runtime, then country; null if still not one. */
function tieBreak(candidates: IndexEntry[], want: WantedTitle): IndexEntry | null {
  let pool = candidates
  if (want.runtime !== null) {
    const close = pool.filter((e) => e.runtime !== null && Math.abs(e.runtime - want.runtime!) <= 5)
    if (close.length === 1) return close[0]
    if (close.length > 1) pool = close
  }
  if (want.countries.length) {
    const names = want.countries.flatMap((code) => [code, regionNames?.of(code) ?? '']).map(normalizeTitle).filter(Boolean)
    const local = pool.filter((e) => {
      const country = normalizeTitle(e.country)
      return country && names.some((name) => country.includes(name))
    })
    if (local.length === 1) return local[0]
  }
  return null
}

const distinct = (entries: IndexEntry[]) => [...new Map(entries.map((e) => [e.id, e])).values()]

/**
 * The subject for a title, in order of confidence:
 * 1. exact normalized title + same year + same type
 * 2. exact normalized title + same type (movies: year within 1 or unknown)
 * 3. exact original title + same year
 * 4. the same title without harmless extras, only when there is one candidate
 * Several candidates at a step are told apart by runtime and country, or no match.
 */
export function matchSubject(want: WantedTitle, index: IndexEntry[]): { id: string } | { ambiguous: true } | null {
  const norm = normalizeTitle(want.title)
  const original = want.originalTitle ? normalizeTitle(want.originalTitle) : ''
  const loose = looseTitle(want.title)
  const sameType = (e: IndexEntry) => e.type === want.type
  const sameYear = (e: IndexEntry) => want.year !== null && e.year === want.year
  const nearYear = (e: IndexEntry) =>
    want.type === 'series' || want.year === null || e.year === null || Math.abs(e.year - want.year) <= 1

  const steps: { candidates: IndexEntry[]; tieBreak: boolean }[] = [
    { candidates: index.filter((e) => normalizeTitle(e.title) === norm && sameType(e) && sameYear(e)), tieBreak: true },
    { candidates: index.filter((e) => normalizeTitle(e.title) === norm && sameType(e) && nearYear(e)), tieBreak: true },
    {
      candidates: original
        ? index.filter((e) => normalizeTitle(e.title) === original && (sameType(e) || e.type === null) && sameYear(e))
        : [],
      tieBreak: true,
    },
    {
      candidates: loose
        ? index.filter((e) => looseTitle(e.title) === loose && (sameType(e) || e.type === null) && nearYear(e))
        : [],
      tieBreak: false,
    },
  ]
  for (const step of steps) {
    const candidates = distinct(step.candidates)
    if (candidates.length === 1) return { id: candidates[0].id }
    if (candidates.length > 1) {
      const chosen = step.tieBreak ? tieBreak(candidates, want) : null
      return chosen ? { id: chosen.id } : { ambiguous: true }
    }
  }
  return null
}

// ---- Downloads ----

export interface DownloadOption {
  quality: string
  size: string | null
  filename: string | null
  language: string | null
  url: string
}

const URL_KEYS = ['url', 'downloadUrl', 'download_url', 'link', 'src'] as const
const EPISODE_IN_NAME = /S(\d{1,2})[\s._-]*E(\d{1,3})/i

const httpUrl = (value: unknown) => {
  const s = str(value)
  try {
    const url = new URL(s)
    return url.protocol === 'https:' || url.protocol === 'http:' ? s : null
  } catch {
    return null
  }
}

const intOf = (value: unknown) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function formatSize(value: unknown): string | null {
  const bytes = typeof value === 'number' ? value : /^\d+$/.test(str(value)) ? Number(str(value)) : null
  if (bytes === null) return str(value) || null
  if (bytes <= 0) return null
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

function qualityOf(file: Json): string {
  const value = file.resolution ?? file.quality ?? file.label ?? file.res
  const n = intOf(value)
  if (n) return `${n}p`
  return str(value) || 'Download'
}

interface ParsedFile extends DownloadOption {
  season: number | null
  episode: number | null
}

function fileOf(o: Json): ParsedFile | null {
  const url = URL_KEYS.map((key) => httpUrl(o[key])).find(Boolean)
  if (!url || /\.(srt|vtt|ass)(\?|$)/i.test(url)) return null
  const filename = str(o.filename) || str(o.fileName) || str(o.name) || str(o.title) || null
  const named = EPISODE_IN_NAME.exec(filename ?? '') ?? EPISODE_IN_NAME.exec(decodeURIComponent(url.split('?')[0]))
  return {
    url,
    quality: qualityOf(o),
    size: formatSize(o.size ?? o.fileSize ?? o.bytes),
    filename,
    language: str(o.language) || str(o.lang) || str(o.languageName) || str(o.audio) || null,
    season: intOf(o.se ?? o.season ?? o.seasonNumber) ?? (named ? Number(named[1]) : null),
    episode: intOf(o.ep ?? o.episode ?? o.episodeNumber) ?? (named ? Number(named[2]) : null),
  }
}

/**
 * The files in a Worker /download response, best quality first. For an
 * episode, only files the response ties to that season and episode (in their
 * fields or names, or the response as a whole): never a guess.
 */
export function parseDownloads(body: unknown, season: number | null, episode: number | null): DownloadOption[] {
  let files = collect(body, fileOf, /caption|subtitle/i)
  if (season !== null && episode !== null) {
    const tagged = files.filter((f) => f.season !== null && f.episode !== null)
    if (tagged.length) {
      files = tagged.filter((f) => f.season === season && f.episode === episode)
    } else {
      const top = isObject(body) ? (isObject(body.data) ? body.data : body) : {}
      const echoed = intOf(top.se ?? top.season) === season && intOf(top.ep ?? top.episode) === episode
      if (!echoed) files = []
    }
  }
  const unique = [...new Map(files.map((f) => [f.url, f])).values()]
  return unique
    .sort((a, b) => (Number.parseInt(b.quality, 10) || 0) - (Number.parseInt(a.quality, 10) || 0))
    .map(({ quality, size, filename, language, url }) => ({ quality, size, filename, language, url }))
}

// ---- The service ----

class WorkerError extends Error {
  readonly status: number | null
  constructor(status: number | null) {
    super(`worker ${status ?? 'unreachable'}`)
    this.status = status
  }
}

export interface DownloadRequest {
  movieId: string
  want: WantedTitle
  season: number | null
  episode: number | null
}

/** Reads and checks the browser's query; null when it's not usable. */
export function parseDownloadRequest(params: URLSearchParams): DownloadRequest | null {
  const movieId = params.get('movieId')?.trim() ?? ''
  const title = params.get('title')?.trim() ?? ''
  const type = params.get('type')
  if (!/^[\w:.-]{1,80}$/.test(movieId) || !title || title.length > 300) return null
  if (type !== 'movie' && type !== 'series') return null
  const season = intOf(params.get('season'))
  const episode = intOf(params.get('episode'))
  if (type === 'series' && (season === null || episode === null)) return null
  return {
    movieId,
    season: type === 'series' ? season : null,
    episode: type === 'series' ? episode : null,
    want: {
      title,
      originalTitle: (params.get('originalTitle') ?? '').trim().slice(0, 300),
      year: intOf(params.get('year')),
      type,
      runtime: parseRuntime(params.get('runtime')),
      countries: (params.get('country') ?? '').split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    },
  }
}

export type DownloadResult =
  | { available: true; label: string | null; options: DownloadOption[] }
  | { available: false; reason: 'not-configured' | 'bad-request' | 'no-match' | 'no-downloads' | 'error' }

export function createMovieboxDownloads(config: MovieboxConfig, fetchImpl: typeof fetch = fetch, store = createStore(config.redis, fetchImpl)) {
  let index: { entries: IndexEntry[]; expires: number } | null = null
  let building: Promise<IndexEntry[]> | null = null

  const worker = async (path: string, timeoutMs = WORKER_TIMEOUT_MS): Promise<unknown> => {
    let response: Response
    try {
      response = await fetchImpl(`${config.workerUrl}${path}`, {
        headers: { 'X-Worker-Secret': config.secret, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new WorkerError(null)
    }
    if (!response.ok) throw new WorkerError(response.status)
    return response.json().catch(() => null)
  }

  const buildIndex = async (): Promise<IndexEntry[]> => {
    const deadline = Date.now() + INDEX_BUDGET_MS
    const rows = await worker('/home/rows')
    const opIds = [...new Set(collect(rows, (o) => str(o.opId) || null))].slice(0, INDEX_ROW_LIMIT)
    const jobs = opIds.flatMap((opId) => Array.from({ length: INDEX_PAGES }, (_, i) => ({ opId, page: i + 1 })))
    const entries = new Map<string, IndexEntry>()
    let next = 0
    const run = async () => {
      while (next < jobs.length && Date.now() < deadline && entries.size < INDEX_MAX_ENTRIES) {
        const { opId, page } = jobs[next++]
        try {
          const body = await worker(`/home/subjects?opId=${encodeURIComponent(opId)}&page=${page}&perPage=${INDEX_PER_PAGE}`)
          for (const entry of collect(body, (o) => (o.subjectId !== undefined ? subjectToEntry(o) : null))) {
            if (!entries.has(entry.id)) entries.set(entry.id, entry)
          }
        } catch {
          // One row failing leaves the rest of the index.
        }
      }
    }
    await Promise.all(Array.from({ length: INDEX_CONCURRENCY }, run))
    console.info(`[Download] subject index built: ${opIds.length} rows, ${entries.size} subjects`)
    return [...entries.values()]
  }

  /** The cached index: this instance's copy, the shared one in Redis, or a fresh build. */
  const getIndex = async (): Promise<IndexEntry[]> => {
    if (index && index.expires > Date.now()) return index.entries
    const saved = await store.get(INDEX_KEY)
    if (saved) {
      try {
        const entries = (JSON.parse(saved) as [string, string, number | null, MediaKind | null, number | null, string][]).map(
          ([id, title, year, type, runtime, country]) => ({ id, title, year, type, runtime, country }),
        )
        index = { entries, expires: Date.now() + 10 * 60 * 1000 }
        return entries
      } catch {
        // A broken copy is rebuilt below.
      }
    }
    building ??= buildIndex().finally(() => {
      building = null
    })
    const entries = await building
    if (entries.length) {
      index = { entries, expires: Date.now() + INDEX_TTL_S * 1000 }
      const compact = entries.map((e) => [e.id, e.title, e.year, e.type, e.runtime, e.country])
      await store.set(INDEX_KEY, JSON.stringify(compact), INDEX_TTL_S)
    }
    return entries
  }

  /** The saved subject for the title, or a new match (saved either way); null when there's none. */
  const resolveSubject = async (request: DownloadRequest): Promise<string | null> => {
    const key = mapKey(request.want.type, request.movieId)
    const saved = await store.get(key)
    if (saved !== null) {
      console.info(saved ? '[Download] cached mapping found' : '[Download] cached: no subject for this title')
      return saved || null
    }
    console.info('[Download] resolving subject')
    const entries = await getIndex()
    const match = matchSubject(request.want, entries)
    if (match && 'id' in match) {
      console.info(`[Download] matched subjectId ${match.id}`)
      await store.set(key, match.id, MATCH_TTL_S)
      return match.id
    }
    console.info(match ? '[Download] no confident subject match (several candidates)' : '[Download] no confident subject match')
    if (entries.length) await store.set(key, '', NO_MATCH_TTL_S)
    return null
  }

  const options = async (request: DownloadRequest): Promise<DownloadResult> => {
    if (!isMovieboxConfigured(config)) return { available: false, reason: 'not-configured' }
    const subjectId = await resolveSubject(request)
    if (!subjectId) return { available: false, reason: 'no-match' }

    const { season, episode } = request
    const noneKey = noDownloadsKey(subjectId, season, episode)
    if ((await store.get(noneKey)) !== null) {
      console.info('[Download] no downloads available (cached)')
      return { available: false, reason: 'no-downloads' }
    }
    const query = season !== null && episode !== null ? `?se=${season}&ep=${episode}&season=${season}&episode=${episode}` : ''
    let body: unknown
    try {
      body = await worker(`/download/${encodeURIComponent(subjectId)}${query}`, DOWNLOAD_TIMEOUT_MS)
    } catch (error) {
      if (error instanceof WorkerError && error.status === 404) body = null
      else throw error
    }
    const files = parseDownloads(body, season, episode)
    if (!files.length) {
      console.info('[Download] no downloads available')
      await store.set(noneKey, '1', NO_DOWNLOADS_TTL_S)
      return { available: false, reason: 'no-downloads' }
    }
    return { available: true, label: season !== null ? `S${season} E${episode}` : null, options: files }
  }

  /** GET /api/download/options?movieId&title&originalTitle&year&type&season&episode&runtime&country */
  const handle = async (params: URLSearchParams, res: ServerResponse) => {
    const send = (status: number, body: DownloadResult) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }
    const request = parseDownloadRequest(params)
    if (!request) return send(400, { available: false, reason: 'bad-request' })
    try {
      send(200, await options(request))
    } catch (error) {
      console.warn(`[Download] worker request failed (${error instanceof WorkerError ? (error.status ?? 'unreachable') : 'error'})`)
      send(502, { available: false, reason: 'error' })
    }
  }

  return { options, handle }
}
