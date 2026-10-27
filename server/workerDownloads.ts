import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Downloads through the naijatr-download-worker (Render): /api/download/job...
 * The site names the worker's approved source (DOWNLOAD_SOURCE_ID) and the
 * title's numbers; it never sends a URL. WORKER_API_KEY stays here. The
 * browser gets only the job's own one-time file link, which the worker
 * deletes once the file has been sent (or an hour after the job finished).
 */
export interface WorkerDownloadConfig {
  workerUrl: string
  apiKey: string
  sourceId: string
}

export function readWorkerDownloadConfig(env: Record<string, string | undefined>): WorkerDownloadConfig {
  return {
    workerUrl: (env.DOWNLOAD_WORKER_URL?.trim() ?? '').replace(/\/+$/, ''),
    apiKey: env.WORKER_API_KEY?.trim() ?? '',
    sourceId: env.DOWNLOAD_SOURCE_ID?.trim() ?? '',
  }
}

export const isWorkerDownloadConfigured = (config: WorkerDownloadConfig) =>
  Boolean(config.workerUrl && config.apiKey && config.sourceId)

/** The worker's job states, passed to the browser as they are. */
export type JobState = 'queued' | 'resolving' | 'downloading' | 'remuxing' | 'ready' | 'error'

export interface JobStatus {
  state: JobState
  progress: { done: number; total: number }
  error: string | null
  filename: string | null
  bytes: number | null
  height: number | null
}

const QUALITIES = new Set(['best', 'worst', '1080', '720', '480', '360'])
const NUMBER = /^\d{1,9}$/
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A free Render instance can take most of a minute to wake up.
const START_TIMEOUT_MS = 60_000
const STATUS_TIMEOUT_MS = 15_000

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** A small JSON body, or null. Vercel may have parsed it already (req.body). */
export async function readJsonBody(req: IncomingMessage, limit = 2048): Promise<unknown> {
  const parsed = (req as IncomingMessage & { body?: unknown }).body
  if (parsed !== undefined) {
    if (typeof parsed !== 'string') return parsed
    try {
      return parsed.length > limit ? null : JSON.parse(parsed)
    } catch {
      return null
    }
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** A file name from the title (and episode), for the saved file. */
export function downloadName(title: unknown, season?: string, episode?: string) {
  const base = String(title ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  const episodePart = season && episode ? `-S${season.padStart(2, '0')}E${episode.padStart(2, '0')}` : ''
  return `${base || 'download'}${episodePart}`
}

export function createWorkerDownloads(config: WorkerDownloadConfig, fetchImpl: typeof fetch = fetch) {
  const worker = async (path: string, init: RequestInit, timeoutMs: number) =>
    fetchImpl(`${config.workerUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  /** The worker's own message (they never carry secrets or URLs), else a generic one. */
  const errorOf = async (response: Response) => {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    return typeof body?.error === 'string' ? body.error.slice(0, 200) : `worker answered ${response.status}`
  }

  async function start(body: unknown, res: ServerResponse) {
    const b = (body ?? {}) as Record<string, unknown>
    const type = b.type === 'tv' ? 'tv' : b.type === 'movie' ? 'movie' : null
    const tmdbId = String(b.tmdbId ?? '')
    const season = String(b.season ?? '')
    const episode = String(b.episode ?? '')
    const quality = String(b.quality ?? 'best')
    if (!type || !NUMBER.test(tmdbId) || (type === 'tv' && (!NUMBER.test(season) || !NUMBER.test(episode))) || !QUALITIES.has(quality))
      return sendJson(res, 400, { reason: 'bad-request' })
    const request = {
      sourceId: config.sourceId,
      type,
      tmdbId,
      ...(type === 'tv' ? { season, episode } : {}),
      quality,
      filename: downloadName(b.title, type === 'tv' ? season : undefined, type === 'tv' ? episode : undefined),
    }
    const response = await worker('/download/start', { method: 'POST', body: JSON.stringify(request) }, START_TIMEOUT_MS)
    if (response.status === 429) return sendJson(res, 429, { reason: 'busy', message: 'The downloader is busy with another file. Try again in a few minutes.' })
    if (!response.ok) return sendJson(res, 502, { reason: 'error', message: await errorOf(response) })
    const job = (await response.json()) as { id?: unknown; token?: unknown; attribution?: unknown }
    if (typeof job.id !== 'string' || !JOB_ID.test(job.id) || typeof job.token !== 'string') return sendJson(res, 502, { reason: 'error' })
    sendJson(res, 202, {
      id: job.id,
      fileUrl: `${config.workerUrl}/download/file/${job.id}?token=${encodeURIComponent(job.token)}`,
      attribution: typeof job.attribution === 'string' ? job.attribution : null,
    })
  }

  async function status(id: string, res: ServerResponse) {
    const response = await worker(`/download/status/${id}`, { method: 'GET' }, STATUS_TIMEOUT_MS)
    if (response.status === 404) return sendJson(res, 404, { reason: 'gone' })
    if (!response.ok) return sendJson(res, 502, { reason: 'error', message: await errorOf(response) })
    const s = (await response.json()) as Record<string, unknown>
    const progress = (s.progress ?? {}) as Record<string, unknown>
    const out: JobStatus = {
      state: s.state as JobState,
      progress: { done: Number(progress.done) || 0, total: Number(progress.total) || 0 },
      error: typeof s.error === 'string' ? s.error.slice(0, 200) : null,
      filename: typeof s.filename === 'string' ? s.filename : null,
      bytes: typeof s.bytes === 'number' ? s.bytes : null,
      height: typeof (s.variant as { height?: unknown } | undefined)?.height === 'number' ? (s.variant as { height: number }).height : null,
    }
    sendJson(res, 200, out)
  }

  async function cancel(id: string, res: ServerResponse) {
    const response = await worker(`/download/${id}`, { method: 'DELETE' }, STATUS_TIMEOUT_MS)
    sendJson(res, response.status === 204 || response.status === 404 ? 200 : 502, { cancelled: response.status === 204 })
  }

  /** POST /job (start), GET /job/:id (status), DELETE /job/:id (cancel). */
  async function handle(method: string, path: string, body: unknown, res: ServerResponse) {
    if (!isWorkerDownloadConfigured(config)) return sendJson(res, 503, { reason: 'not-configured' })
    const id = path.startsWith('/job/') ? path.slice(5) : null
    try {
      if (path === '/job' && method === 'POST') return await start(body, res)
      if (id && JOB_ID.test(id) && method === 'GET') return await status(id, res)
      if (id && JOB_ID.test(id) && method === 'DELETE') return await cancel(id, res)
      sendJson(res, path === '/job' || id ? 405 : 404, { reason: 'bad-request' })
    } catch {
      // Timeouts and network errors: no worker details to the browser.
      sendJson(res, 502, { reason: 'unreachable', message: 'The downloader could not be reached. Try again shortly.' })
    }
  }

  return { handle }
}
