import type { IncomingMessage, ServerResponse } from 'node:http'
import { splitApiUrl } from '../server/handlers.js'
import { handleSubtitles, readSubtitlesEnv } from '../server/subtitles/handlers.js'

/** Vercel function for /api/subtitles and /api/subtitles/* (routed here by vercel.json). The subtitle API keys stay server-side. */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = splitApiUrl(req.url ?? '', '/api/subtitles')
  await handleSubtitles(readSubtitlesEnv(process.env), path.replace(/^\/+|\/+$/g, ''), params, req, res)
}
