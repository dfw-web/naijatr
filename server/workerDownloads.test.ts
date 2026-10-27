import { describe, expect, it, vi } from 'vitest'
import { createWorkerDownloads, downloadName, readWorkerDownloadConfig } from './workerDownloads'

const config = { workerUrl: 'https://worker.example', apiKey: 'k3y', sourceId: 'licensed-player' }
const ID = '1d384563-e3f2-4838-815d-96ebd429c8d7'

const fakeResponse = () => {
  const res = { statusCode: 0, body: '', headers: {} as Record<string, string>, setHeader: (k: string, v: string) => void (res.headers[k] = v), end: (b: string) => void (res.body = b) }
  return res
}
const call = async (service: ReturnType<typeof createWorkerDownloads>, method: string, path: string, body: unknown = null) => {
  const res = fakeResponse()
  await service.handle(method, path, body, res as never)
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers }
}

describe('readWorkerDownloadConfig', () => {
  it('reads the server-only settings', () => {
    expect(readWorkerDownloadConfig({ DOWNLOAD_WORKER_URL: 'https://w.example/', WORKER_API_KEY: ' k ', DOWNLOAD_SOURCE_ID: 'p' })).toEqual({ workerUrl: 'https://w.example', apiKey: 'k', sourceId: 'p' })
  })
})

describe('createWorkerDownloads', () => {
  it('starts a job with the configured source and numbers only; the key stays server-side', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: ID, token: 'tok/en', attribution: 'CC BY' }, { status: 202 }))
    const out = await call(createWorkerDownloads(config, fetchImpl as never), 'POST', '/job', { type: 'tv', tmdbId: 1399, season: 1, episode: 2, quality: '720', title: 'Dark: Ōne!', url: 'https://evil.example/' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://worker.example/download/start')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer k3y')
    expect(JSON.parse(String(init?.body))).toEqual({ sourceId: 'licensed-player', type: 'tv', tmdbId: '1399', season: '1', episode: '2', quality: '720', filename: 'Dark-One-S01E02' })
    expect(out.status).toBe(202)
    expect(out.body).toEqual({ id: ID, fileUrl: `https://worker.example/download/file/${ID}?token=tok%2Fen`, attribution: 'CC BY' })
    expect(JSON.stringify(out.body)).not.toContain('k3y')
    expect(out.headers['Cache-Control']).toBe('no-store')
  })

  it('refuses bad input before calling the worker', async () => {
    const fetchImpl = vi.fn()
    const service = createWorkerDownloads(config, fetchImpl as never)
    for (const body of [{ type: 'movie', tmdbId: '../1' }, { type: 'tv', tmdbId: 1 }, { type: 'movie', tmdbId: 1, quality: '4k' }, { type: 'x', tmdbId: 1 }, null]) {
      expect((await call(service, 'POST', '/job', body)).status).toBe(400)
    }
    expect((await call(service, 'GET', '/job/not-a-uuid')).status).toBe(405)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('passes status through without worker internals', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: ID, state: 'downloading', progress: { done: 3, total: 64 }, variant: { id: '2', width: 848, height: 480, bandwidth: 1 }, audioTracks: [] }))
    const out = await call(createWorkerDownloads(config, fetchImpl as never), 'GET', `/job/${ID}`)
    expect(out.body).toEqual({ state: 'downloading', progress: { done: 3, total: 64 }, error: null, filename: null, bytes: null, height: 480 })
  })

  it('maps busy, gone, worker errors and unreachable', async () => {
    const answer = (response: () => Response) => createWorkerDownloads(config, (async () => response()) as never)
    expect((await call(answer(() => Response.json({ error: 'worker is busy' }, { status: 429 })), 'POST', '/job', { type: 'movie', tmdbId: 1 })).body.reason).toBe('busy')
    expect((await call(answer(() => Response.json({ error: 'not found' }, { status: 404 })), 'GET', `/job/${ID}`)).status).toBe(404)
    expect((await call(answer(() => Response.json({ error: 'unknown approved source' }, { status: 404 })), 'POST', '/job', { type: 'movie', tmdbId: 1 })).body).toEqual({ reason: 'error', message: 'unknown approved source' })
    const down = createWorkerDownloads(config, (async () => { throw new TypeError('fetch failed') }) as never)
    expect(await call(down, 'POST', '/job', { type: 'movie', tmdbId: 1 })).toMatchObject({ status: 502, body: { reason: 'unreachable' } })
  })

  it('cancels and reports not-configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    expect((await call(createWorkerDownloads(config, fetchImpl as never), 'DELETE', `/job/${ID}`)).body).toEqual({ cancelled: true })
    expect((await call(createWorkerDownloads({ ...config, apiKey: '' }), 'POST', '/job', {})).status).toBe(503)
  })

  it('names the file from the title', () => {
    expect(downloadName('Amélie (2001)')).toBe('Amelie-2001')
    expect(downloadName('', '2', '10')).toBe('download-S02E10')
  })
})
