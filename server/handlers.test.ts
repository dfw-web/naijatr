import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import downloadFunction from '../api/download'
import playFunction from '../api/play'
import tmdbFunction from '../api/tmdb'
import {
  handleDownload,
  handlePlay,
  handleTmdb,
  readTmdbCredentials,
  splitApiUrl,
  tmdbUpstreamUrl,
} from './handlers'
import { readNextStreamConfig } from './nextstream'

const config = readNextStreamConfig({
  NEXTSTREAM_API_KEY: 'nx_test',
  NEXTSTREAM_MOVIE_URL: 'https://player.example/movie/{tmdbId}?key={apiKey}',
  NEXTSTREAM_TV_URL: 'https://player.example/tv/{tmdbId}/{season}/{episode}?key={apiKey}',
  NEXTSTREAM_MOVIE_DOWNLOAD_URL: 'https://files.example/movie/{tmdbId}.mp4',
})

/** Minimal ServerResponse stand-in that records what a handler sent. */
function fakeResponse() {
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    body: undefined as string | undefined,
    headers,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value
    },
    end: (body?: string) => {
      res.body = body
    },
  }
  return res as typeof res & ServerResponse
}

/** Trimmed copy of the NextStream player page's structure (ad parts included). */
const PLAYER_PAGE = `<!DOCTYPE html><html><head><title>NexStream</title></head><body>
<div id="stage"><iframe id="stream-frame"></iframe></div>
<script>
  const _urlParams = new URLSearchParams(window.location.search);
  const _apiKey = _urlParams.get('apikey') || '';
  const isDemo = _apiKey.startsWith('DEMO_');
  if (!isDemo) { /* click-shield: window.open(adUrl) */ }
  const parts = window.location.pathname.split('/').filter(Boolean);
  loadSource(0);
</script>
<!-- Dynamic Ad Loader: Suppressed for demo keys, active for real API keys -->
<script type="text/javascript">
  s1.src = 'https://pl1.profitablecpmratenetwork.com/a.js';
</script>
</body></html>`

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null') as Record<string, unknown>

/** Applies vercel.json's rewrites the way Vercel does for these simple patterns. */
function vercelRewrite(url: string) {
  const { rewrites } = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
    rewrites: { source: string; destination: string }[]
  }
  const [pathname, query = ''] = url.split('?')
  for (const { source, destination } of rewrites) {
    const prefix = source.match(/^(\/api\/\w+)\/:path\*$/)?.[1]
    if (prefix && pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length + 1)
      const target = destination.replace(':path*', rest)
      return query ? `${target}&${query}` : target
    }
    if (new RegExp(`^${source}$`).test(pathname)) return destination
  }
  return url
}

describe('API URL parsing', () => {
  it('reads the sub-path from original, mounted and vercel-rewritten URLs', () => {
    for (const url of [
      '/api/tmdb/movie/27205?language=en-US',
      '/movie/27205?language=en-US',
      '/api/tmdb?__path=movie/27205&language=en-US',
      '/api/tmdb?__path=movie%2F27205&language=en-US',
    ]) {
      const { path, params } = splitApiUrl(url, '/api/tmdb')
      expect(path).toBe('/movie/27205')
      expect([...params]).toEqual([['language', 'en-US']])
    }
  })

  it('routes every /api path to its function and everything else to the app', () => {
    expect(vercelRewrite('/api/tmdb/genre/movie/list?language=en-US')).toBe(
      '/api/tmdb?__path=genre/movie/list&language=en-US',
    )
    expect(vercelRewrite('/api/play/tv/1399/1/2?check=1')).toBe('/api/play?__path=tv/1399/1/2&check=1')
    expect(vercelRewrite('/api/download/movie/5')).toBe('/api/download?__path=movie/5')
    expect(vercelRewrite('/movies')).toBe('/index.html')
    expect(vercelRewrite('/')).toBe('/index.html')
  })
})

describe('TMDB proxy', () => {
  const keyOnly = readTmdbCredentials({ VITE_TMDB_API_KEY: ' k3y ' })
  const token = readTmdbCredentials({ TMDB_READ_ACCESS_TOKEN: 'tok', TMDB_API_KEY: 'k3y' })

  it('builds upstream URLs with the key server-side and refuses odd paths', () => {
    expect(tmdbUpstreamUrl(keyOnly, '/search/multi', new URLSearchParams('query=a b'))).toBe(
      'https://api.themoviedb.org/3/search/multi?query=a+b&api_key=k3y',
    )
    expect(tmdbUpstreamUrl(token, '/movie/1', new URLSearchParams())).toBe(
      'https://api.themoviedb.org/3/movie/1',
    )
    for (const bad of ['/movie/../../4/list', '', '/', '//evil.example', '/movie/1@x']) {
      expect(tmdbUpstreamUrl(keyOnly, bad, new URLSearchParams())).toBeNull()
    }
  })

  it('passes TMDB status and body through and sends the bearer token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ status_message: 'nope' }, { status: 404 }),
    )
    const res = fakeResponse()
    await handleTmdb(token, 'GET', '/movie/0', new URLSearchParams('language=en-US'), res, fetchImpl)
    expect(res.statusCode).toBe(404)
    expect(json(res)).toEqual({ status_message: 'nope' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.themoviedb.org/3/movie/0?language=en-US')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' })
  })

  it('answers 503 without credentials, 405 for writes and 502 when TMDB is unreachable', async () => {
    const none = fakeResponse()
    await handleTmdb(readTmdbCredentials({}), 'GET', '/movie/1', new URLSearchParams(), none)
    expect(none.statusCode).toBe(503)

    const post = fakeResponse()
    await handleTmdb(keyOnly, 'POST', '/movie/1', new URLSearchParams(), post)
    expect(post.statusCode).toBe(405)

    const down = fakeResponse()
    const failing = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    await handleTmdb(keyOnly, 'GET', '/movie/1', new URLSearchParams(), down, failing)
    expect(down.statusCode).toBe(502)
  })
})

