/**
 * /admin/live → Free Ad-Free Week → "📧 Email every account": the week's email
 * to every registered account, through /api/referral/admin-promo-email (the
 * server holds the Supabase and Resend keys). The first click shows the email
 * and how many accounts get it; only "Send to N accounts" sends it.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

interface Preview {
  recipients: number
  subject: string
  text: string
}

interface Answer {
  recipients?: number
  sent?: number
  errors?: string[]
  error?: string
}

async function call(password: string, body?: unknown): Promise<{ status: number; data: (Preview & Answer) | null }> {
  const response = await fetch('/api/referral/admin-promo-email', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${password}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  }).catch(() => null)
  return { status: response?.status ?? 0, data: response ? ((await response.json().catch(() => null)) as (Preview & Answer) | null) : null }
}

function say(text: string, ok?: boolean) {
  const result = $('pe-result')
  result.textContent = text
  result.className = ok === undefined ? '' : ok ? 'ok' : 'bad'
  result.hidden = false
}

export function initPromoEmail(password: () => string) {
  const open = $<HTMLButtonElement>('pe-open')
  const send = $<HTMLButtonElement>('pe-send')
  const cancel = $<HTMLButtonElement>('pe-cancel')
  const preview = $('pe-preview')
  let count = 0

  const close = () => {
    preview.hidden = true
    open.hidden = false
  }

  open.addEventListener('click', async () => {
    open.disabled = true
    const { status, data } = await call(password())
    open.disabled = false
    if (status !== 200 || !data) {
      say(data?.error === 'no-promo' ? 'No Free Ad-Free Week is set, or it has ended.' : 'Couldn’t load the email. Try again.', false)
      return
    }
    count = data.recipients
    $('pe-subject').textContent = data.subject
    $('pe-text').textContent = data.text
    send.textContent = `Send to ${count.toLocaleString()} account${count === 1 ? '' : 's'}`
    $('pe-result').hidden = true
    preview.hidden = false
    open.hidden = true
  })

  cancel.addEventListener('click', close)

  send.addEventListener('click', async () => {
    send.disabled = true
    cancel.disabled = true
    say('Sending…')
    const { status, data } = await call(password(), { confirm: count })
    send.disabled = false
    cancel.disabled = false
    if (data?.error === 'count-changed') {
      count = data.recipients ?? 0
      send.textContent = `Send to ${count.toLocaleString()} account${count === 1 ? '' : 's'}`
      say(`The number of accounts changed (a new sign-up): it's ${count.toLocaleString()} now. Check and send again.`, false)
      return
    }
    if (status === 200 && data) {
      close()
      say(`✅ Sent to ${data.sent?.toLocaleString()} account${data.sent === 1 ? '' : 's'}.`, true)
      return
    }
    say(
      data?.sent !== undefined
        ? `Sent ${data.sent.toLocaleString()} of ${data.recipients?.toLocaleString()}. Resend said: ${(data.errors ?? []).join('; ')}. Sending again only sends the batches that didn’t go.`
        : (data?.error ?? 'Couldn’t send. Try again.'),
      false,
    )
  })
}
