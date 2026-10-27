/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import {
  isDownloadConfigured,
  isPlaybackConfigured,
  readNextStreamConfig,
  type NextStreamConfig,
} from './server/nextstream.ts'
import { handleDownload, handlePlay, splitApiUrl } from './server/handlers.ts'
import { createMovieboxDownloads, readMovieboxConfig, type MovieboxConfig } from './server/moviebox.ts'
import { readRedisEnv } from './server/redis.ts'
import {
  createWorkerDownloads,
  isWorkerDownloadConfigured,
  readJsonBody,
  readWorkerDownloadConfig,
  type WorkerDownloadConfig,
} from './server/workerDownloads.ts'
import { footballApi } from './server/football/vite.ts'
import { TELEGRAM_CHANNEL_URL } from './src/config/telegram.ts'

/**
 * /go/telegram (go/telegram/index.html, its own page): fills in the channel
 * link, and serves the page at /go/telegram in dev and preview like Vercel does.
 * Same for the private /admin/live, /admin/feedback and /admin/challenge pages.
 */
function telegramPage(): Plugin {
  const rewrite = (req: IncomingMessage, _res: ServerResponse, next: () => void) => {
    if (req.url && /^\/go\/telegram\/?(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/go\/telegram\/?/, '/go/telegram/index.html')
    if (req.url && /^\/admin\/live\/?(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/admin\/live\/?/, '/admin/live/index.html')
    if (req.url && /^\/admin\/feedback\/?(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/admin\/feedback\/?/, '/admin/feedback/index.html')
    if (req.url && /^\/admin\/challenge\/?(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/admin\/challenge\/?/, '/admin/challenge/index.html')
    next()
  }
  return {
    name: 'telegram-page',
    transformIndexHtml: (html) => html.replaceAll('%TELEGRAM_CHANNEL_URL%', TELEGRAM_CHANNEL_URL),
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  }
}

/**
 * Serves /api/play/... and /api/download/... in dev and preview. The handlers
 * live in server/handlers.ts and are shared with the Vercel functions in api/.
 */
function nextStreamPlayback(config: NextStreamConfig, movieboxConfig: MovieboxConfig, workerConfig: WorkerDownloadConfig): Plugin {
  // Connect strips the mount path, so req.url is e.g. /movie/123?check=1.
  const middleware = (req: IncomingMessage, res: ServerResponse) => {
    const { path, params } = splitApiUrl(req.url ?? '', '')
    void handlePlay(config, path, params, res)
  }

  // /api/download/options: the Download button's MovieBox Worker options (server/moviebox.ts).
  const moviebox = createMovieboxDownloads(movieboxConfig)
  // /api/download/job...: download jobs on the naijatr-download-worker (server/workerDownloads.ts).
  const workerDownloads = createWorkerDownloads(workerConfig)
  const download = (req: IncomingMessage, res: ServerResponse) => {
    const { path, params } = splitApiUrl(req.url ?? '', '')
    if (path === '/options') return void moviebox.handle(params, res)
    if (path === '/job' || path.startsWith('/job/')) {
      const method = req.method ?? 'GET'
      return void (method === 'POST' ? readJsonBody(req) : Promise.resolve(null)).then((body) => workerDownloads.handle(method, path, body, res))
    }
    handleDownload(config, path, res)
  }

  return {
    name: 'nextstream-playback',
    configureServer: (server) => {
      server.middlewares.use('/api/play', middleware)
      server.middlewares.use('/api/download', download)
    },
    configurePreviewServer: (server) => {
      server.middlewares.use('/api/play', middleware)
      server.middlewares.use('/api/download', download)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load every variable (empty prefix) for use *here*, on the server only.
  // The credentials are attached by the proxy below and are never referenced
  // from src/, so they are not bundled. (VITE_TMDB_API_KEY is accepted for
  // convenience; Vite only inlines VITE_ variables that client code reads.)
  const env = loadEnv(mode, process.cwd(), '')
  const readToken = env.TMDB_READ_ACCESS_TOKEN?.trim()
  const apiKey = (env.TMDB_API_KEY || env.VITE_TMDB_API_KEY)?.trim()
  // Tests (Vitest runs in "test" mode) always use the local sample provider.
  const tmdbEnabled = mode !== 'test' && Boolean(readToken || apiKey)

  // NextStream credentials and URL templates stay server-side as well.
  const nextStream = readNextStreamConfig(env)
  const playback =
    mode === 'test' ? { movie: false, tv: false } : isPlaybackConfigured(nextStream)
  const downloads =
    mode === 'test' ? { movie: false, tv: false } : isDownloadConfigured(nextStream)
  // MovieBox Worker downloads (/api/download/options): the secret stays server-side.
  const moviebox = readMovieboxConfig(env, readRedisEnv(env))
  // naijatr-download-worker jobs (/api/download/job...): WORKER_API_KEY stays server-side.
  const workerDownloads = readWorkerDownloadConfig(env)

  const tmdbProxy: Record<string, ProxyOptions> = {
    '/api/tmdb': {
      target: 'https://api.themoviedb.org',
      changeOrigin: true,
      rewrite: (path) => {
        const upstream = path.replace(/^\/api\/tmdb/, '/3')
        if (readToken || !apiKey) return upstream
        const separator = upstream.includes('?') ? '&' : '?'
        return `${upstream}${separator}api_key=${encodeURIComponent(apiKey)}`
      },
      headers: readToken ? { Authorization: `Bearer ${readToken}` } : {},
    },
  }

  return {
    plugins: [react(), telegramPage(), nextStreamPlayback(nextStream, moviebox, workerDownloads), footballApi(env.API_FOOTBALL_KEY?.trim() ?? '', env.RAPIDAPI_KEY?.trim() ?? '')],
    define: {
      __TMDB_ENABLED__: JSON.stringify(tmdbEnabled),
      __PLAYBACK_ENABLED__: JSON.stringify(playback),
      __DOWNLOAD_ENABLED__: JSON.stringify(downloads),
      __WORKER_DOWNLOADS__: JSON.stringify(mode !== 'test' && isWorkerDownloadConfigured(workerDownloads)),
    },
    // Smart TVs run old Chromium (2019+ Samsung/LG: Chromium 64-94), so the
    // bundle is compiled down for them; src/tv/polyfills.ts fills the APIs.
    build: {
      target: ['es2019', 'chrome64', 'safari12', 'firefox68', 'edge79'],
      cssTarget: ['chrome64', 'safari12', 'firefox68', 'edge79'],
      // The app, plus the /go/telegram redirect page and the private /admin/live, /admin/feedback and /admin/challenge pages.
      rolldownOptions: { input: { main: 'index.html', telegram: 'go/telegram/index.html', admin: 'admin/live/index.html', feedback: 'admin/feedback/index.html', challenge: 'admin/challenge/index.html' } },
    },
    server: { proxy: tmdbProxy },
    preview: { proxy: tmdbProxy },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      // The ad tests need ads on; src/ads/adsOff.test.tsx checks the real default (off).
      // The Telegram gate would stop every Play: off, except in src/gate's own tests.
      env: { VITE_ADS_ENABLED: 'true', VITE_TELEGRAM_GATE_ENABLED: 'false' },
      // The App tests click through whole pages: slow when every file runs in parallel.
      testTimeout: 15_000,
    },
  }
})
