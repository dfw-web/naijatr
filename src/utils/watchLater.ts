import { useSyncExternalStore } from 'react'
import type { MediaItem } from '../types/media'
import { saveTitle, type SavedTitle } from './continueWatching'

/**
 * "Watch later": movies and series saved on this device, newest first, kept
 * in localStorage under one key (no account needed). Like Continue watching,
 * storage can be missing, full or blocked, and then this quietly does nothing.
 */

export const WATCH_LATER_KEY = 'naijatr:watchLater'
export const WATCH_LATER_LIMIT = 100

export interface WatchLaterEntry {
  /** Our title id (MediaItem.id). */
  id: string
  savedAt: number
  item: SavedTitle
}

const listeners = new Set<() => void>()
let cache: { raw: string | null; list: WatchLaterEntry[] } | null = null
const emit = () => listeners.forEach((listener) => listener())

const isEntry = (value: unknown): value is WatchLaterEntry => {
  const e = value as Partial<WatchLaterEntry> | null
  return typeof e === 'object' && e !== null && typeof e.id === 'string' && typeof e.savedAt === 'number' && typeof e.item === 'object' && e.item !== null
}

/** Every saved title, most recently saved first. */
export function readWatchLater(): WatchLaterEntry[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(WATCH_LATER_KEY)
  } catch {
    return []
  }
  if (cache && cache.raw === raw) return cache.list
  let list: WatchLaterEntry[] = []
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    list = Array.isArray(parsed) ? parsed.filter(isEntry).sort((a, b) => b.savedAt - a.savedAt) : []
  } catch {
    list = []
  }
  cache = { raw, list }
  return list
}

function write(list: WatchLaterEntry[]): void {
  try {
    window.localStorage.setItem(WATCH_LATER_KEY, JSON.stringify(list.slice(0, WATCH_LATER_LIMIT)))
  } catch {
    // Not remembered this time.
  }
  emit()
}

export const isSaved = (id: string) => readWatchLater().some((e) => e.id === id)

export function saveForLater(item: MediaItem, now = Date.now()): void {
  write([{ id: item.id, savedAt: now, item: saveTitle(item) }, ...readWatchLater().filter((e) => e.id !== item.id)])
}

export function removeFromLater(id: string): void {
  write(readWatchLater().filter((e) => e.id !== id))
}

/** The title to open again from a card. */
export const savedItem = (entry: WatchLaterEntry): MediaItem => ({ ...entry.item })

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  // Saved or removed in another tab.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === WATCH_LATER_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export const useWatchLater = () => useSyncExternalStore(subscribe, readWatchLater, () => [])
