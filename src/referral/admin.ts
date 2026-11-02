/**
 * /admin/referrals (admin/referrals/index.html): the week's top 10 referrers
 * with their emails, counts and suspicious-activity flags, Confirm winner /
 * Disqualify for the weekly mystery prize, past winners and totals. The
 * password is shared with /admin/live and /admin/feedback for this browser tab.
 */

const PASSWORD_KEY = 'naijatr.admin.password'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

interface Row {
  userId: string
  email: string | null
  count: number
  reachedAt: string
  flags: string[]
  flagged: number
  held: number
  rejected: number
  decision: 'winner' | 'disqualified' | null
}

interface View {
  week: { key: string; start: string; end: string; current: boolean }
  top: Row[]
  suggested: string | null
  winners: { week: string; userId: string; email: string | null; referrals: number; decidedAt: string }[]
  totals: Record<'pending' | 'counted' | 'held' | 'rejected', number>
}

const FLAG_NAMES: Record<string, string> = {
  'ip-limit': 'over the daily limit for one network (held)',
  'referrer-network': 'same network as the referrer',
  'shared-network': 'several of their referrals share a network',
  burst: '5+ sign-ups within an hour',
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const lagos = (t: string) => new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })
const lagosDate = (t: string | number) => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium' })

let password = ''
let week: string | null = null

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

async function decide(userId: string, decision: 'winner' | 'disqualified' | 'clear') {
  const response = await fetch('/api/referral/decide', {
    method: 'POST',
    headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ week, userId, decision }),
  }).catch(() => null)
  if (!response?.ok) {
    $('panel-error').textContent = response?.status === 409 ? 'This week already has a winner: undo it first.' : 'That didn’t work. Please try again.'
    $('panel-error').hidden = false
    return
  }
  $('panel-error').hidden = true
  await load()
}

function render(view: View) {
  week = view.week.key
  const totals = [
    ['Counted', view.totals.counted],
    ['Waiting (not watched yet)', view.totals.pending],
    ['Held for review', view.totals.held],
    ['Rejected', view.totals.rejected],
  ] as const
  $('totals').replaceChildren(
    ...totals.map(([label, n]) => {
      const box = el('p', '', 'stat')
      box.append(el('strong', String(n)), el('span', label))
      return box
    }),
  )
  $('week').textContent = `Week of ${lagosDate(`${view.week.key}T12:00:00Z`)} → ${lagosDate(Date.parse(view.week.end) - 1)}${view.week.current ? ' (this week, still running)' : ''}`
  ;($('next') as HTMLButtonElement).disabled = view.week.current

  const hasWinner = view.top.some((r) => r.decision === 'winner')
  $('top').replaceChildren(
    ...view.top.map((row, i) => {
      const li = el('li', '', 'row')
      const line = el('div', '', 'line')
      const tag = row.decision === 'winner' ? ' · 🏆 WINNER' : row.decision === 'disqualified' ? ' · disqualified' : row.userId === view.suggested ? ' · top (not confirmed)' : ''
      line.append(el('strong', `#${i + 1} · ${row.email ?? row.userId}${tag}`), el('span', `${row.count} counted · reached ${lagos(row.reachedAt)}`))
      li.append(line)
      if (row.flagged) li.append(el('span', `⚠ ${row.flagged} flagged this week: ${row.flags.map((f) => FLAG_NAMES[f] ?? f).join('; ')}`, 'flag'))
      if (row.held) li.append(el('span', `⚠ ${row.held} held for review (over a network's daily limit)`, 'flag'))
      if (row.rejected) li.append(el('span', `⚠ ${row.rejected} rejected (self-referral or duplicate inbox)`, 'flag'))
      const actions = el('div', '', 'actions')
      if (row.decision) {
        actions.append(button(row.decision === 'winner' ? 'Undo winner' : 'Undo disqualify', () => void decide(row.userId, 'clear'), true))
      } else {
        if (!hasWinner) {
          actions.append(
            button('Confirm winner', () => {
              if (view.week.current && !window.confirm('This week is still running. Confirm the winner anyway?')) return
              void decide(row.userId, 'winner')
            }),
          )
        }
        actions.append(
          button(
            'Disqualify',
            () => {
              if (window.confirm(`Disqualify ${row.email ?? row.userId} for this week?`)) void decide(row.userId, 'disqualified')
            },
            true,
          ),
        )
      }
      li.append(actions)
      return li
    }),
  )
  $('top-empty').hidden = view.top.length > 0
  $('winners').replaceChildren(
    ...view.winners.map((w) => el('li', `Week of ${lagosDate(`${w.week}T12:00:00Z`)} · ${w.email ?? w.userId} · ${w.referrals} referrals`, 'row')),
  )
  $('winners-empty').hidden = view.winners.length > 0
}

async function load(): Promise<boolean> {
  const query = week ? `?week=${week}` : ''
  const response = await fetch(`/api/referral/admin${query}`, { headers: { Authorization: `Bearer ${password}` }, cache: 'no-store' }).catch(() => null)
  if (response?.status === 401) {
    savePassword('')
    showLogin('Wrong password.')
    return false
  }
  if (!response?.ok) {
    $('panel-error').textContent = response?.status === 503 ? 'Supabase isn’t set up on the server (SUPABASE_SERVICE_ROLE_KEY).' : 'Couldn’t load. Has the SQL migration been run?'
    $('panel-error').hidden = false
    return true
  }
  render((await response.json()) as View)
  return true
}

const shiftWeek = (by: number) => {
  if (!week) return
  week = new Date(Date.parse(`${week}T00:00:00Z`) + by * WEEK_MS).toISOString().slice(0, 10)
  void load()
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
$('prev').addEventListener('click', () => shiftWeek(-1))
$('next').addEventListener('click', () => shiftWeek(1))
password = readPassword()
if (password) void start()
else showLogin()
