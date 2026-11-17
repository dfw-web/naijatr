import { devices, type Browser, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test'

/**
 * Fakes shared by the Short Dramas browser tests (drama-history.spec.ts,
 * drama-resume.spec.ts): the short-drama API (every episode plays the site's
 * own short video), our referral status, the direct-link ad (a blank page),
 * and Supabase, whose fake keeps the drama_history table's rows in the test,
 * like PostgREST, for "phones" signed in to the same account.
 */

export const DRAMA_ID = '42000023802'
export const TITLE = 'He Broke the Heart That Saved Him'
export const USER_ID = '00000000-0000-4000-8000-00000000e2e0'
const SUPABASE_KEY = 'naijatr.auth'

export const press = async (locator: Locator, mobile: boolean) => (mobile ? locator.tap() : locator.click())
export const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

export const details = {
  drama: {
    provider: 'dramabox',
    id: DRAMA_ID,
    title: TITLE,
    cover: 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
    description: 'A short drama.',
    tags: ['Revenge'],
    episodes: 52,
    popularity: null,
  },
  title: TITLE,
  episodes: Array.from({ length: 52 }, (_, i) => ({ id: `ep${i + 1}`, number: i + 1, title: '', locked: i >= 10, playable: i < 10 })),
}

type Row = Record<string, unknown> & { entry_id: string }

/** One account's drama_history rows, shared by every "phone" in a test. */
export const account = () => ({ rows: new Map<string, Row>() })

export async function fakeApis(context: BrowserContext, store: ReturnType<typeof account> | null) {
  await context.route('**/api/dramas/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/drama')) return json(route, details)
    if (url.pathname.endsWith('/home')) return json(route, { shelves: [{ title: 'Trending', dramas: [details.drama] }] })
    // Every episode plays the site's own short video (the test only needs something to play).
    if (url.pathname.endsWith('/play')) return json(route, { sources: [{ url: '/videos/how-to-download.mp4', type: 'mp4', quality: '720p' }] })
    return json(route, { error: 'no-source' }, 404)
  })
  await context.route('**/api/referral/status', (route) =>
    json(route, { goal: 5, signedIn: Boolean(store), adFree: false, premium: false, promo: null, trial: null, serverNow: Date.now() }),
  )
  // The direct-link ad: a blank page instead of the real one (the tab opening is what's checked).
  await context.route(/uplcm\.com/, (route) => route.fulfill({ contentType: 'text/html', body: '<title>ad</title>' }))
  const user = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'e2e@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { password_set: true }, app_metadata: { provider: 'email' }, identities: [], created_at: '2026-01-01T00:00:00Z' }
  await context.route(/\.supabase\.co\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith('/auth/v1/user')) return json(route, user)
    if (url.pathname.endsWith('/rest/v1/drama_history') && store) {
      if (request.method() === 'GET') return json(route, [...store.rows.values()])
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Row | Row[]
        for (const row of Array.isArray(body) ? body : [body]) store.rows.set(row.entry_id, row)
        return json(route, [], 201)
      }
      if (request.method() === 'DELETE') {
        const ids = /^in\.\((.*)\)$/.exec(url.searchParams.get('entry_id') ?? '')?.[1].split(',').map((id) => id.replace(/^"|"$/g, '')) ?? []
        ids.forEach((id) => store.rows.delete(id))
        return route.fulfill({ status: 204 })
      }
    }
    if (url.pathname.includes('/rest/v1/')) return request.method() === 'GET' ? json(route, []) : json(route, [], 201)
    return json(route, {})
  })
  if (store) {
    // Signed in on this "phone": a stored session, as supabase-js keeps it.
    const exp = Math.floor(Date.now() / 1000) + 3600
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, exp, role: 'authenticated', aud: 'authenticated' })}.e2e`
    const session = { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'e2e-refresh', user }
    await context.addInitScript(
      ([key, value]) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value)
      },
      [SUPABASE_KEY, JSON.stringify(session)] as const,
    )
  }
}

export function watchTabs(context: BrowserContext) {
  const opened: number[] = []
  context.on('page', () => opened.push(Date.now()))
  return { since: (at: number) => opened.filter((time) => time >= at).length }
}

/** Closes the welcome popup (signed out), if it's up: the first tap, after which the Multitag loads. */
export async function closeWelcome(page: Page, mobile: boolean) {
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
  if (await dialog.isVisible()) await press(dialog.getByRole('button', { name: 'Not now' }), mobile)
  else await press(page.locator('h1').first(), mobile)
}

export async function newPhone(browser: Browser, mobile: boolean, baseURL: string | undefined, store: ReturnType<typeof account> | null) {
  const context = await browser.newContext({ ...devices[mobile ? 'Pixel 7' : 'Desktop Chrome'], baseURL, serviceWorkers: 'block' })
  await fakeApis(context, store)
  const page = await context.newPage()
  return { context, page }
}

/** The drama player's video: where it is, once it has loaded (-1 before). */
export const videoTime = (page: Page) =>
  page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('.dr-player__video')
    return video && video.readyState >= 1 ? video.currentTime : -1
  })
