/**
 * Text clean-up for typo-tolerant search: the same rules for titles and for
 * what people type, so "Amélie", "amelie" and "AMELIE!" all compare equal.
 */

/** Lowercase, accents and punctuation removed, "&" → "and", single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    // Accent marks (é → e), then apostrophes and curly quotes.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['`\p{Pi}\p{Pf}]/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export const words = (text: string) => normalize(text).split(' ').filter(Boolean)

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** Words too common to search on their own. */
export const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'at', 'my', 'is', 'part', 'season', 'movie', 'series', 'film'])

const swapNumbers = (text: string, toWords: boolean) =>
  text
    .split(' ')
    .map((word) => {
      if (toWords && /^\d+$/.test(word) && Number(word) < NUMBER_WORDS.length) return NUMBER_WORDS[Number(word)]
      if (!toWords && NUMBER_WORDS.includes(word)) return String(NUMBER_WORDS.indexOf(word))
      return word
    })
    .join(' ')

/**
 * Cleaned-up ways of writing the same query, most useful first, without the
 * query itself: the normalised text, numbers as digits and as words,
 * "part 2" ↔ "2", "and" ↔ "&", the query minus its last word, then each
 * word on its own (longest first, common words skipped).
 */
export function queryVariants(query: string): string[] {
  const clean = normalize(query)
  if (!clean) return []
  const out: string[] = [clean]
  out.push(swapNumbers(clean, false), swapNumbers(clean, true))
  const digits = swapNumbers(clean, false)
  if (/\bpart \d+\b/.test(digits)) out.push(digits.replace(/\bpart (\d+)\b/g, '$1'))
  else if (/ \d+$/.test(digits)) out.push(digits.replace(/ (\d+)$/, ' part $1'))
  if (/\band\b/.test(clean)) out.push(clean.replace(/\band\b/g, '&'))
  const list = clean.split(' ')
  if (list.length > 1) {
    out.push(list.slice(0, -1).join(' '))
    const singles = list.filter((w) => w.length >= 3 && !STOP_WORDS.has(w)).sort((a, b) => b.length - a.length)
    out.push(...singles)
  }
  const raw = query.trim().toLowerCase()
  return [...new Set(out)].filter((v) => v && v !== raw)
}

/**
 * Edit distance counting a swap of neighbouring letters as one edit
 * (optimal string alignment), stopping early once it exceeds `max`.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prevPrev: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prevPrev[j - 2] + 1)
      row[j] = value
      if (value < best) best = value
    }
    if (best > max) return max + 1
    prevPrev = prev
    prev = row
  }
  return prev[b.length]
}

/** Words seen in titles, weighted by how popular those titles are. */
export type Vocabulary = Map<string, number>

export function buildVocabulary(titles: { text: string; weight: number }[]): Vocabulary {
  const vocab: Vocabulary = new Map()
  for (const { text, weight } of titles) {
    for (const word of words(text)) vocab.set(word, (vocab.get(word) ?? 0) + Math.max(1, weight))
  }
  return vocab
}

/** Typos allowed in a word of this length. */
const allowedEdits = (length: number) => (length <= 2 ? 0 : length <= 5 ? 1 : 2)

function correctWord(word: string, vocab: Vocabulary): string {
  if (vocab.has(word) || /^\d+$/.test(word)) return word
  const max = allowedEdits(word.length)
  let best: { word: string; distance: number; weight: number } | null = null
  for (const [candidate, weight] of vocab) {
    if (Math.abs(candidate.length - word.length) > max || candidate.length < 3) continue
    const distance = editDistance(word, candidate, max)
    if (distance > max) continue
    if (!best || distance < best.distance || (distance === best.distance && weight > best.weight)) {
      best = { word: candidate, distance, weight }
    }
  }
  if (best) return best.word
  // A missing space: "spiderman" → "spider man".
  for (let cut = 3; cut <= word.length - 3; cut++) {
    const left = word.slice(0, cut)
    const right = word.slice(cut)
    if (vocab.has(left) && vocab.has(right)) return `${left} ${right}`
  }
  return word
}

/** The query with each word spelled like the closest title word, or null when nothing changes. */
export function correctQuery(query: string, vocab: Vocabulary): string | null {
  const list = words(query)
  if (!list.length || !vocab.size) return null
  const corrected = list.map((word) => correctWord(word, vocab)).join(' ')
  return corrected !== list.join(' ') ? corrected : null
}
