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

/**
 * Provider ids: digits, short base62-ish keys, or (DramaBox since Ezvid's
 * November 2026 update) name slugs such as "love-in-lockup". At most 100, so
 * "dramabox:<id>" fits drama_history's 120-character entry_id.
 */
export const ID = /^[A-Za-z0-9_-]{1,100}$/

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
/** Tag names: plain strings, or `{ slug, name }` (DramaBox). */
const strings = (v: unknown) => arr(v).map((t) => str(t) || str(obj(t).name)).filter(Boolean).slice(0, 6)

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

/** Ezvid's normalized item ({ id, title, image, extra }), used by all three apps. */
function normalizedDrama(provider: DramaProvider, raw: unknown): Drama | null {
  const item = obj(raw)
  const extra = obj(item.extra)
  // DramaBox gives 0 views when it doesn't know.
  const views = num(extra.popularity) ?? num(extra.viewCount) ?? (num(extra.views) || null)
  const tags = strings(extra.tags ?? extra.contentTags)
  return drama(provider, {
    id: str(item.id),
    title: str(item.title),
    cover: https(item.image),
    description: str(extra.description),
    tags: tags.length ? tags : strings([extra.genre]),
    episodes: num(extra.episodeCount) ?? num(extra.totalEpisodes),
    popularity: views === null ? null : compact(views),
  })
}

/** Ezvid's normalized video links ({ type, url, quality }). */
function normalizedSources(raw: unknown): VideoSource[] {
  return present(
    arr(raw).map((s) => {
      const source = obj(s)
      const url = https(source.url)
      if (!url) return null
      return { url, type: source.type === 'm3u8' || /\.m3u8(\?|$)/.test(url) ? 'hls' : 'mp4', quality: str(source.quality) || 'auto' } as VideoSource
    }),
  )
}

// ---- DramaBox (Ezvid's normalized shape; ids are name slugs) ----
const DRAMABOX_LANGUAGE = { language: 'en' }

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
      const sources = withSources ? normalizedSources(item.sources) : null
      return {
        id,
        number,
        // DramaWave repeats the drama's name as each episode's title.
        title: `Episode ${number}`,
        locked: extra.isLocked === true || extra.isVip === true || extra.videoType === 'charge' || extra.locked === true || extra.requiresVip === true,
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
    const [popular, latest] = await Promise.allSettled([
      ezvid(key, 'dramabox/popular', { ...DRAMABOX_LANGUAGE, limit: '30' }, fetchImpl),
      ezvid(key, 'dramabox/home', { ...DRAMABOX_LANGUAGE, limit: '30' }, fetchImpl),
    ])
    const items = (data: unknown) => present(arr(obj(data).items).map((item) => normalizedDrama('dramabox', item)))
    const shelves: Shelf[] = []
    if (popular.status === 'fulfilled') shelves.push({ title: 'Popular', dramas: items(popular.value) })
    if (latest.status === 'fulfilled') shelves.push({ title: 'Latest', dramas: items(latest.value) })
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

/** Every drama we can list for an app, for searching when its own search misses or fails (DramaWave's often errors). */
export async function fetchCatalog(key: string, provider: DramaProvider, fetchImpl: Fetch = fetch): Promise<Drama[]> {
  const lists: Promise<Drama[]>[] = []
  const settle = async (load: () => Promise<Drama[]>) => load().catch(() => [] as Drama[])
  if (provider === 'dramabox') {
    const items = (data: Obj) => present(arr(data.items).map((item) => normalizedDrama('dramabox', item)))
    const list = (path: string) => settle(async () => items(obj(await ezvid(key, path, { ...DRAMABOX_LANGUAGE, limit: '50' }, fetchImpl))))
    lists.push(list('dramabox/popular'), list('dramabox/dubbed'))
    lists.push(
      settle(async () => {
        // The newest, then a few more of its pages.
        const dramas: Drama[] = []
        let data = obj(await ezvid(key, 'dramabox/home', { ...DRAMABOX_LANGUAGE, limit: '50' }, fetchImpl))
        for (let page = 0; page < 4; page++) {
          dramas.push(...items(data))
          const cursor = str(data.nextCursor)
          if (!cursor) break
          data = obj(await ezvid(key, 'dramabox/loadmore', { ...DRAMABOX_LANGUAGE, cursor, limit: '50' }, fetchImpl).catch(() => ({})))
        }
        return dramas
      }),
    )
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
    // Its home shelves are added by the caller; this is its trending list.
    lists.push(settle(async () => present(arr(obj(await ezvid(key, 'netshort/trending', { language: 'en_US', limit: '50' }, fetchImpl)).items).map((item) => normalizedDrama('netshort', item)))))
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

/** Each app's code for English. */
const languageOf = (provider: DramaProvider) => (provider === 'dramabox' ? 'en' : provider === 'dramawave' ? 'en-US' : 'en_US')

export async function fetchSearch(key: string, provider: DramaProvider, query: string, fetchImpl: Fetch = fetch): Promise<Drama[]> {
  const language = languageOf(provider)
  const data = obj(await ezvid(key, `${provider}/search`, { q: query, language, limit: '30' }, fetchImpl))
  return present(arr(data.items).map((item) => normalizedDrama(provider, item)))
}

export async function fetchDetail(key: string, provider: DramaProvider, id: string, fetchImpl: Fetch = fetch): Promise<Drama | null> {
  const data = obj(await ezvid(key, `${provider}/detail/${id}`, { language: languageOf(provider) }, fetchImpl))
  return normalizedDrama(provider, arr(data.items)[0] ?? data)
}

export async function fetchEpisodes(key: string, provider: DramaProvider, id: string, fetchImpl: Fetch = fetch): Promise<EpisodeList> {
  const data = await ezvid(key, `${provider}/episodes/${id}`, { language: languageOf(provider) }, fetchImpl)
  // DramaBox's and NetShort's lists have no sources: each episode's comes from fetchSource.
  return { title: str(obj(obj(data).meta).title), episodes: normalizedEpisodes(data, provider === 'dramawave') }
}

/** DramaBox and NetShort: one episode's sources. */
export async function fetchSource(key: string, provider: DramaProvider, id: string, episodeId: string, fetchImpl: Fetch = fetch): Promise<VideoSource[]> {
  if (provider === 'dramabox') {
    // `{ items: [{ id, sources: [{ type, url }] }] }`; its links last a few hours.
    const data = obj(await ezvid(key, `dramabox/episodes/${id}/${episodeId}/source`, {}, fetchImpl))
    const items = arr(data.items).map(obj)
    return normalizedSources((items.find((item) => str(item.id) === episodeId) ?? items[0] ?? {}).sources)
  }
  if (provider !== 'netshort') return []
  return netshortSources(await ezvid(key, `netshort/episodes/${id}/${episodeId}/source`, { language: 'en_US' }, fetchImpl))
}
