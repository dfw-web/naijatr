import { useSyncExternalStore } from 'react'
import type { MediaItem } from '../types/media'

/**
 * The viewer's taste, kept on this device only (localStorage "naijatr:taste"):
 * no account, nothing sent anywhere. Each signal (opened, played, watched,
 * left early, removed, not interested) adds its weight to every attribute of
 * the title: type, genres, origin countries, original language, up to 5
 * keywords and the derived categories (anime, K-drama, Nollywood, ...).
 * Scores halve every 14 days, so tastes can change, and only the strongest
 * 30 attributes are kept. Storage can be missing or blocked: then every call
 * quietly does nothing and the home screen stays the default one.
 */

export const TASTE_KEY = 'naijatr:taste'
export const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
export const MAX_ATTRIBUTES = 30
/** Titles remembered for "More like …", "already watched" and attribute lookups. */
export const MAX_TITLES = 60
/**
 * Below this (the strongest attribute's score), the viewer gets the default
 * home. One pick (+5) clears it for about 4 days; Play and a details page too.
 */
export const COLD_START_SCORE = 4

export const SIGNAL_WEIGHTS = {
  open: 1,
  play: 3,
  /** Watched past 50%, or finished an episode or movie. */
  watched: 5,
  /** Started, then left within 2 minutes. */
  left: -2,
  /** Removed from Continue watching. */
  removed: -3,
  notInterested: -5,
  /** Saved to Watch later. */
  saved: 4,
  /** A "What do you like?" pick. */
  pick: 5,
} as const

export type TasteSignal = keyof typeof SIGNAL_WEIGHTS

export const CATEGORIES = ['anime', 'kdrama', 'cdrama', 'jdrama', 'nollywood', 'bollywood', 'hollywood'] as const
export type Category = (typeof CATEGORIES)[number]

const ANIMATION = 16

interface AttributeScore {
  /** Score as of `t`. */
  s: number
  t: number
}

export interface TitleRecord {
  id: string
  tmdbId: number | null
  type: MediaItem['type']
  title: string
  attrs: string[]
  plays: number
  finishedAt: number | null
  lastAt: number
}

export interface TasteProfile {
  v: 1
  attrs: Record<string, AttributeScore>
  titles: TitleRecord[]
  /** "Not interested" titles, hidden everywhere on the home screen. */
  hidden: string[]
  /** The "What do you like?" picker was answered or skipped. */
  asked: boolean
}

export const emptyProfile = (): TasteProfile => ({ v: 1, attrs: {}, titles: [], hidden: [], asked: false })
/** One shared empty profile, so snapshots stay stable while storage is blocked. */
const EMPTY = emptyProfile()

type TitleLike = Pick<MediaItem, 'type'> &
  Partial<Pick<MediaItem, 'genreIds' | 'originCountry' | 'originalLanguage' | 'keywordIds'>>

/** The derived categories a title belongs to. */
export function categoriesOf(item: TitleLike): Category[] {
  const countries = item.originCountry ?? []
  const lang = item.originalLanguage
  const animated = (item.genreIds ?? []).includes(ANIMATION)
  const from = (...codes: string[]) => countries.some((c) => codes.includes(c))
  const out: Category[] = []
  if (animated && lang === 'ja') out.push('anime')
  if (item.type === 'series' && from('KR')) out.push('kdrama')
  if (from('CN', 'TW', 'HK')) out.push('cdrama')
  if (item.type === 'series' && from('JP') && !animated) out.push('jdrama')
  if (from('NG')) out.push('nollywood')
  if (from('IN') && lang === 'hi') out.push('bollywood')
  if (from('US')) out.push('hollywood')
  return out
}

/** Every attribute a signal on this title adds to. */
export function attributesOf(item: TitleLike): string[] {
  return [
    `t:${item.type === 'series' ? 'tv' : 'movie'}`,
    ...(item.genreIds ?? []).map((id) => `g:${id}`),
    ...(item.originCountry ?? []).map((c) => `c:${c}`),
    ...(item.originalLanguage ? [`l:${item.originalLanguage}`] : []),
    ...(item.keywordIds ?? []).slice(0, 5).map((id) => `k:${id}`),
    ...categoriesOf(item).map((c) => `cat:${c}`),
  ]
}

const decay = ({ s, t }: AttributeScore, now: number) => s * 0.5 ** (Math.max(0, now - t) / HALF_LIFE_MS)

/** Every attribute's score as of `now`. */
export function attributeScores(profile: TasteProfile, now = Date.now()): Map<string, number> {
  return new Map(Object.entries(profile.attrs).map(([key, value]) => [key, decay(value, now)]))
}

/** Adds `weight` to each attribute (after decaying it to `now`), keeping the strongest MAX_ATTRIBUTES. */
export function addToAttributes(profile: TasteProfile, attrs: string[], weight: number, now = Date.now()): TasteProfile {
  const scores = attributeScores(profile, now)
  for (const attr of new Set(attrs)) scores.set(attr, (scores.get(attr) ?? 0) + weight)
  const kept = [...scores].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, MAX_ATTRIBUTES)
  return { ...profile, attrs: Object.fromEntries(kept.map(([key, s]) => [key, { s, t: now }])) }
}

export type TasteInput = TitleLike & Pick<MediaItem, 'id' | 'title'> & Partial<Pick<MediaItem, 'tmdbId'>>

