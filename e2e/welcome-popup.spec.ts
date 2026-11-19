import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'

/**
 * The welcome popup for signed-out visitors (src/promo/welcomeStore.ts), with
 * the real Monetag Multitag on the page once it may load: no ad of any kind
 * while it's open, nor on any tap that closes it or leaves it, and ads as
 * usual 3 seconds after it's closed.
 *
 * Our /api/referral/status is faked (the promo's times), as is Supabase for
 * the signed-in check. The direct-link ad answers with a blank page.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()
const SCREENSHOTS = process.env.E2E_SCREENSHOTS

type When = 'promo' | 'after'

function statusBody(when: When, signedIn = false) {
  const now = Date.now()
  const promo =
    when === 'promo'
      ? { start: iso(now - 5 * DAY), end: iso(now + DAY), state: 'active' }
      : { start: iso(now - 8 * DAY), end: iso(now - HOUR), state: 'ended' }
  const trial = { start: when === 'promo' ? iso(now + DAY) : iso(now - HOUR), live: when === 'after' }
  const base = { goal: 5, promo, trial, serverNow: now }
  return signedIn
    ? { ...base, signedIn: true, userId: '00000000-0000-4000-8000-00000000e2e0', adFree: true, adFreeUntil: promo.end, permanent: false, ownAdFree: false, promoAdFree: true, premium: false, trialUntil: null, trialOnly: false }
    : { ...base, signedIn: false, adFree: false, premium: false }
}

async function fakeApis(context: BrowserContext, when: When) {
  await context.route('**/api/referral/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(statusBody(when, Boolean(route.request().headers().authorization))) }),
  )
  await context.route(/uplcm\.com/, (route) => route.fulfill({ contentType: 'text/html', body: '<title>ad</title>' }))
  const user = { id: '00000000-0000-4000-8000-00000000e2e0', aud: 'authenticated', role: 'authenticated', email: 'e2e@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { password_set: true }, app_metadata: { provider: 'email' }, identities: [], created_at: '2026-01-01T00:00:00Z' }
  await context.route(/\.supabase\.co\//, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/auth/v1/user')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(user) })
    if (url.pathname.includes('/rest/v1/')) return route.fulfill({ contentType: 'application/json', body: '[]' })
    return route.fulfill({ contentType: 'application/json', body: '{}' })
  })
  return user
}

function watchTabs(context: BrowserContext) {
  const opened: { url: string; at: number }[] = []
  context.on('page', (page) => opened.push({ url: page.url(), at: Date.now() }))
  return { since: (at: number) => opened.filter((tab) => tab.at >= at) }
}

