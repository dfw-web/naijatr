import type { MediaItem, MediaType } from '../types/media'
import {
  attributeScores,
  CATEGORIES,
  isColdStart,
  tasteScore,
  topValues,
  type Category,
  type TasteProfile,
  type TitleRecord,
} from './profile'

/**
 * The personalised home rows, planned from the taste profile (profile.ts):
 * "More like [Title]" for the 1–2 titles most recently finished or most
 * played, "Picked for you" from the top genres and country or language, up
 * to 2 rows for the viewer's strongest categories, and a small "Try
 * something different" row from categories they rarely watch. Planning is
 * synchronous (titles are known at once, for placeholders); the lists come
 * from TMDB through CatalogProvider.listTmdb, and are then ranked by taste
 * and de-duplicated across the whole screen (dedupeRows).
 */

export interface TmdbRequest {
  path: string
  params: Record<string, string>
  type: MediaType
}

export type RowKind = 'more-like' | 'picked' | 'category' | 'variety'

export interface PlannedRow {
  id: string
  kind: RowKind
  title: string
  subtitle?: string
  requests: TmdbRequest[]
  /** Variety rows take a few from each request, in turn. */
  perRequest?: number
}

export interface PersonalPlan {
  /** Rows above Trending Now. */
  top: PlannedRow[]
  /** "Try something different", below Trending Now. */
  variety: PlannedRow | null
  /** Titles never suggested: watched, played or hidden. */
  exclude: Set<string>
  /** The viewer picked Football. */
  football: boolean
}

export const ROW_LIMIT = 20
/** A category row only shows when its score is at least this … */
export const CATEGORY_MIN = 8
/** … and at least this share of the strongest category's. */
export const CATEGORY_SHARE = 0.4
const VARIETY_CATEGORIES = 2

export const CATEGORY_NAMES: Record<Category, string> = {
  anime: "Anime you'll love",
  kdrama: 'Your K-Drama fix',
  cdrama: 'C-Dramas for you',
  jdrama: 'Japanese dramas for you',
  nollywood: 'Fresh Nollywood',
  bollywood: 'Bollywood picks',
  hollywood: 'Hollywood hits for you',
}

const SHORT_NAMES: Record<Category, string> = {
  anime: 'Anime',
  kdrama: 'K-Drama',
  cdrama: 'C-Drama',
  jdrama: 'J-Drama',
  nollywood: 'Nollywood',
  bollywood: 'Bollywood',
  hollywood: 'Hollywood',
}

const popular = (votes: number) => ({ sort_by: 'popularity.desc', 'vote_count.gte': String(votes) })

/** TMDB discover for each category. */
export const CATEGORY_REQUESTS: Record<Category, TmdbRequest> = {
  anime: { path: '/discover/tv', type: 'series', params: { ...popular(50), with_genres: '16', with_original_language: 'ja' } },
  kdrama: { path: '/discover/tv', type: 'series', params: { ...popular(50), with_origin_country: 'KR', without_genres: '16|10764|10767' } },
  cdrama: { path: '/discover/tv', type: 'series', params: { ...popular(20), with_origin_country: 'CN|TW|HK', without_genres: '16|10764|10767' } },
  jdrama: { path: '/discover/tv', type: 'series', params: { ...popular(20), with_origin_country: 'JP', without_genres: '16|10764|10767' } },
  nollywood: { path: '/discover/movie', type: 'movie', params: { ...popular(3), with_origin_country: 'NG' } },
  bollywood: { path: '/discover/movie', type: 'movie', params: { ...popular(50), with_origin_country: 'IN', with_original_language: 'hi' } },
  hollywood: { path: '/discover/movie', type: 'movie', params: { ...popular(200), with_origin_country: 'US' } },
}

/** Movie and TV genre ids that differ, so a taste for one finds the other. */
const MOVIE_TO_TV: Record<string, string> = { '28': '10759', '12': '10759', '878': '10765', '14': '10765', '10752': '10768' }
const TV_TO_MOVIE: Record<string, string> = { '10759': '28', '10765': '878', '10768': '10752' }
const TV_ONLY = new Set(['10762', '10763', '10764', '10766', '10767'])
const MOVIE_ONLY = new Set(['36', '10402', '10770'])

const genreFor = (id: string, type: MediaType) =>
  type === 'series'
    ? MOVIE_ONLY.has(id) ? null : (MOVIE_TO_TV[id] ?? id)
    : TV_ONLY.has(id) ? null : (TV_TO_MOVIE[id] ?? id)

/** A stable 32-bit hash, for choices that should hold for a day. */
function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** The 1–2 titles the "More like" rows follow: the latest finished, then the most played. */
export function seedTitles(profile: TasteProfile): TitleRecord[] {
  const usable = profile.titles.filter((t) => t.tmdbId !== null && !profile.hidden.includes(t.id) && (t.plays > 0 || t.finishedAt))
  const finished = usable.filter((t) => t.finishedAt).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  const played = [...usable].sort((a, b) => b.plays - a.plays || b.lastAt - a.lastAt)
  const seeds: TitleRecord[] = []
  for (const t of [...finished.slice(0, 1), ...played, ...finished]) {
    if (seeds.length === 2) break
    if (!seeds.some((s) => s.id === t.id)) seeds.push(t)
  }
  return seeds
}

