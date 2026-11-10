/**
 * /admin/live (admin/live/index.html): who's on the site right now, from the
 * live viewer counter (server/live/handlers.ts), and the Live Stream API's
 * usage, cached streams and last calls (/api/football/admin-streams). The password is checked by
 * /api/live/count and kept for this browser tab only (sessionStorage).
 * Refreshes every 30 seconds while the tab is visible. Also "Give ad-free"
 * (./adFree.ts): paid ad-free given by hand, with its log and totals.
 */

import { initAdFree, loadAdFree } from './adFree'
import { AD_LEVEL, AD_RULES, MULTITAG, MULTITAG_2 } from '../config/ads'

export const REFRESH_MS = 30_000
const PASSWORD_KEY = 'naijatr.admin.password'

type AdEvent =
  | 'card' | 'play' | 'football' | 'search' | 'list' | 'episode' | 'server' | 'cooldown' | 'cap' | 'upsell'
  | 'multitag-302667' | 'multitag-302667-blocked' | 'multitag-306795' | 'multitag-306795-blocked'

type PlayerEvent = 'load' | 'nostart' | 'fallback' | 'limited'
type PlayerCounts = Record<'nextstream' | 'embedmaster', Record<PlayerEvent, number>> & { calls: number }

interface KeyStatus {
  issued: string | null
  expiresAt: number | null
  okAt: number | null
  rejectedAt: number | null
}

interface LiveCount {
  watching: number
  browsing: number
  top: { item: string; viewers: number }[]
  /** Today's direct-link ads (server/live/handlers.ts). */
  ads?: Record<AdEvent, number>
  /** When the second Multitag (zone 306795) first loaded (ms). */
  adTestStartedAt?: number | null
  /** Today's player stats per server, and our CodeSpecter key (server/live/handlers.ts). */
  players?: PlayerCounts
  key?: KeyStatus
}

/** Warn this many days before the CodeSpecter key's 30 days are up. */
export const KEY_WARN_DAYS = 5
const DAY_MS = 24 * 60 * 60_000

const AD_ROWS: { event: AdEvent; label: string }[] = [
  { event: 'card', label: 'Opened: title card' },
  { event: 'play', label: 'Opened: Play' },
  { event: 'football', label: 'Opened: football Watch' },
  { event: 'search', label: 'Opened: search' },
  { event: 'list', label: 'Opened: Continue Watching / My List' },
  { event: 'episode', label: 'Opened: season or episode picked' },
  { event: 'server', label: 'Opened: server picked' },
  { event: 'cooldown', label: `Held back: ${AD_RULES.cooldownMs / 1000}-second cooldown` },
  { event: 'cap', label: `Held back: daily cap (${AD_RULES.dailyCap})` },
  { event: 'upsell', label: '"Too many ads?" banner shown' },
]

/** The triggers that open the ad (the rest are held back or banners). */
const OPENED: AdEvent[] = ['card', 'play', 'football', 'search', 'list', 'episode', 'server']

/** The Monetag Multitags: page loads with each zone's script, and loads blocked (ad blockers). */
const TAG_ROWS: { event: AdEvent; label: string }[] = [
  { event: 'multitag-302667', label: `Multitag zone ${MULTITAG.zone}: loaded` },
  { event: 'multitag-302667-blocked', label: `Multitag zone ${MULTITAG.zone}: blocked` },
  { event: 'multitag-306795', label: `Multitag zone ${MULTITAG_2.zone} (test): loaded` },
  { event: 'multitag-306795-blocked', label: `Multitag zone ${MULTITAG_2.zone} (test): blocked` },
]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** Names for "movie:550", "tv:1399", "match:123", looked up once each. */
const names = new Map<string, Promise<string>>()

async function lookUpName(item: string): Promise<string> {
  const [kind, id] = item.split(':')
  try {
    if (kind === 'match') {
      const response = await fetch(`/api/football/match?id=${id}`)
      const body = (await response.json()) as { data?: { teams?: { home?: { name?: string }; away?: { name?: string } } } }
      const teams = body.data?.teams
      if (teams?.home?.name && teams.away?.name) return `⚽ ${teams.home.name} vs ${teams.away.name}`
    } else {
      const response = await fetch(`/api/tmdb/${kind === 'tv' ? 'tv' : 'movie'}/${id}?language=en-US`)
      const body = (await response.json()) as { title?: string; name?: string }
      const title = body.title ?? body.name
      if (title) return `${kind === 'tv' ? '📺' : '🎬'} ${title}`
    }
  } catch {
    // Shown by its id instead.
  }
  return item
}

