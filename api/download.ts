import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDownload, splitApiUrl } from '../server/handlers.js'
import { createMovieboxDownloads, readMovieboxConfig } from '../server/moviebox.js'
import { readNextStreamConfig } from '../server/nextstream.js'
import { readRedisEnv } from '../server/redis.js'
import { createWorkerDownloads, readJsonBody, readWorkerDownloadConfig } from '../server/workerDownloads.js'

/** The Download button's MovieBox options (/api/download/options); the Worker secret stays here. */
const moviebox = createMovieboxDownloads(readMovieboxConfig(process.env, readRedisEnv(process.env)))
/** Download jobs on the naijatr-download-worker (/api/download/job...); WORKER_API_KEY stays here. */
const workerDownloads = createWorkerDownloads(readWorkerDownloadConfig(process.env))

/** Vercel function for /api/download/* (routed here by vercel.json). */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = splitApiUrl(req.url ?? '', '/api/download')
  if (path === '/options') return moviebox.handle(params, res)
  if (path === '/job' || path.startsWith('/job/'))
    return workerDownloads.handle(req.method ?? 'GET', path, req.method === 'POST' ? await readJsonBody(req) : null, res)
  handleDownload(readNextStreamConfig(process.env), path, res)
}
