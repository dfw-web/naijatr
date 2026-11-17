import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { readRedisEnv } from '../redis.ts'
import { handleDramas, readEzvidKey, sharedDramaCache, splitDramaUrl } from './handlers.ts'

/** Serves /api/dramas/* in dev and preview, like the Vercel function in api/dramas/. */
export function dramasApi(env: Record<string, string>): Plugin {
  const redisEnv = readRedisEnv(env)
  // Connect strips the mount path, so req.url is e.g. /home?provider=dramabox
  const middleware = (req: IncomingMessage, res: ServerResponse) => {
    const { route, params } = splitDramaUrl(req.url ?? '')
    const ctx = { key: readEzvidKey(env), cache: sharedDramaCache, redis: redisEnv, adminPassword: env.ADMIN_PASSWORD ?? '', authorization: req.headers.authorization }
    void handleDramas(ctx, req, route, params, res)
  }
  return {
    name: 'dramas-api',
    configureServer: (server) => void server.middlewares.use('/api/dramas', middleware),
    configurePreviewServer: (server) => void server.middlewares.use('/api/dramas', middleware),
  }
}
