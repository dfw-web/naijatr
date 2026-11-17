/**
 * Short dramas from the Ezvid "Movies API Gateway" (https://api.ezvid.net/docs).
 * Every provider answers in its own shape; the adapters below turn them into
 * one: shelves of dramas, a drama's episodes, and an episode's video sources.
 *
 * Shared by the Vite dev/preview server (server/dramas/vite.ts) and the Vercel
 * function api/dramas/[route].ts. The key (EZVID_API_KEY) is only read on the
 * server and sent upstream in the X-API-Key header.
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */

export const EZVID_ORIGIN = 'https://api.ezvid.net'
const UPSTREAM_TIMEOUT_MS = 20_000

export const DRAMA_PROVIDERS = ['dramabox', 'dramawave', 'netshort'] as const
export type DramaProvider = (typeof DRAMA_PROVIDERS)[number]

export const PROVIDER_NAMES: Record<DramaProvider, string> = {
  dramabox: 'DramaBox',
  dramawave: 'DramaWave',
  netshort: 'NetShort',
}

export const isProvider = (value: string | null): value is DramaProvider =>
  DRAMA_PROVIDERS.includes(value as DramaProvider)

/** Provider ids are digits or short base62-ish keys. */
export const ID = /^[A-Za-z0-9_-]{1,40}$/

export interface Drama {
  provider: DramaProvider
  id: string
  title: string
  cover: string
  description: string
  tags: string[]
  episodes: number | null
  /** Views or a "3.1M"-style heat label, when the provider gives one. */
  popularity: string | null
}

export interface Shelf {
  title: string
  dramas: Drama[]
}

export interface Episode {
  id: string
  number: number
  title: string
  /** Paid in the provider's own app. */
  locked: boolean
}

export interface VideoSource {
  url: string
  type: 'mp4' | 'hls'
  quality: string
  /** Set when the video is H.265, which many desktop browsers can't play (NetShort). */
  codec?: 'hevc'
}

/** An episode list with each episode's sources (some providers give them with the list). */
export interface EpisodeList {
  title: string
  episodes: (Episode & { sources: VideoSource[] | null })[]
}

export class UpstreamError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Fetch = typeof fetch

