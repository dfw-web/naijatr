import type { IncomingMessage, ServerResponse } from 'node:http'
import { handlePlay, splitApiUrl } from '../server/handlers.js'
import { readNextStreamConfig } from '../server/nextstream.js'

/** Vercel function for /api/play/* (routed here by vercel.json). */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = splitApiUrl(req.url ?? '', '/api/play')
  await handlePlay(readNextStreamConfig(process.env), path, params, res)
}
