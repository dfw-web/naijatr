import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test'

/**
 * "Your short dramas" (src/dramas/history.ts): opening a short drama saves it,
 * the "I'm on episode __" picker saves the episode, and the home page shows
 * the row with "Continue on DramaBox" and a ✕. Signed out it's this browser's
 * own; signed in it follows the account to another "phone" (a second browser
 * context with its own storage).
 *
 * The short-drama API and Supabase are faked; the Supabase fake keeps the
 * drama_history table's rows in this test, like PostgREST. The Multitag is
 * the real one: no tab may open from the picker's taps or a card's ✕.
 */

const DRAMA_ID = '42000023802'
const TITLE = 'He Broke the Heart That Saved Him'
const USER_ID = '00000000-0000-4000-8000-00000000e2e0'
const SUPABASE_KEY = 'naijatr.auth'

const press = async (locator: Locator, mobile: boolean) => (mobile ? locator.tap() : locator.click())
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const details = {
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
const account = () => ({ rows: new Map<string, Row>() })

async function fakeApis(context: BrowserContext, store: ReturnType<typeof account> | null) {
  await context.route('**/api/dramas/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/drama')) return json(route, details)
    if (url.pathname.endsWith('/home')) return json(route, { shelves: [{ title: 'Trending', dramas: [details.drama] }] })
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

function watchTabs(context: BrowserContext) {
  const opened: number[] = []
  context.on('page', () => opened.push(Date.now()))
  return { since: (at: number) => opened.filter((time) => time >= at).length }
}

/** Closes the welcome popup (signed out), if it's up: the first tap, after which the Multitag loads. */
async function closeWelcome(page: Page, mobile: boolean) {
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
  if (await dialog.isVisible()) await press(dialog.getByRole('button', { name: 'Not now' }), mobile)
  else await press(page.locator('h1').first(), mobile)
}

async function newPhone(browser: Browser, mobile: boolean, baseURL: string | undefined, store: ReturnType<typeof account> | null) {
  const context = await browser.newContext({ ...devices[mobile ? 'Pixel 7' : 'Desktop Chrome'], baseURL, serviceWorkers: 'block' })
  await fakeApis(context, store)
  const page = await context.newPage()
  return { context, page }
}

test('signed out: the drama, its episode, the home row, and no ads on the picker or ✕', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await fakeApis(context, null)
  const tabs = watchTabs(context)

  await page.goto(`/dramas/dramabox/${DRAMA_ID}`)
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  await closeWelcome(page, mobile)
  // The Multitag loads 3 seconds after the first tap, then arms itself.
  await expect.poll(() => page.locator('script[data-zone]').count(), { message: 'the Multitag', timeout: 15_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(4000)

  const input = page.getByRole('spinbutton', { name: 'I’m on episode' })
  const plus = page.getByRole('button', { name: 'Next episode' })
  const minus = page.getByRole('button', { name: 'Previous episode' })
  const tapped = Date.now()
  await press(plus, mobile)
  await press(plus, mobile)
  await press(plus, mobile)
  await press(minus, mobile)
  await expect(input).toHaveValue('2')
  await press(input, mobile)
  await input.fill('12')
  await expect(page.getByText('of 52')).toBeVisible()
  await page.waitForTimeout(2500)
  expect(tabs.since(tapped), 'tabs opened by the episode picker').toBe(0)

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('naijatr:dramaHistory') ?? '[]'))
  expect(saved).toEqual([expect.objectContaining({ id: `dramabox:${DRAMA_ID}`, title: TITLE, episode: 12, episodeCount: 52, provider: 'dramabox' })])

  // ---- The home page: the row, with the episode and the app's own link. ----
  await page.goto('/')
  const row = page.getByRole('region', { name: 'Your short dramas' })
  await expect(row).toBeVisible()
  await expect(row.getByText('Episode 12 of 52')).toBeVisible()
  await expect(row.getByRole('link', { name: 'Continue on DramaBox' })).toHaveAttribute('href', `https://www.dramaboxdb.com/movie/${DRAMA_ID}`)
  await closeWelcome(page, mobile)
  await expect.poll(() => page.locator('script[data-zone]').count(), { message: 'the Multitag', timeout: 15_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(4000)
  await page.getByRole('region', { name: 'Your short dramas' }).scrollIntoViewIfNeeded()

  const removing = Date.now()
  await press(row.getByRole('button', { name: `Remove ${TITLE} from Your short dramas` }), mobile)
  await expect(row).toHaveCount(0)
  await page.waitForTimeout(2500)
  expect(tabs.since(removing), 'tabs opened by the ✕').toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('naijatr:dramaHistory'))).toBe('[]')
})

test('signed in: the drama and its episode follow the account to another phone, and so does removing it', async ({ browser, baseURL }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const store = account()

  // ---- Phone A opens the drama and says it's on episode 7. ----
  const a = await newPhone(browser, mobile, baseURL, store)
  await a.page.goto(`/dramas/dramabox/${DRAMA_ID}`)
  await expect(a.page.getByRole('heading', { name: TITLE })).toBeVisible()
  await a.page.getByRole('spinbutton', { name: 'I’m on episode' }).fill('7')
  await expect.poll(() => store.rows.get(`dramabox:${DRAMA_ID}`)?.episode, { message: 'episode 7 on the account', timeout: 20_000 }).toBe(7)
  expect(store.rows.get(`dramabox:${DRAMA_ID}`)).toMatchObject({ user_id: USER_ID, provider: 'dramabox', drama_id: DRAMA_ID, title: TITLE, episode_count: 52 })

  // ---- Phone B (its own storage) shows it on the home page. ----
  const b = await newPhone(browser, mobile, baseURL, store)
  await b.page.goto('/')
  const row = b.page.getByRole('region', { name: 'Your short dramas' })
  await expect(row.getByText('Episode 7 of 52')).toBeVisible({ timeout: 20_000 })
  await expect(row.getByRole('heading', { name: TITLE })).toBeVisible()

  // Phone B moves on to episode 9 on the drama's page.
  await b.page.goto(`/dramas/dramabox/${DRAMA_ID}`)
  await expect(b.page.getByRole('spinbutton', { name: 'I’m on episode' })).toHaveValue('7')
  await press(b.page.getByRole('button', { name: 'Next episode' }), mobile)
  await press(b.page.getByRole('button', { name: 'Next episode' }), mobile)
  await expect.poll(() => store.rows.get(`dramabox:${DRAMA_ID}`)?.episode, { timeout: 20_000 }).toBe(9)

  // ---- Back on phone A: episode 9; then the ✕ removes it everywhere. ----
  await a.page.goto('/')
  const rowA = a.page.getByRole('region', { name: 'Your short dramas' })
  await expect(rowA.getByText('Episode 9 of 52')).toBeVisible({ timeout: 20_000 })
  await press(rowA.getByRole('button', { name: `Remove ${TITLE} from Your short dramas` }), mobile)
  await expect(rowA).toHaveCount(0)
  await expect.poll(() => store.rows.size, { message: 'removed from the account', timeout: 20_000 }).toBe(0)

  await b.page.goto('/')
  await b.page.waitForTimeout(3000)
  await expect(b.page.getByRole('region', { name: 'Your short dramas' })).toHaveCount(0)

  await a.context.close()
  await b.context.close()
})