/** The rows for this profile, or null for a cold start (the default home). */
export function planPersonalHome(profile: TasteProfile, now = Date.now()): PersonalPlan | null {
  if (isColdStart(profile, now)) return null
  const scores = attributeScores(profile, now)
  const top: PlannedRow[] = []

  seedTitles(profile).forEach((seed, index) => {
    const kind = seed.type === 'series' ? 'tv' : 'movie'
    // Vary the wording, but keep it steady for a title.
    const title = (hash(seed.id) + index) % 2 ? `Since you enjoyed ${seed.title}` : `More like ${seed.title}`
    top.push({
      id: `more-like-${index}`,
      kind: 'more-like',
      title,
      requests: ['recommendations', 'similar'].map((list) => ({ path: `/${kind}/${seed.tmdbId}/${list}`, params: {}, type: seed.type })),
    })
  })

  const tv = scores.get('t:tv') ?? 0
  const movie = scores.get('t:movie') ?? 0
  const type: MediaType = tv > movie ? 'series' : 'movie'
  const genres = topValues(scores, 'g:', 4)
    .map((g) => genreFor(g.value, type))
    .filter((g, i, all): g is string => g !== null && all.indexOf(g) === i)
    .slice(0, 2)
  const [country] = topValues(scores, 'c:', 1)
  const [language] = topValues(scores, 'l:', 1)
  if (genres.length || country || language) {
    const params: Record<string, string> = { ...popular(50) }
    if (genres.length) params.with_genres = genres.join('|')
    if (country && (!language || country.score >= language.score)) params.with_origin_country = country.value
    else if (language) params.with_original_language = language.value
    top.push({
      id: 'picked-for-you',
      kind: 'picked',
      title: 'Picked for you',
      subtitle: 'Based on what you watch',
      requests: [{ path: type === 'series' ? '/discover/tv' : '/discover/movie', params, type }],
    })
  }

  const categories = topValues(scores, 'cat:', CATEGORIES.length)
  const strongest = categories[0]?.score ?? 0
  categories
    .filter((c) => c.score >= CATEGORY_MIN && c.score >= strongest * CATEGORY_SHARE)
    .slice(0, 2)
    .forEach(({ value }) => {
      const category = value as Category
      top.push({ id: `category-${category}`, kind: 'category', title: CATEGORY_NAMES[category], requests: [CATEGORY_REQUESTS[category]] })
    })

  // The categories they watch least, a different pair each day.
  const day = Math.floor(now / 86_400_000)
  const least = CATEGORIES.map((c) => ({ c, score: scores.get(`cat:${c}`) ?? 0 }))
    .filter(({ score }) => score < CATEGORY_MIN)
    .sort((a, b) => a.score - b.score || hash(`${a.c}${day}`) - hash(`${b.c}${day}`))
    .slice(0, VARIETY_CATEGORIES)
    .map(({ c }) => c)
  const variety: PlannedRow | null = least.length
    ? {
        id: 'try-something-different',
        kind: 'variety',
        title: 'Try something different',
        subtitle: least.map((c) => SHORT_NAMES[c]).join(' · '),
        requests: least.map((c) => CATEGORY_REQUESTS[c]),
      }
    : null

  const exclude = new Set([...profile.hidden, ...profile.titles.filter((t) => t.plays > 0 || t.finishedAt).map((t) => t.id)])
  return { top, variety, exclude, football: (scores.get('x:football') ?? 0) >= 5 }
}

/** A row's items ranked by taste; TMDB's own order breaks ties (earlier ranks a little higher). */
export function rankByTaste(lists: MediaItem[][], scores: Map<string, number>): MediaItem[] {
  const best = new Map<string, { item: MediaItem; rank: number }>()
  for (const list of lists) {
    list.forEach((item, index) => {
      const known = best.get(item.id)
      // Listed in both recommendations and similar: a strong match.
      const rank = tasteScore(scores, item) - index * 0.5 + (known ? 5 : 0)
      if (!known || rank > known.rank) best.set(item.id, { item: known?.item ?? item, rank })
    })
  }
  return [...best.values()].sort((a, b) => b.rank - a.rank).map((b) => b.item)
}

/** A few from each list in turn, for the variety row. */
export function interleave(lists: MediaItem[][], total: number): MediaItem[] {
  const out: MediaItem[] = []
  for (let i = 0; out.length < total && lists.some((l) => i < l.length); i += 1) {
    for (const list of lists) if (list[i] && out.length < total) out.push(list[i])
  }
  return out
}

/** About 1 in 5 of the personalised titles: v / (p + v) = 1/5. */
export const varietySize = (personalCount: number) => Math.min(16, Math.max(6, Math.round(personalCount / 4)))

export interface FilledRow {
  id: string
  items: MediaItem[]
}

/**
 * Removes from each row, in screen order, every title already shown in an
 * earlier row or in `exclude` (Continue watching, hidden, watched). Rows in
 * `fixed` (Trending Now's chart) keep every title and claim them first.
 */
export function dedupeRows<T extends FilledRow>(rows: T[], exclude: Set<string>, fixed: Set<string> = new Set(), limit = ROW_LIMIT): T[] {
  const seen = new Set(exclude)
  for (const row of rows) if (fixed.has(row.id)) row.items.forEach((item) => seen.add(item.id))
  return rows.map((row) => {
    if (fixed.has(row.id)) return row
    const items: MediaItem[] = []
    for (const item of row.items) {
      if (seen.has(item.id) || items.length >= limit) continue
      seen.add(item.id)
      items.push(item)
    }
    return { ...row, items }
  })
}
