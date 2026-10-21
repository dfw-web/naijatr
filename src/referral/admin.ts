/**
 * /admin/challenge (admin/challenge/index.html): the Invite Challenge's final
 * top 10 with suspicious-activity flags, Confirm / Disqualify for the
 * winners, and each winner's claim details (decrypted on the server, shown
 * only here) with "Mark as paid", which deletes them for good. The password
 * is shared with /admin/live and /admin/feedback for this browser tab.
 */

const PASSWORD_KEY = 'naijatr.admin.password'

interface Row {
  id: number
  rank: number
  points: number
  nickname: string
  username: string | null
  hidden: boolean
  flags: string[]
}

interface Confirmed {
  id: number
  place: number
  amount: number
  name: string
  username: string | null
  messaged: boolean
  paid: boolean
  claim: { accountName: string; provider: string; accountNumber: string; phone: string; at: number } | null
}

interface View {
  contest: { phase: string; start: number; end: number; prizes: number[] }
  top: Row[]
  confirmed: Confirmed[]
  disqualified: { id: number; nickname: string }[]
  telegram: boolean
  claimsReady: boolean
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const PLACES = ['🥇 1st', '🥈 2nd', '🥉 3rd']
const naira = (n: number) => `₦${n.toLocaleString('en-NG')}`
const lagos = (t: number) => new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })

let password = ''

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
  $('panel').hidden = true
  $('login').hidden = false
  $('login-error').hidden = !message
  $('login-error').textContent = message ?? ''
}

function el(tag: string, text = '', className = '') {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

function button(label: string, onClick: () => void, ghost = false) {
  const b = el('button', label, ghost ? 'ghost' : '') as HTMLButtonElement
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

async function post(action: string, body: unknown) {
  const response = await fetch(`/api/referral/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null)
  if (!response?.ok) {
    const { error } = ((await response?.json().catch(() => ({}))) ?? {}) as { error?: string }
    $('panel-error').textContent =
      error === 'not-ended'
        ? 'The challenge hasn’t ended yet.'
        : error === 'confirm-in-order'
          ? 'Confirm 1st, then 2nd, then 3rd.'
          : error === 'already-confirmed'
            ? 'A confirmed winner can’t be disqualified.'
            : 'That didn’t work. Please try again.'
    $('panel-error').hidden = false
    return false
  }
  $('panel-error').hidden = true
  await load()
  return true
}

function render(view: View) {
  const { contest } = view
  $('contest').textContent = `${contest.phase.toUpperCase()} · ${lagos(contest.start)} → ${lagos(contest.end)} (Lagos) · prizes ${contest.prizes.map(naira).join(' / ')}`
  const warnings = [
    view.telegram ? '' : 'TELEGRAM_BOT_TOKEN is missing: winners can’t be messaged.',
    view.claimsReady ? '' : 'CLAIM_ENCRYPTION_KEY is missing: winners can’t send their details.',
  ].filter(Boolean)
  $('warnings').textContent = warnings.join(' ')
  $('warnings').hidden = !warnings.length

  const next = view.confirmed.length + 1
  $('confirmed').replaceChildren(
    ...view.confirmed.map((c) => {
      const li = el('li', '', 'row')
      const line = el('div', '', 'line')
      line.append(el('strong', `${PLACES[c.place - 1]} · ${c.name}${c.username ? ` (@${c.username})` : ''}`), el('span', naira(c.amount)))
      li.append(line)
      li.append(el('span', c.messaged ? 'Messaged on Telegram ✓' : 'Telegram message failed: ask them to /start @naijatr_bot, then message them yourself.', c.messaged ? 'muted' : 'flag'))
      if (c.paid) li.append(el('span', 'Paid ✓ (details deleted)', 'muted'))
      else if (c.claim) {
        li.append(el('pre', `Name: ${c.claim.accountName}\nProvider: ${c.claim.provider}\nAccount: ${c.claim.accountNumber}\nPhone: ${c.claim.phone}\nSent: ${lagos(c.claim.at)}`, 'claim'))
        const actions = el('div', '', 'actions')
        actions.append(
          button('Mark as paid (deletes these details)', () => {
            if (window.confirm(`Paid ${c.name}? Their bank details are deleted for good.`)) void post('admin-paid', { id: c.id })
          }),
        )
        li.append(actions)
      } else li.append(el('span', 'Waiting for their claim (48h link).', 'muted'))
      return li
    }),
  )

  $('top').replaceChildren(
    ...view.top.map((row) => {
      const li = el('li', '', 'row')
      const line = el('div', '', 'line')
      line.append(
        el('strong', `#${row.rank} · ${row.nickname}${row.username ? ` (@${row.username})` : ''}${row.hidden ? ' · name hidden' : ''}`),
        el('span', `${row.points} pts · id ${row.id}`),
      )
      li.append(line)
      for (const flag of row.flags) li.append(el('span', `⚠ ${flag}`, 'flag'))
      const confirmed = view.confirmed.some((c) => c.id === row.id)
      if (!confirmed && next <= 3) {
        const actions = el('div', '', 'actions')
        // The first unconfirmed person is the next place.
        const isNext = view.top.filter((r) => !view.confirmed.some((c) => c.id === r.id))[0]?.id === row.id
        if (isNext) actions.append(button(`Confirm ${PLACES[next - 1]} (${naira(contest.prizes[next - 1])})`, () => void post('admin-confirm', { place: next })))
        actions.append(
          button(
            'Disqualify',
            () => {
              if (window.confirm(`Disqualify ${row.nickname}? Everyone below moves up.`)) void post('admin-dq', { id: row.id })
            },
            true,
          ),
        )
        li.append(actions)
      }
      return li
    }),
  )
  $('top-empty').hidden = view.top.length > 0
  $('dq').replaceChildren(...view.disqualified.map((d) => el('li', `${d.nickname} (id ${d.id})`, 'muted')))
}

async function load(): Promise<boolean> {
  const response = await fetch('/api/referral/admin', { headers: { Authorization: `Bearer ${password}` }, cache: 'no-store' }).catch(() => null)
  if (response?.status === 401) {
    savePassword('')
    showLogin('Wrong password.')
    return false
  }
  if (!response?.ok) {
    const { error } = ((await response?.json().catch(() => ({}))) ?? {}) as { error?: string }
    $('panel-error').textContent =
      error === 'no-contest' ? 'No contest is set: add CONTEST_START and CONTEST_END on Vercel.' : error === 'not-configured' ? 'Redis or a secret is missing on the server.' : 'Couldn’t load. Please reload.'
    $('panel-error').hidden = false
    return true
  }
  render((await response.json()) as View)
  return true
}

async function start() {
  if (!(await load())) return
  savePassword(password)
  $('login').hidden = true
  $('panel').hidden = false
}

$('login').addEventListener('submit', (event) => {
  event.preventDefault()
  password = ($('password') as HTMLInputElement).value
  void start()
})
$('sign-out').addEventListener('click', () => {
  savePassword('')
  password = ''
  showLogin()
})
password = readPassword()
if (password) void start()
else showLogin()