/** One Ezvid call. Returns `data` from `{ ok: true, data }`, or throws UpstreamError. */
export async function ezvid(key: string, path: string, params: Record<string, string>, fetchImpl: Fetch = fetch): Promise<unknown> {
  const url = new URL(`/api/${path}`, EZVID_ORIGIN)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  let response: Response
  try {
    response = await fetchImpl(url, { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  } catch {
    throw new UpstreamError(502, 'unreachable')
  }
  const body = (await response.json().catch(() => null)) as { ok?: boolean; data?: unknown; message?: string } | null
  if (!response.ok || !body?.ok) throw new UpstreamError(response.status === 403 || response.status === 401 ? 403 : 502, body?.message ?? `HTTP ${response.status}`)
  return body.data
}

// ---- Small readers that never throw on odd data ----
type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const https = (v: unknown) => (/^https:\/\//.test(str(v)) ? str(v) : '')
const strings = (v: unknown) => arr(v).map(str).filter(Boolean).slice(0, 6)

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))

function drama(provider: DramaProvider, fields: Partial<Drama> & { id: string; title: string }): Drama | null {
  if (!ID.test(fields.id) || !fields.title) return null
  return {
    provider,
    id: fields.id,
    title: fields.title,
    cover: fields.cover ?? '',
    description: fields.description ?? '',
    tags: fields.tags ?? [],
    episodes: fields.episodes ?? null,
    popularity: fields.popularity ?? null,
  }
}

const present = <T>(items: (T | null)[]) => items.filter((item): item is T => item !== null)

/** Ezvid's normalized item ({ id, title, image, extra }), used by NetShort and DramaWave. */
function normalizedDrama(provider: DramaProvider, raw: unknown): Drama | null {
  const item = obj(raw)
  const extra = obj(item.extra)
  const views = num(extra.popularity) ?? num(extra.viewCount)
  return drama(provider, {
    id: str(item.id),
    title: str(item.title),
    cover: https(item.image),
    description: str(extra.description),
    tags: strings(extra.tags ?? extra.contentTags),
    episodes: num(extra.episodeCount),
    popularity: views === null ? null : compact(views),
  })
}

// ---- DramaBox ----
function dramaboxDrama(raw: unknown): Drama | null {
  const book = obj(raw)
  return drama('dramabox', {
    id: str(book.bookId),
    title: str(book.bookName),
    cover: https(book.coverWap),
    description: str(book.introduction),
    tags: strings(book.tags),
    episodes: num(book.chapterCount),
    popularity: str(obj(book.rankVo).hotCode) || null,
  })
}

function dramaboxEpisodes(data: unknown): EpisodeList['episodes'] {
  return present(
    arr(data).map((raw) => {
      const chapter = obj(raw)
      const id = str(chapter.chapterId)
      const index = num(chapter.chapterIndex)
      if (!ID.test(id) || index === null) return null
      const sources: VideoSource[] = []
      for (const [field, quality] of [['videoUrl1080', '1080p'], ['videoUrl720', '720p'], ['videoUrl540', '540p']] as const) {
        const url = https(chapter[field])
        if (url) sources.push({ url, type: 'mp4', quality })
      }
      if (!sources.length && https(chapter.videoUrl)) sources.push({ url: https(chapter.videoUrl), type: 'mp4', quality: 'auto' })
      return {
        id,
        number: index + 1,
        title: str(chapter.chapterName) || `Episode ${index + 1}`,
        locked: chapter.isLocked === true || chapter.isCharge === 1,
        sources,
      }
    }),
  )
}

// ---- DramaWave ----
function dramawaveHomeDrama(raw: unknown): Drama | null {
  const item = obj(raw)
  const views = num(item.view_count)
  return drama('dramawave', {
    id: str(item.key),
    title: str(item.title),
    cover: https(item.cover),
    description: str(item.desc),
    tags: strings(item.content_tags),
    episodes: num(item.episode_count),
    popularity: views === null ? null : compact(views),
  })
}

function normalizedEpisodes(data: unknown, withSources: boolean): EpisodeList['episodes'] {
  return present(
    arr(obj(data).items).map((raw, i) => {
      const item = obj(raw)
      const extra = obj(item.extra)
      const id = str(item.id)
      if (!ID.test(id)) return null
      const number = num(item.episodeNumber) ?? i + 1
      const sources = withSources
        ? present(
            arr(item.sources).map((s) => {
              const source = obj(s)
              const url = https(source.url)
              if (!url) return null
              return { url, type: source.type === 'm3u8' || /\.m3u8(\?|$)/.test(url) ? 'hls' : 'mp4', quality: str(source.quality) || 'auto' } as VideoSource
            }),
          )
        : null
      return {
        id,
        number,
        // DramaWave repeats the drama's name as each episode's title.
        title: `Episode ${number}`,
        locked: extra.isLocked === true || extra.isVip === true || extra.videoType === 'charge',
        sources,
      }
    }),
  )
}

// ---- NetShort ----
function netshortSources(data: unknown): VideoSource[] {
  const order = ['1080p', '720p', '540p']
  return present(
    arr(obj(data).episodePlayList).map((raw) => {
      const play = obj(raw)
      const url = https(play.playVoucher)
      // NetShort's files are H.265 (hvc1).
      return url ? ({ url, type: /\.m3u8(\?|$)/.test(url) ? 'hls' : 'mp4', quality: str(play.playClarity) || 'auto', codec: 'hevc' } as VideoSource) : null
    }),
  ).sort((a, b) => order.indexOf(a.quality) - order.indexOf(b.quality))
}

// ---- What each route asks each provider ----

export async function fetchHome(key: string, provider: DramaProvider, fetchImpl: Fetch = fetch): Promise<Shelf[]> {
  if (provider === 'dramabox') {
    const [latest, trending] = await Promise.allSettled([
      ezvid(key, 'dramabox/latest', { lang: 'en' }, fetchImpl),
      ezvid(key, 'dramabox/trending', { lang: 'en' }, fetchImpl),
    ])
    const shelves: Shelf[] = []
    if (trending.status === 'fulfilled') shelves.push({ title: 'Trending', dramas: present(arr(trending.value).map(dramaboxDrama)) })
    if (latest.status === 'fulfilled') shelves.push({ title: 'Latest', dramas: present(arr(latest.value).map(dramaboxDrama)) })
    if (!shelves.length) throw (latest as PromiseRejectedResult).reason
    return dedupeShelves(shelves)
  }
  if (provider === 'dramawave') {
    const data = obj(await ezvid(key, 'dramawave/home', { language: 'en-US', limit: '30' }, fetchImpl))
    return dedupeShelves([{ title: 'Popular', dramas: present(arr(data.items).map(dramawaveHomeDrama)) }])
  }
  const data = obj(await ezvid(key, 'netshort/home', { language: 'en_US', limit: '30' }, fetchImpl))
  return dedupeShelves(
    // "Coming Soon" dramas have no episodes yet.
    arr(data.shelves).filter((raw) => !/coming soon/i.test(str(obj(raw).title))).map((raw) => {
      const shelf = obj(raw)
      return { title: str(shelf.title) || 'Dramas', dramas: present(arr(shelf.items).map((item) => normalizedDrama('netshort', item))) }
    }),
  )
}

function dedupeShelves(shelves: Shelf[]): Shelf[] {
  return shelves.map((shelf) => ({ ...shelf, dramas: shelf.dramas.filter((d, i, all) => all.findIndex((o) => o.id === d.id) === i) })).filter((shelf) => shelf.dramas.length)
}

/** Every drama we can list for an app, for searching when its own search fails (DramaBox's returns nothing; DramaWave's often errors). */
export async function fetchCatalog(key: string, provider: DramaProvider, fetchImpl: Fetch = fetch): Promise<Drama[]> {
  const lists: Promise<Drama[]>[] = []
  const settle = async (load: () => Promise<Drama[]>) => load().catch(() => [] as Drama[])
  if (provider === 'dramabox') {
    const books = (path: string, params: Record<string, string>, pick: (data: unknown) => unknown[] = arr) =>
      settle(async () => present(pick(await ezvid(key, path, params, fetchImpl)).map(dramaboxDrama)))
    lists.push(books('dramabox/latest', { lang: 'en' }), books('dramabox/trending', { lang: 'en' }), books('dramabox/populersearch', { lang: 'en' }))
    lists.push(books('dramabox/dubbed', { lang: 'en', page: '1' }))
    for (let page = 1; page <= 8; page++) lists.push(books('dramabox/browse', { lang: 'en', page: String(page) }, (data) => arr(obj(data).items)))
  } else if (provider === 'dramawave') {
    lists.push(
      settle(async () => {
        // The home feed, then a few more of its pages.
        const dramas: Drama[] = []
        let data = obj(await ezvid(key, 'dramawave/home', { language: 'en-US', limit: '30' }, fetchImpl))
        for (let page = 0; page < 5; page++) {
          dramas.push(...present(arr(data.items).map(dramawaveHomeDrama)))
          const cursor = str(data.nextCursor)
          if (!cursor) break
          data = obj(await ezvid(key, 'dramawave/loadmore', { language: 'en-US', cursor }, fetchImpl).catch(() => ({})))
        }
        return dramas
      }),
      settle(async () => present(arr(obj(await ezvid(key, 'dramawave/search/hot-list', { language: 'en-US' }, fetchImpl)).items).map((item) => normalizedDrama('dramawave', item)))),
    )
  } else {
    lists.push(settle(async () => (await fetchHome(key, provider, fetchImpl)).flatMap((shelf) => shelf.dramas)))
  }
  const all = (await Promise.all(lists)).flat()
  return all.filter((d, i) => all.findIndex((o) => o.id === d.id) === i)
}

const words = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)

