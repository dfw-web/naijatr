/**
 * Request handlers for /api/tmdb, /api/play and /api/download, shared by the
 * Vite dev/preview server (vite.config.ts) and the Vercel functions in api/.
 * They use only Node's http types, so both hosts can call them directly.
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */
import type { ServerResponse } from 'node:http'
import {
  parsePlaybackPath,
  resolveDownloadUrl,
  resolvePlaybackUrl,
  type NextStreamConfig,
} from './nextstream.js'

const PLAYBACK_CHECK_TIMEOUT_MS = 8000
/** NextStream often hangs instead of answering; a saved copy of its page is used instead. */
const PLAYER_PAGE_TIMEOUT_MS = 4000
const SOURCES_TIMEOUT_MS = 4000
const SOURCES_ATTEMPTS = 2
const TMDB_TIMEOUT_MS = 15000
const TMDB_ORIGIN = 'https://api.themoviedb.org'

/** Query parameter that vercel.json rewrites put the sub-path into. */
export const PATH_PARAM = '__path'

export interface TmdbCredentials {
  readToken: string
  apiKey: string
}

export function readTmdbCredentials(env: Record<string, string | undefined>): TmdbCredentials {
  return {
    readToken: env.TMDB_READ_ACCESS_TOKEN?.trim() ?? '',
    apiKey: (env.TMDB_API_KEY || env.VITE_TMDB_API_KEY)?.trim() ?? '',
  }
}

/**
 * Splits a request URL into the sub-path below `prefix` and its query.
 * Accepts the original URL (`/api/tmdb/movie/1?x=1`), a mounted one
 * (`/movie/1?x=1`) or a vercel.json rewrite (`/api/tmdb?__path=movie/1&x=1`).
 */
export function splitApiUrl(rawUrl: string, prefix: string) {
  const url = new URL(rawUrl, 'http://localhost')
  const rewritten = url.searchParams.get(PATH_PARAM)
  url.searchParams.delete(PATH_PARAM)
  const path =
    rewritten !== null
      ? `/${rewritten.replace(/^\/+/, '')}`
      : url.pathname.startsWith(`${prefix}/`) || url.pathname === prefix
        ? url.pathname.slice(prefix.length)
        : url.pathname
  return { path, params: url.searchParams }
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

const redirect = (res: ServerResponse, url: string) => {
  res.statusCode = 302
  res.setHeader('Location', url)
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}

const AD_LOADER_SCRIPT = /<!--\s*Dynamic Ad Loader[\s\S]*?<\/script>/
const DEMO_CHECK = /const isDemo = _apiKey\.startsWith\('DEMO_'\);/
const STREAM_FRAME_ALLOW = /(<iframe id="stream-frame" allow=")([^"]*)(")/

/**
 * `allow="fullscreen"` only covers the iframe's src origin, but the stream
 * source redirects to another host (embedmaster.link → embdmstrplayer.com),
 * which then can't go fullscreen. `fullscreen *` keeps it after the redirect.
 */
export const widenAllow = (allow: string) =>
  allow
    .split(';')
    .map((feature) => feature.trim())
    .filter(Boolean)
    .map((feature) => (feature.includes(' ') ? feature : `${feature} *`))
    .join('; ')

/**
 * Removes NextStream's ads from its player page: the click-shield that opens
 * an ad tab, the adblock detector (both skipped when `isDemo` is true) and the
 * pop-under/social-bar loader script. The page is then served from our origin,
 * so its location is pinned to the upstream URL and a <base> keeps its
 * relative requests pointed at NextStream. Returns null when the page no
 * longer matches what we expect, so the caller can fall back to the original.
 */
export function stripPlayerAds(html: string, upstreamUrl: string): string | null {
  const upstream = new URL(upstreamUrl)
  if (!DEMO_CHECK.test(html) || !AD_LOADER_SCRIPT.test(html) || !/<head>/i.test(html)) return null
  if (!html.includes('window.location.pathname')) return null
  return html
    .replace(AD_LOADER_SCRIPT, '')
    .replace(DEMO_CHECK, 'const isDemo = true;')
    .replaceAll('window.location.pathname', () => JSON.stringify(upstream.pathname))
    .replaceAll('window.location.search', () => JSON.stringify(upstream.search))
    .replace(/<head>/i, () => `<head><base href="${upstream.origin}/">`)
    .replace(STREAM_FRAME_ALLOW, (_, start: string, allow: string, end: string) => start + widenAllow(allow) + end)
}

/** A store shared by every server instance (Vercel's Runtime Cache has this shape). */
export interface PlayStore {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown, options?: { ttl?: number }) => Promise<void>
}

