import { useEffect, useSyncExternalStore } from 'react'
import { AD_RULES, AD_SECTIONS } from '../config/ads'
import { isTvMode } from '../tv/tvMode'
import { adsDisabled, isDevHost, openAd } from './directLink'

/**
 * The direct-link ad's one set of rules. It opens in a new tab, inside the tap
 * (Safari only allows that), and the tap's own action carries on as normal:
 *
 * - cards:    the first click on a title's card (or View Details) this visit;
 * - play:     the first Play of that title this visit (so up to 2 per title);
 * - football: the first Watch of a match, again only 5+ minutes after its last ad;
 * - search:   the first search submitted this visit, then at most every 10 minutes.
 *
 * And for all of them: at least a minute between two ads, at most 8 a day
 * (midnight Lagos time), nothing while a player is open, nothing while the
 * Telegram gate, the invite guide or a contest popup is open, and nothing on
 * the tap that opens or closes one of those. A tap that's held back keeps its
 * turn: the next eligible tap opens the ad instead.
 *
 * Cards, Play and search are the movie section's: off while AD_SECTIONS.movies is false.
 */

export type AdTrigger = 'card' | 'play' | 'football' | 'search'
/** What /api/live/ad counts: an ad opened (by trigger), or one held back by the cooldown or the daily cap. */
export type AdEvent = AdTrigger | 'cooldown' | 'cap'

const DAY_KEY = 'naijatr.ads.day'
const VISIT_KEY = 'naijatr.ads.visit'
const REPORT_URL = '/api/live/ad'
/** Open players: a film, episode or trailer (PlayerPanel) and a football stream (MatchStream). */
const PLAYER_SELECTOR = '.player__frame, .fb-stream__player video, .fb-stream__player iframe'

/** Today's ads on this device; `last` outlives the day, for the cooldown. */
interface Day {
  day: string
  count: number
  last: number | null
}

/** This visit's ads: titles whose card or Play ad opened, matches' last ad, the last search ad. */
interface Visit {
  cards: string[]
  plays: string[]
  matches: Record<string, number>
  search: number | null
}

/** The clock the rules read; tests move it forward. */
export const adClock = { now: () => Date.now() }

/** The date in Lagos (UTC+1 all year), e.g. "2026-10-27". */
export const lagosDay = (now: number) => new Date(now + 60 * 60_000).toISOString().slice(0, 10)

// Storage blocked (private mode): the rules still hold for this page load.
const memory = new Map<string, string>()

function read<T>(storage: () => Storage, key: string, fallback: T): T {
  let raw: string | null | undefined
  try {
    raw = storage().getItem(key)
  } catch {
    raw = memory.get(key)
  }
  try {
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback
  } catch {
    return fallback
  }
}

function write(storage: () => Storage, key: string, value: unknown) {
  const raw = JSON.stringify(value)
  memory.set(key, raw)
  try {
    storage().setItem(key, raw)
  } catch {
    // Kept in memory instead.
  }
}

const readDay = (now: number): Day => {
  const stored = read<Day>(() => localStorage, DAY_KEY, { day: lagosDay(now), count: 0, last: null })
  return stored.day === lagosDay(now) ? stored : { day: lagosDay(now), count: 0, last: stored.last }
}
const readVisit = () => read<Visit>(() => sessionStorage, VISIT_KEY, { cards: [], plays: [], matches: {}, search: null })

/** Counts the ad on /api/live/ad (shown on /admin/live). Never from a developer's machine. */
function report(event: AdEvent) {
  if (isDevHost()) return
  try {
    navigator.sendBeacon?.(REPORT_URL, new Blob([JSON.stringify({ event })], { type: 'application/json' }))
  } catch {
    // Not counted.
  }
}

// Taps that must not open the ad: the one that opens or closes the Telegram gate or the invite guide.
const heldTaps = new WeakSet<Event>()

/** Keeps the ad out of this tap (call it from the click that opens or closes a popup). */
export function holdAdsThisTap(tap: Event | undefined = window.event): void {
  if (tap) heldTaps.add(tap)
}

