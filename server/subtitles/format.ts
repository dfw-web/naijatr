import { inflateRawSync } from 'node:zlib'

/**
 * Subtitle files as they come from OpenSubtitles and SubDL: any text encoding,
 * .srt (or .vtt), and for SubDL inside a .zip. Everything leaves here as WebVTT.
 */

/** Text from a subtitle file's bytes: UTF-8 / UTF-16 when they say so, else Windows-1252 (most old .srt files). */
export function decodeSubtitle(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

/** "00:01:02,5" → "00:01:02.500" */
function vttTime(raw: string): string | null {
  const m = TIME.exec(raw)
  if (!m) return null
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4].padEnd(3, '0')}`
}

/** Strips what the overlay can't show: ASS override tags ({\an8}), fonts and colours. Keeps <i>, <b>, <u>. */
function cleanText(line: string): string {
  return line
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?(font|span|c)[^>]*>/gi, '')
    .trim()
}

/** Uploaders' ad lines ("Downloaded from YTS.MX", "Support us and become VIP member"): left out. */
const AD_CUE = /(yts\.(mx|am|lt|ag)|yify|opensubtitles\.(org|com)|subscene|addic7ed|subdl\.com|become vip member|advertise your product|ripped by|subtitles? by|www\.[a-z0-9-]+\.(com|org|net))/i

/** .srt (or a .vtt already) → WebVTT. Null when there's not one cue in it. */
export function toVtt(text: string): string | null {
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').replace(/^WEBVTT[^\n]*\n/, '').split(/\n\s*\n/)
  const cues: string[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const [from, to] = lines[at].split('-->')
    const start = vttTime(from)
    const end = vttTime(to ?? '')
    const body = lines.slice(at + 1).map(cleanText).filter(Boolean)
    if (!start || !end || body.length === 0 || AD_CUE.test(body.join(' '))) continue
    cues.push(`${start} --> ${end}\n${body.join('\n')}`)
  }
  return cues.length ? `WEBVTT\n\n${cues.join('\n\n')}\n` : null
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/** The files in a .zip (stored or deflated), read from its central directory. Throws on anything else. */
export function unzip(buffer: Uint8Array): ZipEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip')
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  for (let n = 0; n < count && at + 46 <= buffer.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break
    const method = view.getUint16(at + 10, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(buffer.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    const localName = view.getUint16(local + 26, true)
    const localExtra = view.getUint16(local + 28, true)
    const start = local + 30 + localName + localExtra
    const raw = buffer.subarray(start, start + size)
    if (method === 0) entries.push({ name, data: raw })
    else if (method === 8) entries.push({ name, data: new Uint8Array(inflateRawSync(raw)) })
  }
  return entries
}

const SUBTITLE_FILE = /\.(srt|vtt)$/i

/**
 * The right subtitle in a zip: for an episode, the file named for it
 * (S01E05, 1x05, "- 05"), else the largest .srt (a movie's main file, not a
 * forced-only one).
 */
export function pickZipFile(entries: ZipEntry[], episode?: { season: number; episode: number; absolute?: number }): ZipEntry | null {
  const subs = entries.filter((e) => SUBTITLE_FILE.test(e.name) && !/__MACOSX\//.test(e.name))
  if (subs.length === 0) return null
  if (episode) {
    const s = episode.season
    const e = episode.episode
    const patterns = [
      new RegExp(`s0*${s}\\s*[._-]?\\s*e0*${e}(?!\\d)`, 'i'),
      new RegExp(`(?<!\\d)0*${s}x0*${e}(?!\\d)`, 'i'),
      ...(episode.absolute ? [new RegExp(`(?:e|ep|episode|\\s-\\s|\\[|_|\\s)0*${episode.absolute}(?!\\d)`, 'i')] : []),
      // A season pack numbered by episode: "09 The Rains of Castamere.en.srt", "9 - Title.srt".
      new RegExp(`^0*${e}(?![\\dx])`, 'i'),
    ]
    for (const pattern of patterns) {
      const hit = subs.filter((f) => pattern.test(f.name.split('/').pop() ?? f.name))
      if (hit.length) return hit.sort((a, b) => b.data.length - a.data.length)[0]
    }
    // A pack with many episodes and none named for this one: not a guess.
    if (subs.length > 1) return null
  }
  return [...subs].sort((a, b) => b.data.length - a.data.length)[0]
}