/** Memory, plus `shared` when given. A shared store that fails is simply skipped. */
export function createPlayCache(shared?: PlayStore) {
  const memory = new Map<string, { value: unknown; expires: number }>()
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const local = memory.get(key)
      if (local && local.expires > Date.now()) return local.value as T
      try {
        const found = await shared?.get(key)
        if (found !== undefined && found !== null) return found as T
      } catch {
        // Shared cache unavailable: memory only.
      }
      return undefined
    },
    async set(key: string, value: unknown, ttlSeconds: number) {
      memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 })
      try {
        await shared?.set(key, value, { ttl: ttlSeconds })
      } catch {
        // Shared cache unavailable: memory only.
      }
    },
  }
}

export type PlayCache = ReturnType<typeof createPlayCache>

/** NextStream's player page is the same for every title; the last good copy is kept for when it doesn't answer. */
const PLAYER_PAGE_KEY = 'player-page'
const PLAYER_PAGE_TTL = 7 * 24 * 60 * 60
/** A title's stream sources rarely change. */
const SOURCES_TTL = 6 * 60 * 60

async function fetchText(url: string, timeoutMs: number, fetchImpl: typeof fetch) {
  try {
    const upstream = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    return upstream.ok ? await upstream.text() : null
  } catch {
    return null
  }
}

/** The player's own source lookup (/embed/movie/1?apikey=… → /api/movie/1?apikey=…), or null. */
export function sourcesUrl(upstreamUrl: string) {
  const url = new URL(upstreamUrl)
  if (!url.pathname.startsWith('/embed/')) return null
  const apiKey = url.searchParams.get('apikey') || url.searchParams.get('api_key')
  if (!apiKey) return null
  return `${url.origin}/api/${url.pathname.slice('/embed/'.length)}?apikey=${encodeURIComponent(apiKey)}`
}

/** The title's stream sources (as NextStream's JSON), looked up here so the browser needn't wait on NextStream. */
async function loadSources(upstreamUrl: string, cache: PlayCache, fetchImpl: typeof fetch) {
  const url = sourcesUrl(upstreamUrl)
  if (!url) return null
  const key = `sources:${new URL(upstreamUrl).pathname}`
  const saved = await cache.get<string>(key)
  if (saved) return saved
  for (let attempt = 0; attempt < SOURCES_ATTEMPTS; attempt += 1) {
    const text = await fetchText(url, SOURCES_TIMEOUT_MS, fetchImpl)
    if (text === null) continue
    try {
      const data = JSON.parse(text) as { success?: unknown; sources?: unknown }
      if (data.success !== true || !Array.isArray(data.sources) || !data.sources.length) return null
      await cache.set(key, text, SOURCES_TTL)
      return text
    } catch {
      return null
    }
  }
  return null
}

const SOURCES_FETCH = 'fetch(apiUrl)'

/** The player's own lookup, retried: NextStream sometimes never answers, leaving "Resolving sources…". */
const RETRYING_FETCH =
  '(async (u) => { for (let i = 0; ; i++) { try { return await fetch(u, { signal: AbortSignal.timeout(6000) }) } catch (e) { if (i >= 2) throw e } } })(apiUrl)'

/** The player gives a source 8 s to load before calling it failed; the stream host often takes longer. */
const SOURCE_SWITCH_TIMEOUT = /(sourceTimeout = setTimeout\(\(\) => \{[\s\S]{0,600}?\}, )8000(\);)/
const SOURCE_SWITCH_MS = 20000

/**
 * Hands the player its sources: the ones already looked up here, or else its
 * own lookup, retried. Also gives each source longer to load before the
 * player shows "All servers failed to load".
 */
export function injectSources(html: string, sources: string | null) {
  const patient = html.replace(SOURCE_SWITCH_TIMEOUT, (_, start: string, end: string) => start + SOURCE_SWITCH_MS + end)
  if (!patient.includes(SOURCES_FETCH)) return patient
  const call = sources
    ? `Promise.resolve(new Response(${JSON.stringify(sources).replace(/</g, '\\u003c')}))`
    : RETRYING_FETCH
  return patient.replace(SOURCES_FETCH, () => call)
}

/**
 * Serves /api/play/movie/{id} and /api/play/tv/{id}/{season}/{episode}.
 * Plain requests serve the NextStream player with its ads stripped (used as
 * the iframe src). NextStream often hangs, so the last good copy of its page
 * (the same for every title) is used when it doesn't answer in time, and the
 * title's sources are looked up here. Only with no usable page at all does it
 * redirect to the original player, ads and all. `?check=1` asks the server to
 * probe the player URL and answer with JSON, so the UI can report unavailable
 * titles instead of showing a broken frame.
 */
