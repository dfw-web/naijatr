import type { IncomingMessage, ServerResponse } from 'node:http'
import { readTmdbCredentials } from '../server/handlers.js'
import { readRedisEnv } from '../server/redis.js'
import { createIndexStore, handleSearchIndex } from '../server/searchIndex.js'

/** Shared by requests on the same instance when Redis isn't configured. */
const store = createIndexStore(readRedisEnv(process.env))

/** Vercel function for /api/search-index: the titles behind typo-tolerant search (server/searchIndex.ts). */
export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  await handleSearchIndex(readTmdbCredentials(process.env), store, res)
}
