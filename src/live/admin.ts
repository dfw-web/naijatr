/**
 * /admin/live (admin/live/index.html): who's on the site right now, from the
 * live viewer counter (server/live/handlers.ts). The password is checked by
 * /api/live/count and kept for this browser tab only (sessionStorage).
 * Refreshes every 30 seconds while the tab is visible.
 */

export const REFRESH_MS = 30_000
const PASSWORD_KEY = 'naijatr.admin.password'

interface LiveCount {
  watching: number
  browsing: number
  top: { item: string; viewers: number }[]
}

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
  $('empty').hidden = rows.length > 0
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString()} · refreshes every 30 seconds`
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
    await render((await response.json()) as LiveCount)
  } catch {
    error.textContent = "Couldn't load the numbers. Trying again shortly."
    error.hidden = false
  }
  return true
}

async function start() {
  const ok = await refresh()
  if (!ok) return
  savePassword(password)
  $('login').hidden = true
  $('stats').hidden = false
  window.clearInterval(timer)
  timer = window.setInterval(() => {
    if (document.visibilityState !== 'hidden') void refresh()
  }, REFRESH_MS)
}

export function initAdmin() {
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
