/**
 * /admin/live's "Short Dramas" switch: whether /dramas plays the episodes that
 * are paid in the drama apps (/api/dramas/admin-settings, stored in Redis,
 * checked by the server on every /api/dramas/play). Off by default.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

let getPassword: () => string = () => ''
let showLocked: boolean | null = null

function render(error?: string) {
  const state = $('dr-state')
  const toggle = $<HTMLButtonElement>('dr-toggle')
  const problem = $('dr-error')
  state.textContent = showLocked === null ? '–' : showLocked ? 'On' : 'Off'
  state.style.color = showLocked ? '#f5c518' : ''
  toggle.disabled = showLocked === null
  toggle.textContent = showLocked ? 'Turn off: free episodes only' : 'Turn on: play paid episodes'
  problem.hidden = !error
  problem.textContent = error ?? ''
}

const MESSAGES: Record<string, string> = {
  'no-store': 'Couldn’t save it: Redis (KV_REST_API_*) isn’t reachable.',
  'not-configured': 'ADMIN_PASSWORD isn’t set.',
  unauthorized: 'Wrong password: sign out and in again.',
}

async function call(method: 'GET' | 'POST', body?: unknown) {
  const response = await fetch('/api/dramas/admin-settings', {
    method,
    headers: { Authorization: `Bearer ${getPassword()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const data = (await response.json().catch(() => ({}))) as { showLocked?: boolean; configured?: boolean; error?: string }
  if (!response.ok || typeof data.showLocked !== 'boolean') throw new Error(MESSAGES[data.error ?? ''] ?? 'Couldn’t reach /api/dramas.')
  showLocked = data.showLocked
  render(data.configured === false ? 'EZVID_API_KEY isn’t set, so /dramas shows nothing yet.' : undefined)
}

export async function loadDramasSwitch() {
  try {
    await call('GET')
  } catch (error) {
    render((error as Error).message)
  }
}

export function initDramasSwitch(password: () => string) {
  getPassword = password
  $('dr-toggle').addEventListener('click', () => {
    if (showLocked === null) return
    const next = !showLocked
    if (next && !window.confirm('Play every episode, including the ones that are paid in the drama apps? Only do this for dramas you have the rights to show.')) return
    $<HTMLButtonElement>('dr-toggle').disabled = true
    call('POST', { showLocked: next }).catch((error: Error) => render(error.message))
  })
}