// Popups open now (Telegram gate, invite guide, contest and invitee popups, ad break).
let overlays = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Registers a popup while it's open: no ad, and no "ads are back" card, until it closes. */
export function useAdOverlay(open = true): void {
  useEffect(() => {
    if (!open) return
    overlays += 1
    emit()
    return () => {
      overlays -= 1
      emit()
    }
  }, [open])
}

/** True while one of those popups is open. */
export const useOverlayOpen = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => overlays > 0,
    () => false,
  )

// Events a person makes: a new tab may open in them. (A resumed title starts its player from an effect, with none.)
const TAP_TYPES = new Set(['click', 'keydown', 'keyup', 'pointerup', 'mouseup', 'touchend', 'submit'])

/** True while a film, episode, trailer or football stream player is on the page. */
export const isPlaybackOpen = () => document.querySelector(PLAYER_SELECTOR) !== null

/**
 * Opens the ad if `trigger`'s own rule (`due`) and the shared limits allow it.
 * `adKey` is the page that shows the ad break if the browser blocks the tab.
 */
function tryAd(trigger: AdTrigger, adKey: string, due: (visit: Visit, now: number) => boolean, opened: (visit: Visit, now: number) => void, event?: Event): boolean {
  if (adsDisabled() || isTvMode()) return false
  if (!AD_SECTIONS[trigger === 'football' ? 'football' : 'movies']) return false
  const tap = event ?? window.event
  if (!tap || !TAP_TYPES.has(tap.type) || heldTaps.has(tap)) return false
  if (overlays > 0 || isPlaybackOpen()) return false
  const now = adClock.now()
  const visit = readVisit()
  if (!due(visit, now)) return false
  const day = readDay(now)
  if (day.count >= AD_RULES.dailyCap) {
    report('cap')
    return false
  }
  if (day.last !== null && now - day.last < AD_RULES.cooldownMs) {
    report('cooldown')
    return false
  }
  if (!openAd(tap, adKey)) return false
  opened(visit, now)
  write(() => sessionStorage, VISIT_KEY, visit)
  write(() => localStorage, DAY_KEY, { day: day.day, count: day.count + 1, last: now })
  report(trigger)
  return true
}

/** A title's ad key: its details page shows the ad break if the ad was blocked. */
export const titleAdKey = (item: { id: string }) => `title:${item.id}`

/** A title card (or View Details) was clicked. Call it first thing in the click handler. */
export function cardAd(event: Event | undefined, item: { id: string }): boolean {
  return tryAd(
    'card',
    titleAdKey(item),
    (visit) => !visit.cards.includes(item.id),
    (visit) => void visit.cards.push(item.id),
    event,
  )
}

/**
 * Play (key "title:<id>") or a match's Watch tab (key "match:<id>") is about to
 * start the player. Called by playAfterAdBreak, inside the tap, once the
 * Telegram gate has let it through.
 */
export function playbackAd(key: string): boolean {
  const [kind, ...rest] = key.split(':')
  const id = rest.join(':')
  if (kind === 'match') {
    return tryAd(
      'football',
      key,
      (visit, now) => visit.matches[id] === undefined || now - visit.matches[id] >= AD_RULES.footballRepeatMs,
      (visit, now) => void (visit.matches[id] = now),
    )
  }
  if (kind !== 'title') return false
  return tryAd(
    'play',
    key,
    (visit) => !visit.plays.includes(id),
    (visit) => void visit.plays.push(id),
  )
}

/** A search was submitted (Enter in the search box). */
export function searchAd(event: Event | undefined): boolean {
  return tryAd(
    'search',
    'search',
    (visit, now) => visit.search === null || now - visit.search >= AD_RULES.searchRepeatMs,
    (visit, now) => void (visit.search = now),
    event,
  )
}

/** Test helper. */
export function resetAdManager() {
  memory.clear()
  overlays = 0
  emit()
}