/** No ad script, ad frame or anything drawn over the page by a third party. */
async function adsOnPage(page: Page) {
  return page.evaluate(() => {
    const own = location.origin
    const zones = document.querySelectorAll('script[data-zone]').length
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe')].map((f) => f.src || 'about:blank').filter((src) => !src.startsWith(own))
    const scripts = [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((s) => s.src).filter((src) => !src.startsWith(own) && !/vercel/.test(src))
    // The loading splash (index.html) is ours, not an overlay.
    const overlays = [...document.body.children].filter((node) => node.id !== 'root' && node.id !== 'nt-splash' && node.tagName !== 'SCRIPT' && (node as HTMLElement).offsetHeight > 0).map((node) => node.outerHTML.slice(0, 120))
    return { zones, frames, scripts, overlays }
  })
}

async function expectNoAds(page: Page, where: string) {
  expect(await adsOnPage(page), where).toEqual({ zones: 0, frames: [], scripts: [], overlays: [] })
}

const press = async (locator: Locator, mobile: boolean) => (mobile ? locator.tap() : locator.click())
const dialog = (page: Page) => page.getByRole('dialog', { name: /NAIJA TR is ad-free this week|Tired of ads/ })

test.describe('the welcome popup', () => {
  test('shows on load and on reload, ~1.5 s in, with the promo wording; nothing for signed-in accounts', async ({ page, context }, testInfo) => {
    await fakeApis(context, 'promo')
    await page.goto('/')
    await expect(dialog(page)).toBeVisible()
    // By the page's own clock (from the start of the page load).
    expect(await page.evaluate(() => performance.now()), 'not before ~1.5 s').toBeGreaterThan(1500)
    await expect(page.getByRole('heading', { name: '🎉 NAIJA TR is ad-free this week!' })).toBeVisible()
    await expect(page.getByText('Sign up free now and stay 👑 Premium (ad-free) for 2 extra days after the promo ends. Plus Continue Watching and My List on all your devices.')).toBeVisible()
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/welcome-${testInfo.project.name}-promo.png` })
    await page.reload()
    await expect(dialog(page)).toBeVisible()
    // Not on the excluded pages.
    for (const path of ['/privacy', '/invite/rules', '/login', '/signup']) {
      await page.goto(path)
      await page.waitForTimeout(2500)
      await expect(dialog(page), path).toHaveCount(0)
    }
  })

  test('after PROMO_END: "Tired of ads?"', async ({ page, context }, testInfo) => {
    await fakeApis(context, 'after')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '😩 Tired of ads?' })).toBeVisible()
    await expect(page.getByText('Sign up free and enjoy 👑 NAIJA TR Premium, ad-free, for 2 days. Plus Continue Watching and My List on all your devices.')).toBeVisible()
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/welcome-${testInfo.project.name}-after.png` })
  })

  test('never for a signed-in account', async ({ page, context }) => {
    const user = await fakeApis(context, 'promo')
    const exp = Math.floor(Date.now() / 1000) + 3600
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, exp, role: 'authenticated', aud: 'authenticated' })}.e2e`
    const session = { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user }
    await context.addInitScript((value) => localStorage.setItem('naijatr.auth', value), JSON.stringify(session))
    await page.goto('/')
    await expect(page.getByRole('button', { name: /^Account: / })).toBeVisible()
    await page.waitForTimeout(3500)
    await expect(dialog(page)).toHaveCount(0)
  })

  test('TV mode: shows and looks right', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'TV is a large screen')
    await page.setViewportSize({ width: 1920, height: 1080 })
    await fakeApis(context, 'promo')
    await page.goto('/?tv=1')
    await expect(dialog(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign up free' })).toBeFocused()
    const box = await page.locator('.welcome__card').boundingBox()
    expect(box!.width).toBeLessThan(1920 * 0.5)
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/welcome-tv.png` })
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await page.evaluate(() => localStorage.removeItem('naijatr:tv'))
  })

  const closeWays: { name: string; run: (page: Page, mobile: boolean) => Promise<void> }[] = [
    { name: '✕', run: (page, mobile) => press(dialog(page).getByRole('button', { name: 'Close' }), mobile) },
    { name: 'Not now', run: (page, mobile) => press(dialog(page).getByRole('button', { name: 'Not now' }), mobile) },
    {
      name: 'a tap outside',
      run: async (page, mobile) => {
        const size = page.viewportSize()!
        if (mobile) await page.touchscreen.tap(size.width / 2, size.height - 12)
        else await page.mouse.click(size.width / 2, size.height - 12)
      },
    },
    { name: 'Esc', run: (page) => page.keyboard.press('Escape') },
  ]

  for (const way of closeWays) {
    test(`closed with ${way.name}: no ad on that tap or while open; ads as usual 3 s later`, async ({ page, context }, testInfo) => {
      const mobile = testInfo.project.name === 'mobile'
      await fakeApis(context, 'promo')
      const tabs = watchTabs(context)
      await page.goto('/')
      await expect(dialog(page)).toBeVisible()
      // Open for a while: nothing loads behind it.
      await page.waitForTimeout(2000)
      await expectNoAds(page, 'popup open')
      const closedAt = Date.now()
      await way.run(page, mobile)
      await expect(dialog(page)).toHaveCount(0)
      // The page scrolls again.
      await page.mouse.wheel(0, 600)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
      await page.waitForTimeout(1500)
      await expectNoAds(page, 'just after closing')
      expect(tabs.since(closedAt), 'tabs opened by the closing tap').toEqual([])
      // Ads as usual, from 3 seconds after: the Multitag loads, and a card opens the direct-link ad.
      await expect(page.locator('script[data-zone="302667"]')).toHaveCount(1, { timeout: 15_000 })
      expect(Date.now() - closedAt, 'not before 3 s').toBeGreaterThanOrEqual(3000)
      await page.evaluate(() => window.scrollTo(0, 0))
      const beforeCard = Date.now()
      await press(page.locator('.poster-card__button').first(), mobile)
      await expect.poll(() => tabs.since(beforeCard).length, { message: 'the card’s ad tab', timeout: 10_000 }).toBeGreaterThan(0)
    })
  }

  for (const [label, path] of [
    ['Sign up free', 'signup'],
    ['I already have an account, Log in', 'login'],
  ] as const) {
    test(`"${label}": a full page load to /${path}?next=, no tab, no ad`, async ({ page, context }, testInfo) => {
      const mobile = testInfo.project.name === 'mobile'
      await fakeApis(context, 'promo')
      const tabs = watchTabs(context)
      await page.goto('/my-list')
      await expect(dialog(page)).toBeVisible()
      await page.evaluate(() => ((window as unknown as { __before: boolean }).__before = true))
      const tapped = Date.now()
      await press(dialog(page).getByRole('button', { name: label }), mobile)
      await page.waitForURL(new RegExp(`/${path}\\?next=%2Fmy-list$`))
      expect(await page.evaluate(() => (window as unknown as { __before?: boolean }).__before ?? false), 'a full page load').toBe(false)
      await page.waitForTimeout(3500)
      expect(tabs.since(tapped), 'tabs opened').toEqual([])
      await expectNoAds(page, `/${path}`)
    })
  }
})
