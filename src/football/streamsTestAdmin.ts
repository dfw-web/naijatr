/**
 * /admin/streams-test (admin/streams-test/index.html): today's live and
 * upcoming matches from the Football Live Streaming API, every direct stream
 * of each, a "Test" player under the stream, a big "Watch" player (fullscreen,
 * volume, next stream), and commentary tags kept on the server
 * (/api/livestreams, server/football/streamsTest.ts). Admin only: the
 * password is shared with the other admin pages for this tab (sessionStorage).
 *
 * Streams play straight from their hosts (they allow any origin): HLS through
 * hls.js (or natively on Safari), FLV through mpegts.js. No proxy.
 */

const PASSWORD_KEY = 'naijatr.admin.password'

type Tag = 'english' | 'arabic' | 'french' | 'other' | 'none' | 'broken'
type Format = 'hls' | 'flv' | 'mp4' | 'other'

interface Server {
  name: string
  url: string
  format: Format
  englishHint: boolean
}

interface Match {
  key: string
  home: string
  away: string
  homeLogo: string | null
  awayLogo: string | null
  score: string | null
  status: string
  league: string
  leagueLogo: string | null
  time: number
  servers: Server[]
}

interface TagRecord {
  match: string
  name: string
  tag: Tag
  url: string
  host: string
  title: string
  at: number
}

interface Group {
  value: string
  tagged: number
  english: number
  consistent: boolean
}

interface Summary {
  byName: Group[]
  byHost: Group[]
}

interface Listing {
  matches: Match[]
  fetchedAt: number | null
  cached: boolean
  stale: boolean
  truncated: boolean
  error: string | null
  usage: { today: number; cap: number }
  tags: TagRecord[]
  summary: Summary
}

const TAG_LABELS: [Tag, string][] = [
  ['english', 'English'],
  ['arabic', 'Arabic'],
  ['french', 'French'],
  ['other', 'Other'],
  ['none', 'No commentary'],
  ['broken', 'Broken'],
]

const ERRORS: Record<string, string> = {
  'daily-cap': 'Daily request cap reached: showing the last answer the API gave. It resets at midnight (Lagos).',
  'rate-limited': 'RapidAPI says the plan’s limit is reached (429): showing the last answer.',
  auth: 'RapidAPI rejected the key (401/403): check RAPIDAPI_KEY and the subscription.',
  unreachable: 'The API couldn’t be reached: showing the last answer.',
  'upstream-error': 'The API answered with an error: showing the last answer.',
  'not-configured': 'RAPIDAPI_KEY isn’t set on the server.',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let password = ''
const lists: Record<'live' | 'vs', Match[]> = { live: [], vs: [] }
let tags = new Map<string, TagRecord>()
let summary: Summary = { byName: [], byHost: [] }

const tagField = (match: string, name: string) => `${match}␟${name}`

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

function showLogin(message?: string) {
  $('app').hidden = true
  $('login').hidden = false
  const error = $('login-error')
  error.hidden = !message
  error.textContent = message ?? ''
  $<HTMLInputElement>('password').focus()
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, headers: { Authorization: `Bearer ${password}` }, cache: 'no-store' })
  if (response.status === 401) {
    savePassword('')
    showLogin('Wrong password.')
    throw new Error('unauthorized')
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<unknown>
}

// --- Players -----------------------------------------------------------------

interface Playback {
  destroy(): void
}