/** Dramas matching the query: title first, then tags, then the story. */
export function searchCatalog(catalog: Drama[], query: string): Drama[] {
  const terms = words(query)
  if (!terms.length) return []
  const phrase = terms.join(' ')
  const scored = catalog.map((drama) => {
    const title = words(drama.title).join(' ')
    const tags = words(drama.tags.join(' ')).join(' ')
    const story = words(drama.description).join(' ')
    let score = title.includes(phrase) ? 10 : 0
    for (const term of terms) {
      if (title.split(' ').some((w) => w.startsWith(term))) score += 3
      else if (tags.includes(term)) score += 2
      else if (story.split(' ').some((w) => w.startsWith(term))) score += 1
      // Every word must appear somewhere.
      else return { drama, score: 0 }
    }
    return { drama, score }
  })
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.drama).slice(0, 40)
}

export async function fetchSearch(key: string, provider: DramaProvider, query: string, fetchImpl: Fetch = fetch): Promise<Drama[]> {
  if (provider === 'dramabox') return present(arr(await ezvid(key, 'dramabox/search', { lang: 'en', query }, fetchImpl)).map(dramaboxDrama))
  const language = provider === 'dramawave' ? 'en-US' : 'en_US'
  const data = obj(await ezvid(key, `${provider}/search`, { q: query, language, limit: '30' }, fetchImpl))
  return present(arr(data.items).map((item) => normalizedDrama(provider, item)))
}

export async function fetchDetail(key: string, provider: DramaProvider, id: string, fetchImpl: Fetch = fetch): Promise<Drama | null> {
  if (provider === 'dramabox') return dramaboxDrama(await ezvid(key, 'dramabox/detail', { lang: 'en', bookId: id }, fetchImpl))
  const language = provider === 'dramawave' ? 'en-US' : 'en_US'
  const data = obj(await ezvid(key, `${provider}/detail/${id}`, { language }, fetchImpl))
  return normalizedDrama(provider, arr(data.items)[0] ?? data)
}

export async function fetchEpisodes(key: string, provider: DramaProvider, id: string, fetchImpl: Fetch = fetch): Promise<EpisodeList> {
  if (provider === 'dramabox') return { title: '', episodes: dramaboxEpisodes(await ezvid(key, 'dramabox/allepisode', { bookId: id }, fetchImpl)) }
  const language = provider === 'dramawave' ? 'en-US' : 'en_US'
  const data = await ezvid(key, `${provider}/episodes/${id}`, { language }, fetchImpl)
  // NetShort's list has no sources: each episode's comes from fetchSource.
  return { title: str(obj(obj(data).meta).title), episodes: normalizedEpisodes(data, provider !== 'netshort') }
}

/** NetShort only: one episode's sources. */
export async function fetchSource(key: string, provider: DramaProvider, id: string, episodeId: string, fetchImpl: Fetch = fetch): Promise<VideoSource[]> {
  if (provider !== 'netshort') return []
  return netshortSources(await ezvid(key, `netshort/episodes/${id}/${episodeId}/source`, { language: 'en_US' }, fetchImpl))
}