export async function handlePlay(
  config: NextStreamConfig,
  path: string,
  params: URLSearchParams,
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
  cache: PlayCache = createPlayCache(),
) {
  const request = parsePlaybackPath(path)
  if (!request) return sendJson(res, 400, { available: false, reason: 'bad-request' })
  const url = resolvePlaybackUrl(config, request)
  if (!url) return sendJson(res, 503, { available: false, reason: 'not-configured' })

  if (!params.has('check')) {
    const [fresh, sources] = await Promise.all([
      fetchText(url, PLAYER_PAGE_TIMEOUT_MS, fetchImpl),
      loadSources(url, cache, fetchImpl),
    ])
    let clean = fresh === null ? null : stripPlayerAds(fresh, url)
    if (clean) await cache.set(PLAYER_PAGE_KEY, fresh, PLAYER_PAGE_TTL)
    else {
      const saved = await cache.get<string>(PLAYER_PAGE_KEY)
      clean = saved ? stripPlayerAds(saved, url) : null
    }
    if (!clean) return redirect(res, url)
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    return res.end(injectSources(clean, sources))
  }

  try {
    const upstream = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PLAYBACK_CHECK_TIMEOUT_MS),
    })
    await upstream.body?.cancel()
    sendJson(res, 200, {
      available: upstream.ok,
      status: upstream.status,
      reason: upstream.ok ? null : upstream.status === 404 ? 'not-found' : 'upstream-error',
    })
  } catch {
    sendJson(res, 200, { available: false, status: null, reason: 'unreachable' })
  }
}

/** /api/download/... redirects to the configured download URL for the title. */
export function handleDownload(config: NextStreamConfig, path: string, res: ServerResponse) {
  const request = parsePlaybackPath(path)
  if (!request) return sendJson(res, 400, { reason: 'bad-request' })
  const url = resolveDownloadUrl(config, request)
  if (!url) return sendJson(res, 503, { reason: 'not-configured' })
  redirect(res, url)
}

const DAILY_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400'

/** TMDB v3 paths the app may request: plain segments only, no traversal. */
const TMDB_PATH = /^(\/[\w.-]+)+$/

/** Builds the upstream TMDB URL, or null for a path we refuse to proxy. */
export function tmdbUpstreamUrl(
  credentials: TmdbCredentials,
  path: string,
  params: URLSearchParams,
): string | null {
  if (!TMDB_PATH.test(path) || path.split('/').some((s) => s === '.' || s === '..')) return null
  const query = new URLSearchParams(params)
  if (!credentials.readToken) query.set('api_key', credentials.apiKey)
  const search = query.toString()
  return `${TMDB_ORIGIN}/3${path}${search ? `?${search}` : ''}`
}

/**
 * Proxies GET /api/tmdb/* to api.themoviedb.org/3/*, attaching the credentials
 * server-side, and passes TMDB's status and JSON body through unchanged.
 */
export async function handleTmdb(
  credentials: TmdbCredentials,
  method: string | undefined,
  path: string,
  params: URLSearchParams,
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
) {
  if (!credentials.readToken && !credentials.apiKey) {
    return sendJson(res, 503, { status_message: 'TMDB is not configured on this server.' })
  }
  if (method && method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return sendJson(res, 405, { status_message: 'Method not allowed.' })
  }
  // ?cache=day (the personalised home rows): kept a day at the CDN and an hour in the browser.
  const daily = params.get('cache') === 'day'
  const upstreamParams = new URLSearchParams(params)
  upstreamParams.delete('cache')
  const url = tmdbUpstreamUrl(credentials, path, upstreamParams)
  if (!url) return sendJson(res, 400, { status_message: 'Invalid TMDB path.' })

  try {
    const upstream = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        ...(credentials.readToken ? { Authorization: `Bearer ${credentials.readToken}` } : {}),
      },
      signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
    })
    const body = await upstream.text()
    res.statusCode = upstream.status
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json')
    const cacheControl = daily && upstream.ok ? DAILY_CACHE : upstream.headers.get('cache-control')
    if (cacheControl) res.setHeader('Cache-Control', cacheControl)
    res.end(method === 'HEAD' ? undefined : body)
  } catch {
    sendJson(res, 502, { status_message: 'TMDB could not be reached.' })
  }
}
