import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { handleFootball, sharedFootballCache, splitFootballUrl } from './handlers.ts'
import { createMemoryStore } from './streamingStore.ts'

/** Serves /api/football/* in dev and preview, like the Vercel functions in api/football/. */
export function footballApi(key: string, rapidKey = ''): Plugin {
  // The streaming list in memory (no Redis locally).
  const streaming = { key: rapidKey, store: createMemoryStore(), now: Date.now }
  // Connect strips the mount path, so req.url is e.g. /live or /fixtures?date=...
  const middleware = (req: IncomingMessage, res: ServerResponse) => {
    const { route, params } = splitFootballUrl(req.url ?? '')
    void handleFootball({ key, rapidKey, cache: sharedFootballCache, streaming }, req.method, route, params, res)
  }
  return {
    name: 'football-api',
    configureServer: (server) => {
      server.middlewares.use('/api/football', middleware)
    },
    configurePreviewServer: (server) => {
      server.middlewares.use('/api/football', middleware)
    },
  }
}
