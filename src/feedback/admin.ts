/**
 * /admin/feedback (admin/feedback/index.html): the feedback inbox, from
 * /api/feedback/list (server/feedback/handlers.ts). Newest first, filtered by
 * type, rating and status, with the average rating and the most requested
 * titles; each item can be marked done or deleted. The password is shared
 * with /admin/live for this browser tab (sessionStorage).
 */

const PASSWORD_KEY = 'naijatr.admin.password'

interface Item {
  id: string
  type: 'review' | 'bug' | 'request' | 'other' | 'rating'
  rating: number | null
  message: string
  name: string
  page: string
  title: string
  device: string
  at: number
  done: boolean
}

interface Inbox {
  items: Item[]
  total: number
  averageRating: number | null
  ratings: number
  topRequests: { text: string; count: number }[]
  telegram: boolean
}

const TYPE_LABEL: Record<Item['type'], string> = {
  review: 'Review',
  bug: 'Bug',
  request: 'Request',
  other: 'Other',
  rating: 'Rate this',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let password = ''
let inbox: Inbox | null = null

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

function showLogin(message?: string) {
  $('inbox').hidden = true
  $('login').hidden = false
  const error = $('login-error')
  error.hidden = !message
  error.textContent = message ?? ''
  $<HTMLInputElement>('password').focus()
}

function text(tag: string, value: string, className?: string) {
  const el = document.createElement(tag)
  el.textContent = value
  if (className) el.className = className
  return el
}

async function update(id: string, action: 'done' | 'undone' | 'delete') {
  const response = await fetch('/api/feedback/update', {
    method: 'POST',
    headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }),
  }).catch(() => null)
  if (!response?.ok) {
    $('inbox-error').textContent = "Couldn't change that item. Please try again."
    $('inbox-error').hidden = false
    return
  }
  if (!inbox) return
  if (action === 'delete') inbox.items = inbox.items.filter((i) => i.id !== id)
  else inbox.items = inbox.items.map((i) => (i.id === id ? { ...i, done: action === 'done' } : i))
  renderItems()
}

function renderItems() {
  if (!inbox) return
  const type = $<HTMLSelectElement>('filter-type').value
  const rating = $<HTMLSelectElement>('filter-rating').value
  const status = $<HTMLSelectElement>('filter-status').value
  const shown = inbox.items.filter(
    (i) =>
      (!type || i.type === type) &&
      (!rating || (rating === 'none' ? i.rating === null : i.rating === Number(rating))) &&
      (!status || (status === 'done') === i.done),
  )
  const rows = shown.map((item) => {
    const li = document.createElement('li')
    li.className = `item${item.done ? ' done' : ''}`
    const head = document.createElement('div')
    head.className = 'head'
    if (item.rating) head.append(text('span', `${'★'.repeat(item.rating)}${'☆'.repeat(5 - item.rating)}`, 'stars'))
    head.append(
      text('span', TYPE_LABEL[item.type], 'type'),
      text('span', new Date(item.at).toLocaleString()),
      text('span', item.device),
      text('span', item.page),
    )
    if (item.name) head.append(text('span', `From: ${item.name}`))
    li.append(head)
    if (item.title) li.append(text('p', `🎬 ${item.title}`, 'message'))
    if (item.message) li.append(text('p', item.message, 'message'))
    const actions = document.createElement('div')
    actions.className = 'actions'
    const done = text('button', item.done ? 'Mark not done' : 'Mark done', 'ghost') as HTMLButtonElement
    done.type = 'button'
    done.addEventListener('click', () => void update(item.id, item.done ? 'undone' : 'done'))
    const remove = text('button', 'Delete', 'ghost') as HTMLButtonElement
    remove.type = 'button'
    remove.addEventListener('click', () => {
      if (window.confirm('Delete this item for good?')) void update(item.id, 'delete')
    })
    actions.append(done, remove)
    li.append(actions)
    return li
  })
  $('items').replaceChildren(...rows)
  $('items-empty').hidden = rows.length > 0
  $('open').textContent = String(inbox.items.filter((i) => !i.done).length)
}

function render(data: Inbox) {
  inbox = data
  $('total').textContent = String(data.total)
  $('average').textContent = data.averageRating === null ? '–' : `${data.averageRating}★`
  $('average-note').textContent = `average rating (${data.ratings} rated)`
  $('telegram-note').hidden = data.telegram
  const requests = data.topRequests.map((r) => {
    const li = document.createElement('li')
    li.append(text('span', r.text), text('span', `${r.count}×`))
    return li
  })
  $('requests').replaceChildren(...requests)
  $('requests-empty').hidden = requests.length > 0
  renderItems()
}

/** Loads the inbox; false when the password was refused. */
async function load(): Promise<boolean> {
  const error = $('inbox-error')
  try {
    const response = await fetch('/api/feedback/list', { headers: { Authorization: `Bearer ${password}` }, cache: 'no-store' })
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
            ? 'The Upstash Redis store is not connected.'
            : "Couldn't load the feedback. Please reload."
      error.hidden = false
      return true
    }
    error.hidden = true
    render((await response.json()) as Inbox)
  } catch {
    error.textContent = "Couldn't load the feedback. Please reload."
    error.hidden = false
  }
  return true
}

async function start() {
  if (!(await load())) return
  savePassword(password)
  $('login').hidden = true
  $('inbox').hidden = false
}

export function initFeedbackAdmin() {
  $('login').addEventListener('submit', (event) => {
    event.preventDefault()
    password = $<HTMLInputElement>('password').value
    void start()
  })
  for (const id of ['filter-type', 'filter-rating', 'filter-status']) $(id).addEventListener('change', renderItems)
  $('sign-out').addEventListener('click', () => {
    savePassword('')
    password = ''
    $<HTMLInputElement>('password').value = ''
    showLogin()
  })
  password = readPassword()
  if (password) void start()
  else showLogin()
}

if (document.getElementById('inbox')) initFeedbackAdmin()