/** The profile after one signal on a title. */
export function applySignal(profile: TasteProfile, item: TasteInput, signal: TasteSignal, now = Date.now()): TasteProfile {
  const known = profile.titles.find((t) => t.id === item.id)
  const own = attributesOf(item)
  // The richer of what we're given and what we saw before (e.g. keywords from the details page).
  const attrs = known && known.attrs.length > own.length ? known.attrs : own
  const next = addToAttributes(profile, attrs, SIGNAL_WEIGHTS[signal], now)
  const record: TitleRecord = {
    id: item.id,
    tmdbId: item.tmdbId ?? known?.tmdbId ?? null,
    type: item.type,
    title: item.title || known?.title || '',
    attrs,
    plays: (known?.plays ?? 0) + (signal === 'play' ? 1 : 0),
    finishedAt: signal === 'watched' ? now : (known?.finishedAt ?? null),
    lastAt: now,
  }
  const titles = [record, ...profile.titles.filter((t) => t.id !== item.id)].slice(0, MAX_TITLES)
  const hidden = signal === 'notInterested' && !next.hidden.includes(item.id) ? [...next.hidden, item.id] : next.hidden
  return { ...next, titles, hidden }
}

/** Seeds for the "What do you like?" chips. */
export const PICKS = {
  Anime: ['cat:anime', 'g:16', 'l:ja'],
  'K-Drama': ['cat:kdrama', 'c:KR', 't:tv'],
  Nollywood: ['cat:nollywood', 'c:NG'],
  Hollywood: ['cat:hollywood', 'c:US'],
  Bollywood: ['cat:bollywood', 'c:IN', 'l:hi'],
  Action: ['g:28', 'g:10759'],
  Romance: ['g:10749'],
  Comedy: ['g:35'],
  Horror: ['g:27'],
  Football: ['x:football'],
} as const satisfies Record<string, readonly string[]>

export type TastePick = keyof typeof PICKS

export function applyPicks(profile: TasteProfile, picks: TastePick[], now = Date.now()): TasteProfile {
  let next = profile
  for (const pick of picks) next = addToAttributes(next, [...PICKS[pick]], SIGNAL_WEIGHTS.pick, now)
  return { ...next, asked: true }
}

/** Too little history for a personal home: the viewer sees the default one. */
export function isColdStart(profile: TasteProfile, now = Date.now()) {
  return Math.max(0, ...attributeScores(profile, now).values()) < COLD_START_SCORE
}

/** How well a title matches the taste: the sum of its attributes' scores. */
export function tasteScore(scores: Map<string, number>, item: TitleLike) {
  return attributesOf(item).reduce((sum, attr) => sum + (scores.get(attr) ?? 0), 0)
}

/** The strongest attributes with a prefix ("g:", "c:", "cat:"), as their values, strongest first. */
export function topValues(scores: Map<string, number>, prefix: string, count: number) {
  return [...scores]
    .filter(([key, score]) => key.startsWith(prefix) && score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, score]) => ({ value: key.slice(prefix.length), score }))
}

// ---- Storage ----

const listeners = new Set<() => void>()
let cache: { raw: string | null; profile: TasteProfile } | null = null

const isProfile = (value: unknown): value is TasteProfile => {
  const p = value as Partial<TasteProfile> | null
  return typeof p === 'object' && p !== null && p.v === 1 && typeof p.attrs === 'object' && Array.isArray(p.titles)
}

export function readTaste(): TasteProfile {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(TASTE_KEY)
  } catch {
    return cache?.profile ?? EMPTY
  }
  if (cache && cache.raw === raw) return cache.profile
  let profile = emptyProfile()
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (isProfile(parsed)) profile = { ...emptyProfile(), ...parsed, hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [] }
  } catch {
    // Unreadable: start again.
  }
  cache = { raw, profile }
  return profile
}

function writeTaste(profile: TasteProfile) {
  const raw = JSON.stringify(profile)
  try {
    window.localStorage.setItem(TASTE_KEY, raw)
    cache = { raw, profile }
  } catch {
    // Not saved; this visit still uses it.
    cache = { raw: null, profile }
  }
  listeners.forEach((listener) => listener())
}

/** Records one signal on a title. Never throws. */
export function recordTaste(item: TasteInput, signal: TasteSignal) {
  try {
    writeTaste(applySignal(readTaste(), item, signal))
  } catch {
    // Recommendations are never worth breaking the page over.
  }
}

/** Records a signal on a title seen before, by id (e.g. from the player, which only has the id). */
export function recordTasteById(id: string, signal: TasteSignal) {
  const known = readTaste().titles.find((t) => t.id === id)
  if (!known) return
  try {
    writeTaste(addAndTouch(readTaste(), known, signal))
  } catch {
    // As above.
  }
}

function addAndTouch(profile: TasteProfile, known: TitleRecord, signal: TasteSignal, now = Date.now()): TasteProfile {
  const next = addToAttributes(profile, known.attrs, SIGNAL_WEIGHTS[signal], now)
  const record = { ...known, lastAt: now, finishedAt: signal === 'watched' ? now : known.finishedAt }
  return { ...next, titles: [record, ...next.titles.filter((t) => t.id !== known.id)] }
}

export function savePicks(picks: TastePick[]) {
  writeTaste(applyPicks(readTaste(), picks))
}

export function resetTaste() {
  try {
    window.localStorage.removeItem(TASTE_KEY)
  } catch {
    // Nothing stored anyway.
  }
  // Asked already: don't show the picker again straight after a reset.
  writeTaste({ ...emptyProfile(), asked: true })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === TASTE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The live profile, re-rendering on every change (this tab or another). */
export const useTaste = () => useSyncExternalStore(subscribe, readTaste, () => EMPTY)