describe('Playback and download handlers', () => {
  it('serves the player with its ads stripped', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(PLAYER_PAGE))
    const res = fakeResponse()
    await handlePlay(config, '/tv/1399/2/3', new URLSearchParams(), res, fetchImpl)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://player.example/tv/1399/2/3?key=nx_test')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    const html = res.body ?? ''
    expect(html).toContain('<head><base href="https://player.example/">')
    expect(html).toContain('const isDemo = true;')
    expect(html).not.toContain('profitablecpm')
    expect(html).toContain(`const parts = "/tv/1399/2/3".split('/')`)
    expect(html).toContain(`new URLSearchParams("?key=nx_test")`)
    expect(html).toContain('loadSource(0)')
  })

  it('falls back to redirecting to the original player when the page cannot be cleaned', async () => {
    for (const fetchImpl of [
      async () => new Response('<html><head></head><body>changed page</body></html>'),
      async () => new Response('', { status: 500 }),
      async () => {
        throw new TypeError('offline')
      },
    ] as (typeof fetch)[]) {
      const res = fakeResponse()
      await handlePlay(config, '/tv/1399/2/3', new URLSearchParams(), res, fetchImpl)
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('https://player.example/tv/1399/2/3?key=nx_test')
    }
  })

  it('rejects malformed play paths', async () => {

    const bad = fakeResponse()
    await handlePlay(config, '/movie/abc', new URLSearchParams(), bad)
    expect(bad.statusCode).toBe(400)
    expect(json(bad)).toEqual({ available: false, reason: 'bad-request' })
  })

  it('reports availability for ?check=1', async () => {
    const check = async (fetchImpl: typeof fetch) => {
      const res = fakeResponse()
      await handlePlay(config, '/movie/27205', new URLSearchParams('check=1'), res, fetchImpl)
      return json(res)
    }
    expect(await check(async () => new Response('ok'))).toEqual({
      available: true,
      status: 200,
      reason: null,
    })
    expect(await check(async () => new Response('', { status: 404 }))).toMatchObject({
      available: false,
      reason: 'not-found',
    })
    expect(
      await check(async () => {
        throw new TypeError('offline')
      }),
    ).toMatchObject({ available: false, reason: 'unreachable' })
  })

  it('answers not-configured when templates are missing', async () => {
    const empty = readNextStreamConfig({})
    const play = fakeResponse()
    await handlePlay(empty, '/movie/1', new URLSearchParams('check=1'), play)
    expect(play.statusCode).toBe(503)
    expect(json(play)).toEqual({ available: false, reason: 'not-configured' })

    const download = fakeResponse()
    handleDownload(config, '/tv/1/1/1', download)
    expect(download.statusCode).toBe(503)
  })

  it('redirects downloads to the configured file', () => {
    const res = fakeResponse()
    handleDownload(config, '/movie/42', res)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('https://files.example/movie/42.mp4')
  })
})

describe('Vercel functions', () => {
  it('read their configuration from process.env and handle rewritten URLs', async () => {
    vi.stubEnv('NEXTSTREAM_API_KEY', 'nx_env')
    vi.stubEnv('NEXTSTREAM_MOVIE_URL', 'https://player.example/m/{tmdbId}?k={apiKey}')
    vi.stubEnv('NEXTSTREAM_MOVIE_DOWNLOAD_URL', 'https://files.example/m/{tmdbId}')
    vi.stubEnv('TMDB_READ_ACCESS_TOKEN', '')
    vi.stubEnv('TMDB_API_KEY', '')
    vi.stubEnv('VITE_TMDB_API_KEY', '')
    // No network in tests: the player page fetch fails, so play falls back to a redirect.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline')
    })
    try {
      const play = fakeResponse()
      await playFunction({ url: vercelRewrite('/api/play/movie/7') } as never, play)
      expect(play.headers.location).toBe('https://player.example/m/7?k=nx_env')

      const download = fakeResponse()
      downloadFunction({ url: vercelRewrite('/api/download/movie/7') } as never, download)
      expect(download.headers.location).toBe('https://files.example/m/7')

      const tmdb = fakeResponse()
      await tmdbFunction({ url: vercelRewrite('/api/tmdb/movie/7'), method: 'GET' } as never, tmdb)
      expect(tmdb.statusCode).toBe(503)
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })
})
