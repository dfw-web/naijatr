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
}

/**
 * Serves /api/play/movie/{id} and /api/play/tv/{id}/{season}/{episode}.
 * Plain requests serve the NextStream player with its ads stripped (used as
 * the iframe src), falling back to a redirect to the original player if the
 * page can't be fetched or cleaned; `?check=1` asks the server to probe the
 * player URL and answer with JSON, so the UI can report unavailable titles
 * instead of showing a broken frame.
 */
export async function handlePlay(
  config: NextStreamConfig,
  path: string,
  params: URLSearchParams,
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
) {
  const request = parsePlaybackPath(path)
  if (!request) return sendJson(res, 400, { available: false, reason: 'bad-request' })
  const url = resolvePlaybackUrl(config, request)
  if (!url) return sendJson(res, 503, { available: false, reason: 'not-configured' })

  if (!params.has('check')) {
    try {
      const upstream = await fetchImpl(url, { signal: AbortSignal.timeout(PLAYBACK_CHECK_TIMEOUT_MS) })
      const clean = upstream.ok ? stripPlayerAds(await upstream.text(), url) : null
      if (!clean) return redirect(res, url)
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.end(clean)
    } catch {
      return redirect(res, url)
    }
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
  const url = tmdbUpstreamUrl(credentials, path, params)
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
    const cacheControl = upstream.headers.get('cache-control')
    if (cacheControl) res.setHeader('Cache-Control', cacheControl)
    res.end(method === 'HEAD' ? undefined : body)
  } catch {
    sendJson(res, 502, { status_message: 'TMDB could not be reached.' })
  }
}
