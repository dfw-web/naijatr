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
import { footballApi } from './server/football/vite.ts'

/**
 * Serves /api/play/... and /api/download/... in dev and preview. The handlers
 * live in server/handlers.ts and are shared with the Vercel functions in api/.
 */
function nextStreamPlayback(config: NextStreamConfig): Plugin {
  // Connect strips the mount path, so req.url is e.g. /movie/123?check=1.
  const middleware = (req: IncomingMessage, res: ServerResponse) => {
    const { path, params } = splitApiUrl(req.url ?? '', '')
    void handlePlay(config, path, params, res)
  }

  const download = (req: IncomingMessage, res: ServerResponse) => {
    handleDownload(config, splitApiUrl(req.url ?? '', '').path, res)
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
    plugins: [react(), nextStreamPlayback(nextStream), footballApi(env.API_FOOTBALL_KEY?.trim() ?? '')],
    define: {
      __TMDB_ENABLED__: JSON.stringify(tmdbEnabled),
      __PLAYBACK_ENABLED__: JSON.stringify(playback),
      __DOWNLOAD_ENABLED__: JSON.stringify(downloads),
    },
    server: { proxy: tmdbProxy },
    preview: { proxy: tmdbProxy },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
