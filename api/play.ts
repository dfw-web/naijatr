import type { IncomingMessage, ServerResponse } from 'node:http'
import { getCache, waitUntil } from '@vercel/functions'
import { createPlayCache, handlePlay, splitApiUrl } from '../server/handlers.js'
import { recordPlayReport } from '../server/live/handlers.js'
import { readNextStreamConfig } from '../server/nextstream.js'
import { readRedisEnv } from '../server/redis.js'

/** The saved player page and sources, shared between instances (see handlePlay). */
const cache = createPlayCache(getCache({ namespace: 'play' }))

/** Vercel function for /api/play/* (routed here by vercel.json). Calls on our key are counted for /admin/live. */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = splitApiUrl(req.url ?? '', '/api/play')
  const redisEnv = readRedisEnv(process.env)
  await handlePlay(readNextStreamConfig(process.env), path, params, res, fetch, cache, {
    userAgent: req.headers?.['user-agent'],
    report: (event) => waitUntil(recordPlayReport(redisEnv, event, Date.now())),
  })
}
