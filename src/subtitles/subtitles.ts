import { getClient, hasStoredSession } from '../account/client'

/**
 * External subtitles for the player overlay: loading them from /api/subtitles
 * (the keys live on the server), the cues, and what the viewer chose (language,
 * kept on this device and on the account when signed in; sync offset per title).
 * Never in the way of playback: everything here fails quietly.
 */

export interface Cue {
  start: number
  end: number
  /** Lines, with <i>/<b>/<u> kept for the overlay. */
  lines: string[]
}

export interface SubtitleLanguage {
  code: string
  name: string
  available: boolean
}

export interface SubtitleTarget {
  tmdbId: number
  type: 'movie' | 'tv'
  episode?: { season: number; episode: number }
  /** For "Subtitles out of sync?" reports: the title's name and the server playing. */
  title?: string
  server?: string
}

const seconds = (t: string): number | null => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(t.trim())
  if (!m) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}

export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = []
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const [from, rest = ''] = lines[at].split('-->')
    const start = seconds(from)
    const end = seconds(rest.trim().split(/\s+/)[0] ?? '')
    const body = lines.slice(at + 1).filter((l) => l.trim() !== '')
    if (start === null || end === null || body.length === 0) continue
    cues.push({ start, end, lines: body })
  }
  return cues.sort((a, b) => a.start - b.start)
}

/** The cues showing at `time` (seconds): usually one, sometimes two that overlap. */
export function cuesAt(cues: Cue[], time: number): Cue[] {
  let lo = 0
  let hi = cues.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start <= time) lo = mid + 1
    else hi = mid
  }
  const out: Cue[] = []
  // Cues are short: looking back a few covers every overlap.
  for (let i = lo - 1; i >= 0 && i >= lo - 4; i--) if (cues[i].end > time) out.unshift(cues[i])
  return out
}

const query = (t: SubtitleTarget) => {
  const q = new URLSearchParams({ tmdbId: String(t.tmdbId), type: t.type })
  if (t.episode) {
    q.set('season', String(t.episode.season))
    q.set('episode', String(t.episode.episode))
  }
  return q
}

/** Subtitles timed for one frame rate, played at another: Normal, or stretched by from/to. */
export const SPEEDS = [
  { id: '1', label: 'Normal', factor: 1 },
  { id: '23.976-25', label: '23.976 → 25', factor: 23.976 / 25 },
  { id: '25-23.976', label: '25 → 23.976', factor: 25 / 23.976 },
  { id: '24-25', label: '24 → 25', factor: 24 / 25 },
  { id: '25-24', label: '25 → 24', factor: 25 / 24 },
] as const
export type SpeedId = (typeof SPEEDS)[number]['id']
export const speedFactor = (id: string) => SPEEDS.find((s) => s.id === id)?.factor ?? 1
export const isSpeed = (id: unknown): id is SpeedId => SPEEDS.some((s) => s.id === id)

/** The subtitle time showing at player time `time`: shifted by `offset` seconds, stretched by the speed. */
export const subtitleTime = (time: number, offset: number, speed: string) => (time - offset) / speedFactor(speed)

export interface SyncSetting {
  version: string
  offset: number
  speed: SpeedId
}

export interface LoadedSubtitle {
  cues: Cue[]
  /** The file it is (for "Try another version"); null from an older cache entry. */
  version: string | null
  /** Viewers fixed this episode together: their offset and speed come with it. */
  community: { offset: number; speed: SpeedId } | null
}

/** The subtitle in `lang` (a given version of it, or the best one), or null (none found, rate-limited, offline, off). */
export async function loadSubtitle(target: SubtitleTarget, lang: string, version?: string | null, signal?: AbortSignal): Promise<LoadedSubtitle | null> {
  try {
    const q = query(target)
    q.set('lang', lang)
    if (version) q.set('version', version)
    const response = await fetch(`/api/subtitles?${q}`, { signal })
    if (!response.ok) return null
    const cues = parseVtt(await response.text())
    if (!cues.length) return null
    const header = (name: string) => response.headers?.get?.(name) ?? null
    const speed = header('X-Subtitle-Speed')
    const offset = Number(header('X-Subtitle-Offset'))
    return {
      cues,
      version: header('X-Subtitle-Version') ?? version ?? null,
      community: header('X-Subtitle-Community') === '1' && Number.isFinite(offset) ? { offset, speed: isSpeed(speed) ? speed : '1' } : null,
    }
  } catch {
    return null
  }
}

export interface SubtitleVersion {
  id: string
  label: string
  release: string
}

/** The files for this episode and language ("Try another version"), the one playing first. [] on failure. */
export async function loadVersions(target: SubtitleTarget, lang: string, signal?: AbortSignal): Promise<SubtitleVersion[]> {
  try {
    const q = query(target)
    q.set('lang', lang)
    const response = await fetch(`/api/subtitles/versions?${q}`, { signal })
    if (!response.ok) return []
    const body = (await response.json()) as { versions?: SubtitleVersion[] }
    return Array.isArray(body.versions) ? body.versions : []
  } catch {
    return []
  }
}