/** Plays `server` in `video`, unmuted; `onStatus` hears how it goes. */
async function attach(video: HTMLVideoElement, server: Server, onStatus: (text: string, kind?: 'good' | 'bad') => void): Promise<Playback> {
  let destroyed = false
  const cleanups: (() => void)[] = []
  const on = (type: string, listener: () => void) => {
    video.addEventListener(type, listener)
    cleanups.push(() => video.removeEventListener(type, listener))
  }
  on('playing', () => onStatus('Playing', 'good'))
  on('waiting', () => onStatus('Buffering…'))
  on('error', () => onStatus('The video element couldn’t play this stream.', 'bad'))
  video.muted = false
  onStatus('Loading…')
  const start = () => {
    if (destroyed) return
    video.play().catch((error: unknown) => {
      // Autoplay with sound blocked: one more tap on Play.
      if (error instanceof DOMException && error.name === 'NotAllowedError') onStatus('Tap Play to start (the browser blocked sound).', 'bad')
    })
  }
  const done = (destroy: () => void): Playback => ({
    destroy() {
      destroyed = true
      cleanups.forEach((cleanup) => cleanup())
      destroy()
      video.removeAttribute('src')
      video.load()
    },
  })

  if (server.format === 'hls') {
    const { default: Hls } = await import('hls.js')
    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: false })
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) onStatus(`Broken: ${data.type} / ${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ''}`, 'bad')
      })
      hls.on(Hls.Events.MANIFEST_PARSED, start)
      hls.loadSource(server.url)
      hls.attachMedia(video)
      return done(() => hls.destroy())
    }
    // Safari / iPhone: native HLS.
    video.src = server.url
    start()
    return done(() => undefined)
  }
  if (server.format === 'flv') {
    const { default: mpegts } = await import('mpegts.js')
    if (!mpegts.isSupported()) {
      onStatus('This browser can’t play FLV (no Media Source).', 'bad')
      return done(() => undefined)
    }
    const player = mpegts.createPlayer({ type: 'flv', isLive: true, url: server.url }, { enableWorker: false, liveBufferLatencyChasing: true })
    player.on(mpegts.Events.ERROR, (type: string, detail: string) => onStatus(`Broken: ${type} / ${detail}`, 'bad'))
    player.attachMediaElement(video)
    player.load()
    start()
    return done(() => {
      player.pause()
      player.unload()
      player.detachMediaElement()
      player.destroy()
    })
  }
  video.src = server.url
  start()
  return done(() => undefined)
}

/** One stream plays at a time: the inline Test player or the big one. */
let current: { playback: Playback | null; stop: () => void } | null = null
let attachSeq = 0

function stopCurrent() {
  current?.playback?.destroy()
  current?.stop()
  current = null
}

// --- Tagging -----------------------------------------------------------------

async function setTag(match: Match, server: Server, tag: Tag | null) {
  const params = new URLSearchParams({
    match: match.key,
    name: server.name,
    tag: tag ?? 'clear',
    url: server.url,
    title: `${match.home} vs ${match.away}`,
  })
  try {
    const body = (await api(`/api/livestreams-tag?${params}`, { method: 'POST' })) as { tags: TagRecord[]; summary: Summary }
    applyTags(body.tags, body.summary)
  } catch (error) {
    if ((error as Error).message !== 'unauthorized') showNotice('The tag wasn’t saved. Try again.')
  }
  refreshTagButtons()
  renderSummary()
}

function applyTags(list: TagRecord[], next: Summary) {
  tags = new Map(list.map((t) => [tagField(t.match, t.name), t]))
  summary = next
}

/** Tag buttons for one stream; they follow `tags` (refreshTagButtons). */
function tagButtons(match: Match, server: Server) {
  const box = el('div', { className: 'row tags' })
  box.dataset.match = match.key
  box.dataset.name = server.name
  for (const [tag, label] of TAG_LABELS) {
    const button = el('button', { type: 'button', className: `tag-${tag}` }, label)
    button.dataset.tag = tag
    button.addEventListener('click', () => {
      const now = tags.get(tagField(match.key, server.name))?.tag
      void setTag(match, server, now === tag ? null : tag)
    })
    box.append(button)
  }
  paintTags(box)
  return box
}

function paintTags(box: HTMLElement) {
  const now = tags.get(tagField(box.dataset.match ?? '', box.dataset.name ?? ''))?.tag
  box.querySelectorAll<HTMLButtonElement>('button[data-tag]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.tag === now))
  })
}

const refreshTagButtons = () => document.querySelectorAll<HTMLElement>('.tags[data-match]').forEach(paintTags)

