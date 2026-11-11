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

/** The subtitle in `lang`, or null (none found, rate-limited, offline, turned off on the server). */
export async function loadSubtitle(target: SubtitleTarget, lang: string, signal?: AbortSignal): Promise<Cue[] | null> {
  try {
    const q = query(target)
    q.set('lang', lang)
    const response = await fetch(`/api/subtitles?${q}`, { signal })
    if (!response.ok) return null
    const cues = parseVtt(await response.text())
    return cues.length ? cues : null
  } catch {
    return null
  }
}

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

export function subtitleOffset(key: string): number {
  try {
    const all = JSON.parse(read(OFFSETS_KEY) ?? '{}') as Record<string, number>
    return typeof all[key] === 'number' ? all[key] : 0
  } catch {
    return 0
  }
}

export function saveSubtitleOffset(key: string, offset: number) {
  let all: Record<string, number> = {}
  try {
    all = JSON.parse(read(OFFSETS_KEY) ?? '{}') as Record<string, number>
  } catch {
    // Start again.
  }
  if (offset === 0) delete all[key]
  else all[key] = offset
  // The last 200 titles are plenty.
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete all[old]
  write(OFFSETS_KEY, JSON.stringify(all))
}

/** The iPhone tip, once per device. True the first time. */
export function takeIphoneTip(): boolean {
  if (read(IPHONE_TIP_KEY)) return false
  write(IPHONE_TIP_KEY, '1')
  return true
}
