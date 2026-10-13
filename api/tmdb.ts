import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleTmdb, readTmdbCredentials, splitApiUrl } from '../server/handlers.js'

/** Vercel function for /api/tmdb/* (routed here by vercel.json). Credentials stay server-side. */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = splitApiUrl(req.url ?? '', '/api/tmdb')
  await handleTmdb(readTmdbCredentials(process.env), req.method, path, params, res)
}