// --- The big player ------------------------------------------------------------

const watch = {
  match: null as Match | null,
  index: 0,
}

function openWatch(match: Match, index: number) {
  stopCurrent()
  watch.match = match
  watch.index = index
  $('watch').hidden = false
  document.body.style.overflow = 'hidden'
  void playWatch()
}

async function playWatch() {
  const match = watch.match
  if (!match) return
  const server = match.servers[watch.index]
  const video = $<HTMLVideoElement>('watch-video')
  current?.playback?.destroy()
  const seq = ++attachSeq
  $('watch-title').textContent = `${match.home} vs ${match.away} · ${server.name} (${watch.index + 1}/${match.servers.length}) · ${server.format.toUpperCase()}`
  const tagsBox = $('watch-tags')
  tagsBox.replaceChildren(tagButtons(match, server))
  const status = $('watch-status')
  const onStatus = (text: string, kind?: 'good' | 'bad') => {
    if (seq !== attachSeq) return
    status.textContent = text
    status.className = `status${kind ? ` ${kind}` : ''}`
  }
  video.volume = Number($<HTMLInputElement>('watch-volume').value)
  current = { playback: null, stop: closeWatchView }
  const playback = await attach(video, server, onStatus)
  if (seq !== attachSeq || !current) return playback.destroy()
  current.playback = playback
}

function step(by: number) {
  const match = watch.match
  if (!match || match.servers.length < 2) return
  watch.index = (watch.index + by + match.servers.length) % match.servers.length
  void playWatch()
}

function closeWatchView() {
  $('watch').hidden = true
  document.body.style.overflow = ''
  watch.match = null
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
}

function setupWatch() {
  const video = $<HTMLVideoElement>('watch-video')
  const box = $('watch')
  const playButton = $<HTMLButtonElement>('watch-play')
  const muteButton = $<HTMLButtonElement>('watch-mute')
  const volume = $<HTMLInputElement>('watch-volume')
  const paintPlay = () => (playButton.textContent = video.paused ? 'Play' : 'Pause')
  const paintMute = () => (muteButton.textContent = video.muted || video.volume === 0 ? 'Unmute' : 'Mute')
  video.addEventListener('play', paintPlay)
  video.addEventListener('pause', paintPlay)
  video.addEventListener('volumechange', paintMute)
  playButton.addEventListener('click', () => (video.paused ? void video.play().catch(() => undefined) : video.pause()))
  muteButton.addEventListener('click', () => {
    video.muted = !video.muted
    if (!video.muted && video.volume === 0) video.volume = volume.valueAsNumber = 1
  })
  volume.addEventListener('input', () => {
    video.volume = volume.valueAsNumber
    video.muted = volume.valueAsNumber === 0
  })
  $('watch-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => undefined)
    // The whole player, so Next stream and the tags stay on screen; iPhone: the video's own.
    if (box.requestFullscreen) void box.requestFullscreen().catch(() => undefined)
    else (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.()
  })
  document.addEventListener('fullscreenchange', () => {
    $('watch-fullscreen').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'
  })
  $('watch-next').addEventListener('click', () => step(1))
  $('watch-prev').addEventListener('click', () => step(-1))
  $('watch-close').addEventListener('click', stopCurrent)
  document.addEventListener('keydown', (event) => {
    if (box.hidden || event.target instanceof HTMLInputElement) return
    if (event.key === 'Escape' && !document.fullscreenElement) stopCurrent()
    else if (event.key === 'n' || event.key === 'ArrowRight') step(1)
    else if (event.key === 'p' || event.key === 'ArrowLeft') step(-1)
    else if (event.key === 'f') $('watch-fullscreen').click()
    else if (event.key === ' ') {
      event.preventDefault()
      playButton.click()
    }
  })
}

// --- Rendering ---------------------------------------------------------------

const timeText = (ms: number) =>
  ms ? new Date(ms).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ' (Lagos)' : 'time unknown'

