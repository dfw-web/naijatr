import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDramas, readEzvidKey, sharedDramaCache, splitDramaUrl } from '../../server/dramas/handlers.js'
import { readRedisEnv } from '../../server/redis.js'

/**
 * One Vercel function for every /api/dramas/* route (server/dramas/handlers.ts),
 * so they share one warm instance and its cache. EZVID_API_KEY, the Redis token
 * and ADMIN_PASSWORD stay server-side.
 */
const redisEnv = readRedisEnv(process.env)

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { route, params } = splitDramaUrl(req.url ?? '')
  // Vercel may add the file's [route] segment to the query.
  params.delete('route')
  const ctx = {
    key: readEzvidKey(process.env),
    cache: sharedDramaCache,
    redis: redisEnv,
    adminPassword: process.env.ADMIN_PASSWORD ?? '',
    authorization: req.headers?.authorization,
  }
  await handleDramas(ctx, req, route, params, res)
}
