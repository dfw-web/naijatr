import { expect, test, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test'

/**
 * No ads anywhere near signing up, logging in or passwords, with the real
 * Monetag Multitag running on the home page.
 *
 * Supabase is faked here (no real emails, no real accounts). The direct-link
 * ad's address answers with a blank page so the test makes no real ad clicks;
 * the Multitag itself (quge5.com) is the real one.
 */

const EMAIL = 'e2e.tester@example.com'
const RIGHT = 'Right-Password-2026'
const NEW_PASSWORD = 'Brand-New-Pass-2026'

/** Hosts an auth page may talk to: this site, Supabase (faked), fonts, Vercel Analytics. */
const ALLOWED = [/\.supabase\.co$/, /^fonts\.(googleapis|gstatic)\.com$/, /^va\.vercel-scripts\.com$/, /^vitals\.vercel-insights\.com$/]

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function fakeUser(passwordSet: boolean) {
  return {
    id: '00000000-0000-4000-8000-00000000e2e0',
    aud: 'authenticated',
    role: 'authenticated',
    email: EMAIL,
    email_confirmed_at: '2026-01-01T00:00:00Z',
    user_metadata: { password_set: passwordSet },
    app_metadata: { provider: 'email' },
    identities: [{ id: 'i1', provider: 'email' }],
    created_at: '2026-01-01T00:00:00Z',
  }
}

function session(passwordSet = true) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const accessToken = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: fakeUser(passwordSet).id, email: EMAIL, exp, role: 'authenticated', aud: 'authenticated' })}.e2e`
  return { access_token: accessToken, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'e2e-refresh', user: fakeUser(passwordSet) }
}

/** A stand-in for Supabase and our own /api/account endpoints. */
async function fakeBackend(context: BrowserContext) {
  await context.route(/\.supabase\.co\//, async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname.endsWith('/auth/v1/token')) {
      const body = request.postDataJSON() as { password?: string } | null
      if (url.searchParams.get('grant_type') === 'password' && body?.password !== RIGHT) {
        return json({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400)
      }
      return json(session())
    }
    if (url.pathname.endsWith('/auth/v1/user')) return json(fakeUser(true))
    if (url.pathname.endsWith('/auth/v1/otp') || url.pathname.endsWith('/auth/v1/recover')) return json({})
    if (url.pathname.endsWith('/auth/v1/logout')) return route.fulfill({ status: 204 })
    if (url.pathname.includes('/rest/v1/')) return request.method() === 'GET' ? json([]) : json([], 201)
    return json({})
  })
  // Signed out: the promo's times (vite preview has no API).
  await context.route('**/api/referral/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ goal: 5, signedIn: false, adFree: false, premium: false, promo: null, trial: null, serverNow: Date.now() }) }),
  )
  await context.route('**/api/account/email-status', (route) => route.fulfill({ contentType: 'application/json', body: '{"status":"new"}' }))
  // The direct-link ad: a blank page instead of the real one (the tab opening is what's checked).
  await context.route(/uplcm\.com/, (route) => route.fulfill({ contentType: 'text/html', body: '<title>ad</title>' }))
}

/** Every tab that opens (ads open new tabs), with when it opened. */
function watchTabs(context: BrowserContext) {
  const opened: { url: string; at: number }[] = []
  context.on('page', (page) => opened.push({ url: page.url(), at: Date.now() }))
  return { since: (at: number) => opened.filter((tab) => tab.at >= at), all: opened }
}

/** Requests the current document makes to other sites (reset on each page load). */
function watchRequests(page: Page) {
  let foreign: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) foreign = []
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === new URL(page.url()).origin || url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!ALLOWED.some((host) => host.test(url.hostname))) foreign.push(request.url())
  })
  return { foreign: () => foreign }
}

const press = async (locator: Locator, mobile: boolean) => (mobile ? locator.tap() : locator.click())

/** No ad script, ad frame, banner or third-party request on this auth page. */
async function expectNoAds(page: Page, requests: ReturnType<typeof watchRequests>, where: string) {
  const found = await page.evaluate(() => {
    const own = location.origin
    const foreign = [...document.querySelectorAll<HTMLScriptElement | HTMLIFrameElement>('script[src], iframe')]
      .map((node) => node.src)
      .filter((src) => src && !src.startsWith(own) && !/\.supabase\.co|fonts\.g|vercel/.test(src))
    const zones = document.querySelectorAll('script[data-zone]').length
    // Anything drawn on top of the page that isn't the app (in-page push banners, overlays).
    // The loading splash (index.html) is ours, not an overlay.
    const overlays = [...document.body.children].filter((node) => node.id !== 'root' && node.id !== 'nt-splash' && node.tagName !== 'SCRIPT' && (node as HTMLElement).offsetHeight > 0).map((node) => node.outerHTML.slice(0, 120))
    return { foreign, zones, overlays, text: document.body.innerText }
  })
  expect(found.zones, `${where}: Multitag on the page`).toBe(0)
  expect(found.foreign, `${where}: third-party scripts/frames`).toEqual([])
  expect(found.overlays, `${where}: something on top of the page`).toEqual([])
  expect(found.text, `${where}: ad text`).not.toMatch(/Free Download|\bAd:|WPS Office/i)
  expect(requests.foreign(), `${where}: requests to other sites`).toEqual([])
}

test('no ads on any auth page, nor on the taps that open them', async ({ page, context, baseURL }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await fakeBackend(context)
  const tabs = watchTabs(context)
  const requests = watchRequests(page)
  const csp: Record<string, string | null> = {}
  page.on('response', (response) => {
    if (response.request().resourceType() === 'document') csp[new URL(response.url()).pathname] = response.headers()['content-security-policy'] ?? null
  })

  // ---- The home page, ads on: nothing before the first tap, then the Multitag, and a card's ad. ----
  await page.goto('/')
  const signIn = page.getByRole('button', { name: 'Sign in to sync' })
  await expect(signIn).toBeVisible()
  // The welcome popup for signed-out visitors (welcome-popup.spec.ts has its own checks).
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await page.locator('script[data-zone]').count(), 'Multitag before any tap').toBe(0)
  // Closing it is the first tap: the Multitag loads (3 seconds later).
  await press(page.getByRole('dialog').getByRole('button', { name: 'Not now' }), mobile)
  await expect(page.locator('script[data-zone="302667"]')).toHaveCount(1, { timeout: 15_000 })
  // A card: the direct-link ad opens in a new tab (proof the ads are live here).
  const beforeCard = Date.now()
  await press(page.locator('.poster-card__button').first(), mobile)
  await expect.poll(() => tabs.since(beforeCard).length, { message: 'the card’s ad tab', timeout: 10_000 }).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  for (const other of context.pages()) if (other !== page) await other.close()
  await page.bringToFront()
  // Give the Multitag time to arm itself (pop-under, in-page push).
  await page.waitForTimeout(4000)
  await page.evaluate(() => ((window as unknown as { __before: boolean }).__before = true))

  // ---- Tap "Sign in to sync": no tab opens, and /signup is a fresh page load. ----
  const tapped = Date.now()
  await press(signIn, mobile)
  await page.waitForURL(/\/signup(\?|$)/)
  expect(await page.evaluate(() => (window as unknown as { __before?: boolean }).__before ?? false), 'a full page load').toBe(false)
  await page.waitForTimeout(2500)
  expect(tabs.since(tapped), 'tabs opened by the Sign in tap or on /signup').toEqual([])
  expect(csp['/signup'], 'CSP on /signup').toMatch(/script-src 'self' 'unsafe-inline' https:\/\/va\.vercel-scripts\.com/)
  await expectNoAds(page, requests, '/signup')

  // ---- Create account: type the email, Create free account. ----
  const email = page.getByLabel('Email')
  await press(email, mobile)
  await email.pressSequentially(EMAIL)
  await press(page.getByRole('button', { name: 'Create free account' }), mobile)
  await expect(page.getByRole('heading', { name: 'Check your email to confirm your address' })).toBeVisible()
  // The "check your spam" note, the 60-second Resend and "Wrong email? Change it" (EmailSentNote.tsx).
  await expect(page.getByText(`Email sent to ${EMAIL}. Can’t find it? Check your Spam or Promotions folder`, { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Resend in \d+s$/ })).toBeDisabled()
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/email-sent-${testInfo.project.name}.png`, fullPage: true })
  await expectNoAds(page, requests, '/signup after Create account')
  const changing = Date.now()
  await press(page.getByRole('button', { name: 'Change it' }), mobile)
  await expect(page.getByLabel('Email')).toHaveValue(EMAIL)
  expect(tabs.since(changing), 'tabs opened by Change it').toEqual([])

  // ---- Log in: wrong password, show password, Forgot password, then the right one. ----
  await press(page.getByRole('tab', { name: 'Log in' }), mobile)
  await expect(page).toHaveURL(/\/login(\?|$)/)
  await expect(page.getByLabel('Email')).toHaveValue(EMAIL)
  const password = page.getByLabel('Password', { exact: true })
  await press(password, mobile)
  await password.pressSequentially('wrong-password')
  await press(page.getByRole('button', { name: 'Show password' }), mobile)
  await press(page.getByRole('button', { name: 'Log in', exact: true }).last(), mobile)
  await expect(page.getByText('Wrong email or password.')).toBeVisible()
  await expectNoAds(page, requests, '/login (wrong password)')

  await press(page.getByRole('button', { name: 'Forgot password?' }), mobile)
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveValue(EMAIL)
  // The confirmation email above started the 60-second wait.
  await expect(page.getByRole('button', { name: /Send reset link/ })).toBeVisible()
  await expectNoAds(page, requests, 'Forgot password')
  await press(page.getByRole('button', { name: 'Back to Log in' }), mobile)

  await press(page.getByLabel('Password', { exact: true }), mobile)
  await page.getByLabel('Password', { exact: true }).fill('')
  await page.getByLabel('Password', { exact: true }).pressSequentially(RIGHT)
  await press(page.getByRole('button', { name: 'Log in', exact: true }).last(), mobile)
  await expect(page.getByText('You’re signed in')).toBeVisible()
  // Back to where they came from (the home page), with a full page load.
  await page.waitForURL((url) => url.pathname === '/')
  expect(tabs.since(tapped), 'tabs opened while signing up or logging in').toEqual([])

  // ---- Signed in: the avatar opens /account, Change password opens /auth/set-password. ----
  const avatar = page.getByRole('button', { name: /^Account: / })
  await expect(avatar).toBeVisible()
  await page.waitForTimeout(3000)
  const toAccount = Date.now()
  await press(avatar, mobile)
  await page.waitForURL(/\/account$/)
  await page.waitForTimeout(2000)
  expect(tabs.since(toAccount), 'tabs opened by the avatar tap or on /account').toEqual([])
  expect(csp['/account'], 'CSP on /account').toMatch(/default-src 'self'/)
  await expectNoAds(page, requests, '/account')

  await press(page.getByRole('button', { name: 'Change password' }), mobile)
  await page.waitForURL(/\/auth\/set-password\?next=%2Faccount$/)
  expect(csp['/auth/set-password'], 'CSP on /auth/set-password').toMatch(/frame-src 'none'/)
  await expectNoAds(page, requests, '/auth/set-password')
  const first = page.getByLabel('New password')
  await press(first, mobile)
  await first.pressSequentially(NEW_PASSWORD)
  await page.getByLabel('Confirm password').pressSequentially(NEW_PASSWORD)
  await press(page.getByRole('button', { name: 'Save password' }), mobile)
  await expect(page.getByRole('heading', { name: 'Password saved ✅' })).toBeVisible()
  await expectNoAds(page, requests, '/auth/set-password (saved)')
  await page.waitForURL(/\/account$/)

  // ---- The email-link pages, opened directly. ----
  for (const path of ['/auth/confirm', '/auth/reset', '/auth/set-password', '/login', '/signup']) {
    // Signed in, /login and /signup go straight back: check them signed out.
    if (path === '/login') await page.evaluate(() => localStorage.removeItem('naijatr.auth'))
    await page.goto(path)
    await page.waitForTimeout(1500)
    expect(csp[path], `CSP on ${path}`).toMatch(/default-src 'self'/)
    await expectNoAds(page, requests, path)
  }
  expect(tabs.since(toAccount), 'tabs opened on any auth page').toEqual([])
  void baseURL
})