function team(name: string, logo: string | null) {
  const box = el('div', { className: 'team' })
  if (logo) box.append(el('img', { src: logo, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }))
  box.append(name)
  return box
}

function streamRow(match: Match, server: Server, index: number) {
  const item = el('li', { className: 'stream' })
  const head = el('div', { className: 'row' }, el('span', { className: 'stream-name' }, server.name), el('span', { className: 'badge' }, server.format.toUpperCase()))
  if (server.englishHint) head.append(el('span', { className: 'badge hint', title: 'The name or URL suggests English' }, 'EN hint'))
  const testButton = el('button', { type: 'button' }, 'Test')
  const watchButton = el('button', { type: 'button', className: 'primary' }, 'Watch')
  head.append(testButton, watchButton)
  const url = el('div', { className: 'stream-url' }, server.url)
  const slot = el('div')
  item.append(head, url, tagButtons(match, server), slot)

  testButton.addEventListener('click', () => {
    if (slot.childElementCount) return stopCurrent()
    stopCurrent()
    const video = el('video', { controls: true, playsInline: true })
    const status = el('div', { className: 'status' })
    slot.append(el('div', { className: 'test-player' }, video, status))
    testButton.textContent = 'Stop'
    const seq = ++attachSeq
    const stop = () => {
      slot.replaceChildren()
      testButton.textContent = 'Test'
    }
    current = { playback: null, stop }
    void attach(video, server, (text, kind) => {
      status.textContent = text
      status.className = `status${kind ? ` ${kind}` : ''}`
    }).then((playback) => {
      if (seq !== attachSeq || !current) return playback.destroy()
      current.playback = playback
    })
  })
  watchButton.addEventListener('click', () => openWatch(match, index))
  return item
}

function matchCard(match: Match) {
  const card = el('article', { className: 'card' })
  const status = el('span', { className: match.status === 'live' ? 'badge live' : 'badge' }, match.status === 'live' ? 'LIVE' : match.status || '—')
  card.append(
    el('div', { className: 'row muted match-meta' }, el('span', {}, match.league || 'League unknown'), el('span', { className: 'row' }, status, timeText(match.time))),
    el('div', { className: 'match-head' }, team(match.home, match.homeLogo), el('div', { className: 'score' }, match.score ?? 'vs'), team(match.away, match.awayLogo)),
  )
  if (!match.servers.length) card.append(el('p', { className: 'muted' }, 'No direct streams listed.'))
  else card.append(el('ul', { className: 'streams' }, ...match.servers.map((server, i) => streamRow(match, server, i))))
  return card
}

function renderList(which: 'live' | 'vs') {
  const box = $(which)
  const matches = lists[which]
  box.replaceChildren(...(matches.length ? matches.map(matchCard) : [el('p', { className: 'muted' }, which === 'live' ? 'No live matches listed.' : 'No upcoming matches listed.')]))
}

