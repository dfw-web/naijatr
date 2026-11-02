import { AD_FREE_PLANS, naira } from '../config/adFree'

/**
 * /admin/live → "Give ad-free" (admin/live/index.html): paid ad-free given by
 * hand after a Telegram payment, through /api/referral/admin-* (the server
 * holds the Supabase service key). The form adds days by account email; the
 * list shows everyone ad-free now, with +30 / +90 days and Remove each; every
 * change is logged (ad_free_grants) and totalled.
 */

interface Grant {
  email: string
  action: 'grant' | 'remove'
  plan: string | null
  days: number
  amount: number
  note: string | null
  ad_free_until: string | null
  created_at: string
}

interface AdFreeUser {
  userId: string
  email: string
  adFreeUntil: string | null
  sources: ('paid' | 'referral' | 'allowlist')[]
  note: string | null
}

interface Overview {
  users: AdFreeUser[]
  paidUsersThisMonth: number
  week: number
  month: number
  log: Grant[]
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const input = (id: string) => $<HTMLInputElement>(id)
const lagosDate = (t: string) => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric' })
const lagosTime = (t: string) => new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })

let password = () => ''
let users: AdFreeUser[] = []

function el(tag: string, text = '', className = '') {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

function showError(message: string | null) {
  $('af-error').textContent = message ?? ''
  $('af-error').hidden = !message
}

async function api<T>(action: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const response = await fetch(`/api/referral/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${password()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  }).catch(() => null)
  return { status: response?.status ?? 0, data: response?.ok ? ((await response.json()) as T) : null }
}

/** "✅ ada@gmail.com is ad-free until 2 December 2026" */
const doneText = (user: { email: string; adFreeUntil: string | null; permanent?: boolean }) =>
  user.permanent || !user.adFreeUntil ? `✅ ${user.email} is ad-free for good (AD_FREE_EMAILS)` : `✅ ${user.email} is ad-free until ${lagosDate(user.adFreeUntil)}`

const grantLine = (g: Grant) =>
  [
    lagosTime(g.created_at),
    g.email,
    g.action === 'grant' ? `+${g.days} days${g.plan ? ` (${g.plan})` : ''}` : 'Removed',
    g.amount ? (g.amount > 0 ? naira(g.amount) : `refund ${naira(-g.amount)}`) : '',
    g.note ?? '',
  ]
    .filter(Boolean)
    .join(' · ')

function renderUsers() {
  const query = input('af-search').value.trim().toLowerCase()
  const shown = users.filter((u) => u.email.toLowerCase().includes(query))
  $('af-users').replaceChildren(
    ...shown.map((user) => {
      const li = el('li')
      const line = el('div', '', 'line')
      line.append(el('strong', user.email), el('span', user.adFreeUntil ? `until ${lagosDate(user.adFreeUntil)}` : 'for good'))
      li.append(line, el('span', `Source: ${user.sources.join(' + ')}${user.note ? ` · Note: ${user.note}` : ''}`, 'muted'))
      if (!user.sources.includes('allowlist')) {
        const actions = el('div', '', 'af-actions')
        for (const days of [30, 90]) {
          const b = el('button', `+${days} days`) as HTMLButtonElement
          b.type = 'button'
          b.addEventListener('click', () => {
            const paid = window.prompt(`Add ${days} days of ad-free to ${user.email}?\nAmount paid (₦), or leave empty:`, '')
            if (paid === null) return
            void give({ userId: user.userId, days, plan: days === 30 ? '1 Month' : days === 90 ? '3 Months' : 'Custom', amount: Number(paid) || 0 })
          })
          actions.append(b)
        }
        const remove = el('button', 'Remove ad-free', 'ghost') as HTMLButtonElement
        remove.type = 'button'
        remove.addEventListener('click', () => {
          if (!window.confirm(`Remove ad-free from ${user.email}? Ads come back on their next page load.`)) return
          void change('admin-remove', { userId: user.userId })
        })
        actions.append(remove)
        li.append(actions)
      }
      return li
    }),
  )
  $('af-empty').hidden = shown.length > 0
}

/** Loads the totals, the ad-free list and the log. */
export async function loadAdFree(): Promise<void> {
  const { status, data } = await api<Overview>('admin-ad-free')
  if (!data) {
    return showError(status === 503 ? 'Needs SUPABASE_SERVICE_ROLE_KEY on Vercel.' : 'Couldn’t load ad-free users. Has supabase/migrations/003_ad_free_grants.sql been run?')
  }
  showError(null)
  users = data.users
  $('af-paid').textContent = String(data.paidUsersThisMonth)
  $('af-week').textContent = naira(data.week)
  $('af-month').textContent = naira(data.month)
  renderUsers()
  $('af-log').replaceChildren(...data.log.map((g) => el('li', grantLine(g), 'muted')))
}

function result(text: string, ok: boolean) {
  const node = $('af-result')
  node.textContent = text
  node.className = ok ? 'ok' : 'bad'
  node.hidden = false
}

async function change(action: 'admin-grant' | 'admin-remove', body: Record<string, unknown>) {
  const { status, data } = await api<{ email: string; adFreeUntil: string | null; permanent: boolean; adFree: boolean }>(action, body)
  if (data) {
    result(action === 'admin-grant' || data.adFree ? doneText(data) : `✅ Ad-free removed from ${data.email}`, true)
    await loadAdFree()
    return true
  }
  result(
    status === 404
      ? '❌ No account found with this email. Ask them to sign up first.'
      : status === 400
        ? '❌ Check the days and amount.'
        : status === 401
          ? '❌ Wrong admin password: sign out and in again.'
          : '❌ That didn’t work. Please try again.',
    false,
  )
  return false
}

const give = (body: Record<string, unknown>) => change('admin-grant', body)

/** Wires up the form; `getPassword` is the dashboard's admin password. */
export function initAdFree(getPassword: () => string) {
  password = getPassword
  // "1 Month (30 days)", "3 Months (90 days)": the plans in src/config/adFree.ts. They fill in the days (and the price, if empty).
  $('af-plans').replaceChildren(
    ...AD_FREE_PLANS.map((plan) => {
      const b = el('button', `${plan.label} (${plan.days} days)`, 'ghost') as HTMLButtonElement
      b.type = 'button'
      b.addEventListener('click', () => {
        input('af-days').value = String(plan.days)
        if (!input('af-amount').value) input('af-amount').value = String(plan.price)
        $('af-plans').querySelectorAll('button').forEach((other) => other.classList.toggle('on', other === b))
      })
      return b
    }),
  )
  input('af-days').addEventListener('input', () => $('af-plans').querySelectorAll('button').forEach((b) => b.classList.remove('on')))
  input('af-search').addEventListener('input', renderUsers)
  $('af-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const days = Number(input('af-days').value)
    if (!Number.isInteger(days) || days < 1) return result('❌ Pick 1 Month, 3 Months, or enter a number of days.', false)
    const plan = AD_FREE_PLANS.find((p) => p.days === days)?.label ?? 'Custom'
    const button = $<HTMLButtonElement>('af-give')
    button.disabled = true
    void give({ email: input('af-email').value.trim(), days, plan, amount: Number(input('af-amount').value) || 0, note: input('af-note').value }).then((ok) => {
      button.disabled = false
      if (!ok) return
      for (const id of ['af-email', 'af-days', 'af-amount', 'af-note']) input(id).value = ''
      $('af-plans').querySelectorAll('button').forEach((b) => b.classList.remove('on'))
    })
  })
}
