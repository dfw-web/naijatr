import type { IncomingMessage, ServerResponse } from 'node:http'
import { getCache } from '@vercel/functions'
import { createPlayCache, handlePlay, splitApiUrl } from '../server/handlers.js'
import { readNextStreamConfig } from '../server/nextstream.js'

/** The saved player page and sources, shared between instances (see handlePlay). */
const cache = createPlayCache(getCache({ namespace: 'play' }))

/** Vercel function for /api/play/* (routed here by vercel.json). */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = splitApiUrl(req.url ?? '', '/api/play')
  await handlePlay(readNextStreamConfig(process.env), path, params, res, fetch, cache)
}
