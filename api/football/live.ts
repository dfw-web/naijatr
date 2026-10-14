import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  handleFootball,
  readFootballKey,
  sharedFootballCache,
  splitFootballUrl,
} from '../../server/football/handlers.js'
import { readRapidApiKey } from '../../server/football/stream.js'

/** Vercel function for /api/football/live. API_FOOTBALL_KEY and RAPIDAPI_KEY stay server-side. */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { params } = splitFootballUrl(req.url ?? '')
  const ctx = {
    key: readFootballKey(process.env),
    rapidKey: readRapidApiKey(process.env),
    cache: sharedFootballCache,
  }
  await handleFootball(ctx, req.method, 'live', params, res)
}