export function nameOf(item: string): Promise<string> {
  let name = names.get(item)
  if (!name) {
    name = lookUpName(item)
    names.set(item, name)
  }
  return name
}

const readPassword = () => {
  try {
    return sessionStorage.getItem(PASSWORD_KEY) ?? ''
  } catch {
    return ''
  }
}

const savePassword = (value: string) => {
  try {
    if (value) sessionStorage.setItem(PASSWORD_KEY, value)
    else sessionStorage.removeItem(PASSWORD_KEY)
  } catch {
    // Asked again on reload.
  }
}

let password = ''
let timer: number | undefined

function showLogin(message?: string) {
  window.clearInterval(timer)
  $('stats').hidden = true
  $('login').hidden = false
  const error = $('login-error')
  error.hidden = !message
  error.textContent = message ?? ''
  $<HTMLInputElement>('password').focus()
}

async function render(count: LiveCount) {
  $('watching').textContent = String(count.watching)
  $('browsing').textContent = String(count.browsing)
  const rows = await Promise.all(
    count.top.map(async ({ item, viewers }) => {
      const li = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = await nameOf(item)
      const number = document.createElement('span')
      number.textContent = `${viewers} watching`
      li.append(name, number)
      return li
    }),
  )
  $('top').replaceChildren(...rows)
  renderAds(count.ads)
  renderTags(count.ads, count.adTestStartedAt ?? null)
  renderServers(count.players, count.key)
  $('empty').hidden = rows.length > 0
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString()} · refreshes every 30 seconds`
}

function renderAds(ads: LiveCount['ads']) {
  const n = (event: AdEvent) => ads?.[event] ?? 0
  $('ads-opened').textContent = ads ? String(OPENED.reduce((sum, event) => sum + n(event), 0)) : '–'
  $('ad-level').textContent = `Ad level changed at ${new Date(AD_LEVEL.changedAt).toLocaleString()}: ${AD_LEVEL.summary}.`
  $('ads-held').textContent = ads ? String(n('cooldown') + n('cap')) : '–'
  $('ads').replaceChildren(
    ...AD_ROWS.map(({ event, label }) => {
      const li = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = label
      const number = document.createElement('span')
      number.textContent = String(n(event))
      li.append(name, number)
      return li
    }),
  )
}

const SERVER_ROWS = [
  { id: 'nextstream', label: 'Server 1 (CodeSpecter)' },
  { id: 'embedmaster', label: 'Server 2 (EmbedMaster)' },
] as const

function renderServers(players: PlayerCounts | undefined, key: KeyStatus | undefined) {
  const total = (event: PlayerEvent) => (players ? players.nextstream[event] + players.embedmaster[event] : null)
  $('player-opens').textContent = players ? String(total('load')) : '–'
  $('servers').replaceChildren(
    ...SERVER_ROWS.map(({ id, label }) => {
      const c = players?.[id]
      const li = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = label
      const numbers = document.createElement('span')
      numbers.textContent = c
        ? `${c.load} opens` +
          (id === 'nextstream' && players ? ` · ${players.calls} key calls` : '')
        : '–'
      li.append(name, numbers)
      return li
    }),
  )
  const warning = keyWarning(key, Date.now())
  $('key-warning').hidden = !warning
  $('key-warning').textContent = warning ?? ''
  $('key-note').textContent = key?.expiresAt
    ? `Server 1 key expires on ${new Date(key.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} (issued ${key.issued}, 30 days).`
    : 'Set NEXTSTREAM_KEY_ISSUED=YYYY-MM-DD (the day the CodeSpecter key was issued) on Vercel to get an expiry warning.'
}

/** The CodeSpecter key: refused by NextStream, expired, or due to expire within KEY_WARN_DAYS; else null. */
export function keyWarning(key: KeyStatus | undefined, now: number): string | null {
  if (!key) return null
  if (key.rejectedAt && (!key.okAt || key.rejectedAt > key.okAt)) {
    return `⚠️ CodeSpecter refused our API key at ${new Date(key.rejectedAt).toLocaleString()}. Server 1 is down: get a new key at api.codespecters.com/api, put it in NEXTSTREAM_API_KEY and redeploy.`
  }
  if (key.expiresAt === null) return null
  const days = Math.ceil((key.expiresAt - now) / DAY_MS)
  if (days <= 0) return '⚠️ The CodeSpecter key has passed its 30 days. Get a new key, update NEXTSTREAM_API_KEY and NEXTSTREAM_KEY_ISSUED, and redeploy.'
  if (days <= KEY_WARN_DAYS) {
    return `⚠️ The CodeSpecter key expires in ${days} day${days === 1 ? '' : 's'} (${new Date(key.expiresAt).toLocaleDateString()}). Get a new key, update NEXTSTREAM_API_KEY and NEXTSTREAM_KEY_ISSUED, and redeploy.`
  }
  return null
}

function renderTags(ads: LiveCount['ads'], startedAt: number | null) {
  $('tags').replaceChildren(
    ...TAG_ROWS.map(({ event, label }) => {
      const li = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = label
      const number = document.createElement('span')
      number.textContent = ads ? String(ads[event] ?? 0) : '–'
      li.append(name, number)
      return li
    }),
  )
  $('ad-test').textContent =
    (startedAt ? `Ad test (zone ${MULTITAG_2.zone}) started at ${new Date(startedAt).toLocaleString()}.` : `Ad test (zone ${MULTITAG_2.zone}): not loaded anywhere yet.`) +
    (MULTITAG_2.enabled ? '' : ' Switched off in this build (MULTITAG_2_ENABLED=false).')
}

interface StreamRow {
  key: string
  matchId: number | null
  home: string
  away: string
  league: string
  score: string | null
  servers: number
  viewers: number | null
}

interface StreamCall {
  at: number
  ok: boolean
  status: number
  requests: number
  matches: number
  ms: number
  remaining: number | null
  why: string
}

interface StreamsInfo {
  usage: { limit: number; used: number; at: number } | null
  stopped: boolean
  fetchedAt: number | null
  expiresAt: number | null
  streams: StreamRow[]
  calls: StreamCall[]
}

const time = (ms: number) => new Date(ms).toLocaleTimeString()

function cell(text: string, className?: string) {
  const span = document.createElement('span')
  span.textContent = text
  if (className) span.className = className
  return span
}

/** "Refresh stream": asks the Live Stream API again now (at most once per match every 10 minutes). */
async function refreshStream(row: StreamRow, button: HTMLButtonElement) {
  button.disabled = true
  button.textContent = 'Refreshing…'
  try {
    const response = await fetch(`/api/football/admin-refresh?match=${encodeURIComponent(row.key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${password}` },
    })
    if (response.status === 429) {
      const { retryInMs } = (await response.json().catch(() => ({}))) as { retryInMs?: number }
      button.textContent = `Again in ${Math.ceil((retryInMs ?? 0) / 60_000)} min`
      return
    }
    button.textContent = response.ok ? 'Refreshed' : 'Failed'
    if (response.ok) await loadStreams()
  } catch {
    button.textContent = 'Failed'
  }
}

function renderStreams(info: StreamsInfo) {
  const usage = info.usage
  $('sl-usage').textContent = usage ? `${usage.used.toLocaleString()}/${usage.limit.toLocaleString()}` : '–'
  $('sl-usage-note').textContent = usage
    ? `used${info.stopped ? ' · stopped at 95%, serving cached streams' : ''} · as of ${time(usage.at)}`
    : 'requests used (no calls yet)'
  $('sl-list-note').textContent = info.fetchedAt
    ? `Live list fetched at ${time(info.fetchedAt)}, refreshed after ${time(info.expiresAt ?? info.fetchedAt)} when someone is watching.`
    : 'The live list has not been fetched yet.'

  const rows = info.streams.map((row) => {
    const li = document.createElement('li')
    li.className = 'stream'
    const name = cell(`${row.matchId ? '⚽' : '·'} ${row.home} vs ${row.away}${row.score ? ` (${row.score})` : ''}`)
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Refresh stream'
    button.addEventListener('click', () => void refreshStream(row, button))
    const viewers = row.viewers === null ? '' : ` · ${row.viewers} watching`
    const shown = row.matchId ? 'on the site' : 'not on the site (no stream yet)'
    li.append(name, button, cell(`${row.league} · ${row.servers} server${row.servers === 1 ? '' : 's'}${viewers} · ${shown}`, 'meta'))
    return li
  })
  $('sl-streams').replaceChildren(...rows)
  $('sl-empty').hidden = rows.length > 0

  const calls = info.calls.map((call) => {
    const li = document.createElement('li')
    const what = call.ok ? `${call.matches} live match${call.matches === 1 ? '' : 'es'}` : `failed (HTTP ${call.status || 'none'})`
    li.append(
      cell(`${time(call.at)} · ${call.why} · ${what}`),
      cell(`${call.requests} req · ${call.ms} ms${call.remaining === null ? '' : ` · ${call.remaining.toLocaleString()} left`}`),
    )
    return li
  })
  $('sl-calls').replaceChildren(...calls)
  $('sl-calls-empty').hidden = calls.length > 0
}

/** The Live Stream API panel. Its failures only show in the panel. */
async function loadStreams() {
  const error = $('sl-error')
  try {
    const response = await fetch('/api/football/admin-streams', { headers: { Authorization: `Bearer ${password}` }, cache: 'no-store' })
    if (!response.ok) throw new Error(String(response.status))
    renderStreams((await response.json()) as StreamsInfo)
    error.hidden = true
  } catch {
    error.textContent = "Couldn't load the Live Stream API panel. Trying again shortly."
    error.hidden = false
  }
}

/** Loads the numbers; false when the password was refused. */
export async function refresh(): Promise<boolean> {
  const error = $('stats-error')
  try {
    const response = await fetch('/api/live/count', { headers: { Authorization: `Bearer ${password}` }, cache: 'no-store' })
    if (response.status === 401) {
      savePassword('')
      showLogin('Wrong password.')
      return false
    }
    if (!response.ok) {
      const { error: reason } = (await response.json().catch(() => ({}))) as { error?: string }
      error.textContent =
        reason === 'not-configured'
          ? 'ADMIN_PASSWORD is not set on the server.'
          : reason === 'no-store'
            ? 'The Upstash Redis store is not connected yet.'
            : "Couldn't load the numbers. Trying again shortly."
      error.hidden = false
      return true
    }
    error.hidden = true
    await Promise.all([render((await response.json()) as LiveCount), loadStreams(), loadAccounts()])
  } catch {
    error.textContent = "Couldn't load the numbers. Trying again shortly."
    error.hidden = false
  }
  return true
}

const PROMO_STATES = { upcoming: '⏳ Upcoming', active: '🟢 Active', ended: '⏹ Ended' } as const
const lagosTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })

/** The Free Ad-Free Week: its state (by the server's clock), sign-ups since it started and today's. */
function renderPromo(promo: { state: keyof typeof PROMO_STATES; start: string; end: string; signups: number } | null, today: number) {
  if (!promo) {
    $('promo-state').textContent = 'Off'
    $('promo-when').textContent = 'no PROMO_START / PROMO_END set'
    $('promo-signups').textContent = '–'
    $('promo-today').textContent = '–'
    return
  }
  $('promo-state').textContent = PROMO_STATES[promo.state]
  $('promo-when').textContent = `${lagosTime(promo.start)} → ${lagosTime(promo.end)} (Lagos)`
  $('promo-signups').textContent = promo.state === 'upcoming' ? '0' : promo.signups.toLocaleString()
  $('promo-today').textContent = String(today)
}

/** Registered users and today's sign-ups (/api/account/stats); needs SUPABASE_SERVICE_ROLE_KEY on the server. */
async function loadAccounts() {
  const note = $('acc-note')
  try {
    const response = await fetch('/api/account/stats', { headers: { Authorization: `Bearer ${password}` }, cache: 'no-store' })
    const body = (await response.json().catch(() => ({}))) as {
      users?: number
      today?: number
      promo?: { state: 'upcoming' | 'active' | 'ended'; start: string; end: string; signups: number } | null
      error?: string
    }
    if (response.ok && typeof body.users === 'number') {
      $('acc-users').textContent = body.users.toLocaleString()
      $('acc-today').textContent = String(body.today ?? 0)
      renderPromo(body.promo ?? null, body.today ?? 0)
      note.textContent = 'Optional sign-in (Supabase). Today: since midnight, Lagos time.'
      return
    }
    note.textContent =
      body.error === 'not-configured'
        ? 'Needs SUPABASE_SERVICE_ROLE_KEY in Vercel’s environment variables (then redeploy).'
        : 'Couldn’t load the account numbers.'
  } catch {
    note.textContent = 'Couldn’t load the account numbers.'
  }
}

async function start() {
  const ok = await refresh()
  if (!ok) return
  savePassword(password)
  $('login').hidden = true
  $('stats').hidden = false
  // Give ad-free: loaded once on unlock (and after each change), not on every refresh.
  void loadAdFree()
  window.clearInterval(timer)
  timer = window.setInterval(() => {
    if (document.visibilityState !== 'hidden') void refresh()
  }, REFRESH_MS)
}

export function initAdmin() {
  initAdFree(() => password)
  $('login').addEventListener('submit', (event) => {
    event.preventDefault()
    password = $<HTMLInputElement>('password').value
    void start()
  })
  $('sign-out').addEventListener('click', () => {
    savePassword('')
    password = ''
    $<HTMLInputElement>('password').value = ''
    showLogin()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && password && $('login').hidden) void refresh()
  })
  password = readPassword()
  if (password) void start()
  else showLogin()
}

if (document.getElementById('login')) initAdmin()
