import type { IncomingMessage, ServerResponse } from 'node:http'
import { getCache } from '@vercel/functions'
import { createFootballCache, handleFootball, readFootballKey, splitFootballUrl } from '../../server/football/handlers.js'
import { readRapidApiKey } from '../../server/football/stream.js'

/**
 * One Vercel function for every /api/football/* route, so they share one warm
 * instance and its memory. The Runtime Cache shares answers between instances
 * and keeps them across cold starts, so the providers are asked as rarely as
 * possible. API_FOOTBALL_KEY and RAPIDAPI_KEY stay server-side.
 */
const cache = createFootballCache(Date.now, getCache({ namespace: 'football' }))

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { route, params } = splitFootballUrl(req.url ?? '')
  // Vercel may add the file's [route] segment to the query.
  params.delete('route')
  const ctx = {
    key: readFootballKey(process.env),
    rapidKey: readRapidApiKey(process.env),
    cache,
  }
  await handleFootball(ctx, req.method, route, params, res)
}
