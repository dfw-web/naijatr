import { deflateRawSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { decodeSubtitle, pickZipFile, toVtt, unzip } from './format'
import { cacheKey, handleSubtitles, RATE_LIMITS, readSubtitlesEnv, steps, type Deps } from './handlers'
import { osQuery, rank, searchSubdl, type Candidate, type TitleInfo } from './providers'

const SRT = '1\r\n00:00:01,000 --> 00:00:02,500\r\n{\\an8}<font color="#fff">Hello</font> <i>there</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nDownloaded from YTS.MX\r\n\r\n3\r\n00:01:00,5 --> 00:01:02,000\r\nBye\r\n'

/** A .zip with these files (deflated), like SubDL's. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name)
    const data = deflateRawSync(Buffer.from(text))
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, dir, end]))
}

describe('subtitle files', () => {
  it('turn .srt into WebVTT: timestamps, ASS tags and fonts out, <i> kept, ad lines dropped', () => {
    expect(toVtt(SRT)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello <i>there</i>\n\n00:01:00.500 --> 00:01:02.000\nBye\n')
    expect(toVtt('nothing here')).toBeNull()
  })

  it('decode UTF-8, UTF-16 and old Windows-1252 files', () => {
    expect(decodeSubtitle(new TextEncoder().encode('﻿Café'))).toBe('Café')
    expect(decodeSubtitle(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe('Café')
    expect(decodeSubtitle(new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]))).toBe('Hi')
  })

  it('come out of a zip: the episode by name, or the largest file for a movie', () => {
    const entries = unzip(zip({ 'Show.S01E04.srt': 'four', 'Show.S01E05.srt': 'five', 'readme.txt': 'x' }))
    expect(entries.map((e) => e.name)).toEqual(['Show.S01E04.srt', 'Show.S01E05.srt', 'readme.txt'])
    expect(new TextDecoder().decode(pickZipFile(entries, { season: 1, episode: 5 })!.data)).toBe('five')
    expect(pickZipFile(entries, { season: 1, episode: 9 })).toBeNull()
    const movie = unzip(zip({ 'forced.srt': 'a', 'Movie.2020.srt': 'the whole film' }))
    expect(pickZipFile(movie)!.name).toBe('Movie.2020.srt')
    // A season pack numbered by episode.
    const pack = unzip(zip({ '08 Second Sons.en.srt': '8', '09 The Rains of Castamere.en.srt': '9', '10 Mhysa.en.srt': '10' }))
    expect(pickZipFile(pack, { season: 3, episode: 9 })!.name).toBe('09 The Rains of Castamere.en.srt')
  })
})

describe('the search', () => {
  const movie: TitleInfo = { type: 'movie', tmdbId: 550, imdbId: 'tt0137523', title: 'Fight Club', originalTitle: 'Fight Club', year: 1999, anime: false, seasonEpisodes: [] }
  const anime: TitleInfo = { type: 'tv', tmdbId: 37854, imdbId: 'tt0388629', title: 'One Piece', originalTitle: 'ワンピース', year: 1999, anime: true, seasonEpisodes: [0, 61, 16] }

  it('goes TMDB id → IMDb id → title + year → title on OpenSubtitles, then SubDL', () => {
    expect(steps(movie, null).map((s) => s.name)).toEqual([
      'opensubtitles:tmdb',
      'opensubtitles:imdb',
      'opensubtitles:title+year',
      'opensubtitles:title',
      'subdl:tmdb',
      'subdl:imdb',
      'subdl:title',
    ])
  })

  it('for anime, also tries the episode counted from the start (S3E2 = episode 79)', () => {
    const list = steps(anime, { season: 3, episode: 2 })
    expect(list.map((s) => s.name)).toContain('opensubtitles:anime-absolute')
    const abs = list.find((s) => s.name === 'opensubtitles:anime-absolute')!.search('en')
    expect('params' in abs && abs.params.episode_number).toBe(79)
    expect(list.at(-1)!.name).toBe('subdl:anime-absolute')
  })

  it('sends OpenSubtitles sorted, lower-case queries with "+" for spaces (no redirects)', () => {
    expect(osQuery({ type: 'movie', query: 'Fight Club', languages: 'en', page: 1 })).toBe('languages=en&page=1&query=fight+club&type=movie')
  })

  it('picks the most downloaded, not hearing-impaired, not machine-translated', () => {
    const c = (ref: string, downloads: number, hearingImpaired = false, machine = false): Candidate => ({ provider: 'opensubtitles', ref, lang: 'en', downloads, hearingImpaired, machine, release: '' })
    expect(rank([c('mt', 9000, false, true), c('hi', 5000, true), c('ok', 100), c('best', 300)]).map((x) => x.ref)).toEqual(['best', 'ok', 'hi', 'mt'])
  })
})

// ——— The handler, against fake OpenSubtitles, SubDL, TMDB and Upstash ———

function world(opts: { os?: 'ok' | 'quota' | 'none'; subdl?: 'ok' | 'none' } = {}) {
  const kv = new Map<string, string>()
  const hashes = new Map<string, Map<string, string>>()
  const lists = new Map<string, string[]>()
  const calls: string[] = []
  const zipBytes = zip({ 'Fight.Club.srt': SRT })
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.startsWith('https://redis.test/pipeline')) {
      const out = (JSON.parse(String(init?.body)) as string[][]).map(([cmd, key, ...args]) => {
        const h = hashes.get(key) ?? new Map<string, string>()
        hashes.set(key, h)
        switch (cmd) {
          case 'GET':
            return { result: kv.get(key) ?? null }
          case 'SET':
            kv.set(key, args[0])
            return { result: 'OK' }
          case 'INCR': {
            const n = Number(kv.get(key) ?? 0) + 1
            kv.set(key, String(n))
            return { result: n }
          }
          case 'HINCRBY':
            h.set(args[0], String(Number(h.get(args[0]) ?? 0) + Number(args[1])))
            return { result: 1 }
          case 'HSET':
            h.set(args[0], args[1])
            return { result: 1 }
          case 'HGETALL':
            return { result: [...h].flat() }
          case 'SADD': {
            const set = new Set(JSON.parse(kv.get(key) ?? '[]') as string[])
            set.add(args[0])
            kv.set(key, JSON.stringify([...set]))
            return { result: 1 }
          }
          case 'SCARD':
            return { result: (JSON.parse(kv.get(key) ?? '[]') as string[]).length }
          case 'LPUSH':
            lists.set(key, [args[0], ...(lists.get(key) ?? [])])
            return { result: 1 }
          case 'LRANGE':
            return { result: (lists.get(key) ?? []).slice(Number(args[0]), Number(args[1]) + 1) }
          case 'SCAN': {
            const pattern = new RegExp(`^${args[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
            return { result: ['0', [...kv.keys()].filter((k) => pattern.test(k))] }
          }
          case 'DEL':
            for (const k of [key, ...args]) kv.delete(k)
            return { result: 1 }
          default:
            return { result: 1 }
        }
      })
      return json(out)
    }
    calls.push(url.replace(/api_key=[^&]+/, 'api_key=…'))
    if (url.startsWith('https://api.themoviedb.org/3/movie/550')) {
      return json({ title: 'Fight Club', original_title: 'Fight Club', release_date: '1999-10-15', imdb_id: 'tt0137523', external_ids: { imdb_id: 'tt0137523' }, genres: [] })
    }
    if (url.startsWith('https://api.opensubtitles.com/api/v1/login')) return json({ token: 'tok', base_url: 'api.opensubtitles.com' })
    if (url.startsWith('https://api.opensubtitles.com/api/v1/subtitles')) {
      if (opts.os === 'none' || !url.includes('tmdb_id=550')) return json({ data: [], total_pages: 0 })
      return json({
        total_pages: 1,
        data: [
          { attributes: { language: 'en', download_count: 10, hearing_impaired: true, files: [{ file_id: 1 }] } },
          { attributes: { language: 'en', download_count: 5, files: [{ file_id: 2 }] } },
        ],
      })
    }
    if (url.startsWith('https://api.opensubtitles.com/api/v1/download')) {
      if (opts.os === 'quota') return json({ message: 'You have downloaded your allowed 20 subtitles for 24h' }, 406)
      expect(JSON.parse(String(init?.body))).toEqual({ file_id: 2 })
      return json({ link: 'https://dl.opensubtitles.test/2.srt', remaining: 17 })
    }
    if (url.startsWith('https://dl.opensubtitles.test/')) return new Response(SRT)
    if (url.startsWith('https://api.subdl.com/')) {
      if (opts.subdl === 'none') return json({ status: false })
      return json({ status: true, totalPages: 1, subtitles: [{ url: '/subtitle/1-2.zip?api_key=subdl-key', language: 'EN', release_name: 'Fight.Club.1999.BluRay' }] })
    }
    if (url.startsWith('https://dl.subdl.com/')) return new Response(zipBytes)
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  const env = {
    ...readSubtitlesEnv({
      SUBTITLES_ENABLED: 'true',
      OPENSUBTITLES_API_KEY: 'os-key',
      OPENSUBTITLES_USERNAME: 'u',
      OPENSUBTITLES_PASSWORD: 'p',
      SUBDL_API_KEY: 'subdl-key',
      TMDB_API_KEY: 'tmdb',
      KV_REST_API_URL: 'https://redis.test',
      KV_REST_API_TOKEN: 't',
      ADMIN_PASSWORD: 'admin',
    }),
  }
  const logs: string[] = []
  const deps: Deps = { fetch: fake, now: () => Date.UTC(2026, 10, 11, 12), log: (m) => logs.push(m) }
  const call = async (action: string, query: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) => {
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v }, end(b: string) { this.body = b } }
    const req = { method, headers: { 'x-forwarded-for': '1.2.3.4', ...headers }, body }
    await handleSubtitles(env, action, new URLSearchParams(query), req as unknown as IncomingMessage, res as unknown as ServerResponse, deps)
    return res
  }
  return { kv, calls, logs, call, env }
}

describe('/api/subtitles', () => {
  const FIGHT_CLUB = 'tmdbId=550&type=movie&lang=en'

  it('finds it on OpenSubtitles by TMDB id (not the hearing-impaired one), caches it, and serves the next one from the cache', async () => {
    const w = world()
    const first = await w.call('', FIGHT_CLUB)
    expect(first.statusCode).toBe(200)
    expect(first.headers['Content-Type']).toMatch(/text\/vtt/)
    expect(first.headers['X-Subtitle-Source']).toBe('opensubtitles:tmdb')
    expect(first.body).toContain('Hello <i>there</i>')
    expect(w.kv.get(cacheKey({ type: 'movie', tmdbId: 550, episode: null, lang: 'en' }))).toMatch(/^opensubtitles:tmdb\|os:2\nWEBVTT/)
    expect(w.logs).toContain('[subtitles] subs:550:0:0:en found by opensubtitles:tmdb')
    const before = w.calls.length
    const again = await w.call('', FIGHT_CLUB)
    expect(again.body).toBe(first.body)
    expect(w.calls.length).toBe(before)
  })

  it('goes straight to SubDL once OpenSubtitles is out of downloads, and takes the .srt out of the zip', async () => {
    const w = world({ os: 'quota' })
    const res = await w.call('', FIGHT_CLUB)
    expect(res.statusCode).toBe(200)
    expect(res.headers['X-Subtitle-Source']).toBe('subdl:tmdb')
    expect(res.body).toContain('Bye')
    // The limit is remembered: the next title doesn't ask OpenSubtitles at all.
    w.calls.length = 0
    await w.call('', 'tmdbId=550&type=movie&lang=fr')
    expect(w.calls.some((u) => u.includes('opensubtitles'))).toBe(false)
  })

  it('remembers "not found" for a day', async () => {
    const w = world({ os: 'none', subdl: 'none' })
    expect((await w.call('', FIGHT_CLUB)).statusCode).toBe(404)
    expect(w.kv.get('subs:550:0:0:en')).toBe('none')
    const before = w.calls.length
    expect((await w.call('', FIGHT_CLUB)).statusCode).toBe(404)
    expect(w.calls.length).toBe(before)
  })

  it('rate-limits new searches per IP, so nobody can drain the quota', async () => {
    const w = world({ os: 'none', subdl: 'none' })
    for (let i = 1; i <= RATE_LIMITS.missesPer10Min; i++) await w.call('', `tmdbId=${1000 + i}&type=movie&lang=en`)
    expect((await w.call('', 'tmdbId=999&type=movie&lang=en')).statusCode).toBe(429)
    // Another visitor is fine.
    expect((await w.call('', 'tmdbId=998&type=movie&lang=en', { 'x-forwarded-for': '5.6.7.8' })).statusCode).toBe(404)
  })

  it('refuses bad requests and stays off without SUBTITLES_ENABLED', async () => {
    const w = world()
    expect((await w.call('', 'tmdbId=abc&type=movie')).statusCode).toBe(400)
    expect((await w.call('', 'tmdbId=1&type=tv&lang=en')).statusCode).toBe(400)
    w.env.enabled = false
    expect((await w.call('', FIGHT_CLUB)).statusCode).toBe(404)
  })

  it('lists the languages, English first', async () => {
    const w = world()
    const res = await w.call('languages', 'tmdbId=550&type=movie')
    expect(JSON.parse(res.body).languages[0]).toEqual({ code: 'en', name: 'English', available: true })
  })

  it('/admin: today\'s numbers, behind ADMIN_PASSWORD', async () => {
    const w = world()
    expect((await w.call('admin', '')).statusCode).toBe(401)
    await w.call('', FIGHT_CLUB)
    await w.call('', FIGHT_CLUB)
    const body = JSON.parse((await w.call('admin', '', { authorization: 'Bearer admin' })).body)
    expect(body).toMatchObject({ served: 2, cacheHits: 1, downloads: 1, osRemaining: 17, subdlFallbacks: 0, steps: { 'opensubtitles:tmdb': 1 } })
  })
})

describe('syncing help', () => {
  const FIGHT_CLUB = { tmdbId: 550, type: 'movie', lang: 'en' }
  const post = (w: ReturnType<typeof world>, action: string, body: unknown, ip = '1.2.3.4') => w.call(action, '', { 'x-forwarded-for': ip }, 'POST', body)

  it('lists the versions, labelled, the one playing first, with no key in them', async () => {
    const w = world()
    await w.call('', 'tmdbId=550&type=movie&lang=en')
    const res = await w.call('versions', 'tmdbId=550&type=movie&lang=en')
    const { versions } = JSON.parse(res.body) as { versions: { id: string; label: string }[] }
    expect(versions[0]).toMatchObject({ id: 'os:2', label: 'Version 1 (OpenSubtitles)' })
    expect(versions.map((v) => v.id)).toContain('sd:/subtitle/1-2.zip')
    expect(versions.find((v) => v.id.startsWith('sd:'))!.label).toMatch(/^Version \d \(BluRay\)$/)
    expect(res.body).not.toContain('subdl-key')
  })

  it('serves a chosen version, and caches it', async () => {
    const w = world()
    const res = await w.call('', 'tmdbId=550&type=movie&lang=en&version=sd:/subtitle/1-2.zip')
    expect(res.statusCode).toBe(200)
    expect(res.headers['X-Subtitle-Version']).toBe('sd:/subtitle/1-2.zip')
    expect(w.calls.some((u) => u.startsWith('https://dl.subdl.com/subtitle/1-2.zip?api_key='))).toBe(true)
    const before = w.calls.length
    await w.call('', 'tmdbId=550&type=movie&lang=en&version=sd:/subtitle/1-2.zip')
    expect(w.calls.length).toBe(before)
    expect((await w.call('', 'tmdbId=550&type=movie&lang=en&version=https://evil')).statusCode).toBe(400)
  })

  it('makes a setting the default once 3 different viewers chose it; the next viewer gets it with the offset', async () => {
    const w = world()
    await w.call('', 'tmdbId=550&type=movie&lang=en')
    const setting = { ...FIGHT_CLUB, version: 'sd:/subtitle/1-2.zip', offset: 2.5, speed: '23.976-25' }
    expect(JSON.parse((await post(w, 'vote', setting, '1.1.1.1')).body)).toMatchObject({ voters: 1, isDefault: false })
    // The same viewer twice still counts once.
    expect(JSON.parse((await post(w, 'vote', setting, '1.1.1.1')).body)).toMatchObject({ voters: 1 })
    await post(w, 'vote', setting, '2.2.2.2')
    expect(JSON.parse((await post(w, 'vote', setting, '3.3.3.3')).body)).toMatchObject({ voters: 3, isDefault: true })
    const res = await w.call('', 'tmdbId=550&type=movie&lang=en', { 'x-forwarded-for': '9.9.9.9' })
    expect(res.headers).toMatchObject({ 'X-Subtitle-Community': '1', 'X-Subtitle-Offset': '2.5', 'X-Subtitle-Speed': '23.976-25', 'X-Subtitle-Version': 'sd:/subtitle/1-2.zip' })
  })

  it('doesn\'t count "no change" as a fix, and refuses bad settings', async () => {
    const w = world()
    await w.call('', 'tmdbId=550&type=movie&lang=en')
    expect(JSON.parse((await post(w, 'vote', { ...FIGHT_CLUB, version: 'os:2', offset: 0, speed: '1' })).body)).toMatchObject({ counted: false })
    expect((await post(w, 'vote', { ...FIGHT_CLUB, version: 'os:2', offset: 1, speed: 'fast' })).statusCode).toBe(400)
    expect((await w.call('vote', 'tmdbId=550&type=movie')).statusCode).toBe(405)
  })

  it('logs "out of sync" reports for /admin/live: the title, episode and version, worst titles first', async () => {
    const w = world()
    const report = { tmdbId: 1399, type: 'tv', season: 3, episode: 9, lang: 'en', version: 'os:7', offset: -1, speed: '1', title: 'Game of Thrones', server: 'embedmaster' }
    await post(w, 'report', report)
    await post(w, 'report', report, '5.5.5.5')
    await post(w, 'report', { ...FIGHT_CLUB, title: 'Fight Club' })
    expect(w.logs).toContain('[subtitles] out of sync: Game of Thrones S3E9 (1399:3:9:en) version os:7 offset -1s speed 1')
    const body = JSON.parse((await w.call('admin', '', { authorization: 'Bearer admin' })).body)
    expect(body.outOfSyncToday).toBe(3)
    expect(body.badTitles[0]).toEqual({ slot: '1399:3:9:en', title: 'Game of Thrones S3E9 (en)', reports: 2 })
    expect(body.reports[0]).toMatchObject({ title: 'Fight Club', tmdbId: 550 })
    expect(body.reports[1]).toMatchObject({ title: 'Game of Thrones S3E9', season: 3, episode: 9, version: 'os:7', offset: -1, server: 'embedmaster' })
  })

  it('admin can clear a title\'s cache (a stale "not found")', async () => {
    const w = world({ os: 'none', subdl: 'none' })
    await w.call('', 'tmdbId=550&type=movie&lang=en')
    expect(w.kv.get('subs:550:0:0:en')).toBe('none')
    expect((await w.call('admin-flush', 'tmdbId=550', {}, 'POST')).statusCode).toBe(401)
    const res = await w.call('admin-flush', 'tmdbId=550', { authorization: 'Bearer admin' }, 'POST')
    expect(JSON.parse(res.body).deleted).toBeGreaterThan(0)
    expect(w.kv.has('subs:550:0:0:en')).toBe(false)
  })
})

describe('SubDL packs', () => {
  it('match an episode inside a pack\'s range (episodes 1-6 is listed as episode 1)', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          status: true,
          totalPages: 1,
          subtitles: [
            { url: '/subtitle/a.zip', language: 'EN', season: 1, episode: 1, episode_from: 1, episode_end: 6, release_name: '𝘞𝘌𝘉-𝘋𝘓 01-06' },
            { url: '/subtitle/b.zip', language: 'EN', season: 1, episode: 7, episode_from: 7, episode_end: 11, release_name: '07-11' },
          ],
        }),
      )) as unknown as typeof fetch
    const found = await searchSubdl('k', { params: {}, episode: { season: 1, episode: 3 } }, fake)
    expect(found.map((c) => c.ref)).toEqual(['/subtitle/a.zip'])
    expect(found[0].release).toBe('WEB-DL 01-06')
  })
})