function groupTable(title: string, groups: Group[], note: string) {
  const wrap = el('div', { className: 'group' }, el('h3', {}, title), el('p', { className: 'muted' }, note))
  if (!groups.length) return wrap.append(el('p', { className: 'muted' }, 'No tags yet.')), wrap
  const rows = groups.slice(0, 20).map((g) =>
    el('tr', {}, el('td', {}, g.value), el('td', {}, String(g.tagged)), el('td', {}, String(g.english)), el('td', { className: g.consistent ? 'yes' : '' }, g.consistent ? 'Yes' : g.tagged < 3 ? 'Too few tags' : 'No')),
  )
  wrap.append(el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Value'), el('th', {}, 'Tagged'), el('th', {}, 'English'), el('th', {}, 'Consistently English?'))), el('tbody', {}, ...rows))))
  return wrap
}

function renderSummary() {
  const matches = [...lists.live, ...lists.vs]
  const rows = matches.map((m) => {
    const mine = m.servers.map((s) => tags.get(tagField(m.key, s.name))?.tag)
    const english = mine.filter((t) => t === 'english').length
    return { m, streams: m.servers.length, tagged: mine.filter(Boolean).length, english, hints: m.servers.filter((s) => s.englishHint).length }
  })
  const total = rows.reduce((a, r) => ({ streams: a.streams + r.streams, tagged: a.tagged + r.tagged, english: a.english + r.english }), { streams: 0, tagged: 0, english: 0 })
  const box = $('summary')
  box.replaceChildren(
    el('p', { className: 'totals' }, `${matches.length} matches · ${total.streams} direct streams · ${total.tagged} tagged · ${total.english} English`),
  )
  if (rows.length) {
    box.append(
      el(
        'div',
        { className: 'table-wrap' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Match'), el('th', {}, 'Streams'), el('th', {}, 'Tagged'), el('th', {}, 'English'), el('th', {}, 'EN hints'))),
          el('tbody', {}, ...rows.map((r) => el('tr', {}, el('td', {}, `${r.m.home} vs ${r.m.away}`), el('td', {}, String(r.streams)), el('td', {}, String(r.tagged)), el('td', { className: r.english ? 'yes' : '' }, String(r.english)), el('td', {}, String(r.hints))))),
        ),
      ),
    )
  }
  box.append(
    groupTable('By server name', summary.byName, 'Across every tag saved. The API names streams by position ("Server 1"…), so names alone may not mean much.'),
    groupTable('By stream host', summary.byHost, 'Where each stream comes from: a host that keeps giving English is a better signal than its name.'),
  )
}

function showNotice(text: string | null) {
  const notice = $('notice')
  notice.hidden = !text
  notice.textContent = text ?? ''
}

// --- Loading -----------------------------------------------------------------

const toApiDate = (value: string) => {
  const [y, m, d] = value.split('-')
  return y && m && d ? `${d}${m}${y}` : ''
}

function todayInput() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return parts
}

async function load() {
  const button = $<HTMLButtonElement>('refresh')
  button.disabled = true
  button.textContent = 'Loading…'
  const date = toApiDate($<HTMLInputElement>('date').value)
  const league = $<HTMLInputElement>('league').value.trim()
  const notes: string[] = []
  try {
    for (const status of ['live', 'vs'] as const) {
      const params = new URLSearchParams({ status })
      if (date) params.set('date', date)
      if (league) params.set('league', league)
      const body = (await api(`/api/livestreams?${params}`)) as Listing
      lists[status] = body.matches
      applyTags(body.tags, body.summary)
      $('usage').textContent = `API requests today: ${body.usage.today} / ${body.usage.cap} · ${status === 'vs' ? 'upcoming' : 'live'} list from ${
        body.fetchedAt ? new Date(body.fetchedAt).toLocaleTimeString('en-GB') : 'never'
      }${body.cached && !body.stale ? ' (cached, up to 3 min)' : ''}`
      if (body.error) notes.push(`${status === 'live' ? 'Live' : 'Upcoming'}: ${ERRORS[body.error] ?? body.error}`)
      if (body.truncated) notes.push(`${status === 'live' ? 'Live' : 'Upcoming'}: more than 3 pages listed; only the first 60 matches are shown (saves requests).`)
    }
    showNotice(notes.length ? notes.join(' ') : null)
  } catch (error) {
    if ((error as Error).message !== 'unauthorized') showNotice(`Couldn’t load the list: ${(error as Error).message}`)
  } finally {
    button.disabled = false
    button.textContent = 'Load'
  }
  stopCurrent()
  renderList('live')
  renderList('vs')
  renderSummary()
}

function start() {
  $('login').hidden = true
  $('app').hidden = false
  void load()
}

$<HTMLInputElement>('date').value = todayInput()
$('refresh').addEventListener('click', () => void load())
$('login').addEventListener('submit', (event) => {
  event.preventDefault()
  password = $<HTMLInputElement>('password').value
  savePassword(password)
  start()
})
setupWatch()
password = readPassword()
if (password) start()
else showLogin()