const post = (path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
    .then((r) => r.ok)
    .catch(() => false)

const bodyOf = (target: SubtitleTarget, lang: string, setting: Partial<SyncSetting>) => ({
  tmdbId: target.tmdbId,
  type: target.type,
  season: target.episode?.season,
  episode: target.episode?.episode,
  lang,
  ...setting,
})

/** This setting worked for this viewer: one vote toward the episode's community default. */
export const voteSync = (target: SubtitleTarget, lang: string, setting: SyncSetting) => post('/api/subtitles/vote', bodyOf(target, lang, setting))

/** "Subtitles out of sync?": logged for /admin/live. */
export const reportOutOfSync = (target: SubtitleTarget, lang: string, setting: Partial<SyncSetting>) =>
  post('/api/subtitles/report', { ...bodyOf(target, lang, setting), title: target.title, server: target.server })

/** The languages there are subtitles in (English always listed first). Never throws. */
export async function loadLanguages(target: SubtitleTarget, signal?: AbortSignal): Promise<SubtitleLanguage[]> {
  try {
    const response = await fetch(`/api/subtitles/languages?${query(target)}`, { signal })
    if (!response.ok) return []
    const body = (await response.json()) as { languages?: SubtitleLanguage[] }
    return Array.isArray(body.languages) ? body.languages : []
  } catch {
    return []
  }
}

// ——— What the viewer chose ———

const LANG_KEY = 'naijatr.subs.lang'
const OFFSETS_KEY = 'naijatr.subs.offsets'
const IPHONE_TIP_KEY = 'naijatr.subs.iphoneTip'
const SPEEDS_KEY = 'naijatr.subs.speeds'
const VERSIONS_KEY = 'naijatr.subs.versions'
export const DEFAULT_LANG = 'en'
/** "off", or a language code. */
export type SubtitleChoice = string

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage blocked: this visit only.
  }
}

let memoryLang: string | null = null
const listeners = new Set<() => void>()

export function subtitleChoice(): SubtitleChoice {
  return memoryLang ?? read(LANG_KEY) ?? DEFAULT_LANG
}

export function subscribeSubtitleChoice(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Kept here, and on the account when signed in (its user metadata: no table needed). */
export function setSubtitleChoice(choice: SubtitleChoice, toAccount = true) {
  memoryLang = choice
  write(LANG_KEY, choice)
  listeners.forEach((l) => l())
  if (toAccount && hasStoredSession()) {
    void getClient()
      .then((client) => client.auth.updateUser({ data: { subtitle_lang: choice } }))
      .catch(() => undefined)
  }
}

/** Signed in: the account's choice (from another device) wins over this one's. */
export function adoptAccountSubtitleChoice(choice: unknown) {
  if (typeof choice === 'string' && /^(off|[a-z]{2}(-[a-z]{2})?)$/.test(choice) && choice !== subtitleChoice()) setSubtitleChoice(choice, false)
}

/** "movie:550" or "tv:1399": one offset per title (episodes share their show's). */
export const offsetKey = (t: SubtitleTarget) => `${t.type}:${t.tmdbId}`

function readMap<T>(storageKey: string): Record<string, T> {
  try {
    const all = JSON.parse(read(storageKey) ?? '{}') as unknown
    return all && typeof all === 'object' ? (all as Record<string, T>) : {}
  } catch {
    return {}
  }
}

/** Sets (or, with null, removes) one entry; the last 200 are kept. */
function writeMap<T>(storageKey: string, key: string, value: T | null) {
  const all = readMap<T>(storageKey)
  delete all[key]
  if (value !== null) all[key] = value
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete all[old]
  write(storageKey, JSON.stringify(all))
}

/** The viewer's own sync offset for a title (seconds); null when they never moved it. */
export function savedOffset(key: string): number | null {
  const value = readMap<number>(OFFSETS_KEY)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const subtitleOffset = (key: string) => savedOffset(key) ?? 0

/** Kept even at 0 ("Reset"): the viewer's own choice beats the community's. */
export const saveSubtitleOffset = (key: string, offset: number) => writeMap(OFFSETS_KEY, key, offset)

/** The viewer's own subtitle speed for a title; null when never set. */
export function savedSpeed(key: string): SpeedId | null {
  const value = readMap<string>(SPEEDS_KEY)[key]
  return isSpeed(value) ? value : null
}

export const saveSubtitleSpeed = (key: string, speed: SpeedId) => writeMap(SPEEDS_KEY, key, speed)

/** "tv:1399:3:9:en": the version chosen for one episode in one language. */
export const versionKey = (t: SubtitleTarget, lang: string) => `${t.type}:${t.tmdbId}:${t.episode?.season ?? 0}:${t.episode?.episode ?? 0}:${lang}`

export function savedVersion(key: string): string | null {
  const value = readMap<string>(VERSIONS_KEY)[key]
  return typeof value === 'string' ? value : null
}

export const saveSubtitleVersion = (key: string, version: string | null) => writeMap(VERSIONS_KEY, key, version)

/** The iPhone tip, once per device. True the first time. */
export function takeIphoneTip(): boolean {
  if (read(IPHONE_TIP_KEY)) return false
  write(IPHONE_TIP_KEY, '1')
  return true
}
