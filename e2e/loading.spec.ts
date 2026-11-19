import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * The NAIJA TR loading animations: the splash on a page load or reload
 * (inline in index.html, gone once the app is ready: at least 600 ms, at most
 * 4 s), and the slim red bar plus the bouncing corner logo when moving between
 * pages inside the app (src/components/NavProgress.tsx). Also slow 3G, reduced
 * motion, a phone in landscape and TV mode.
 */

const SCREENSHOTS = process.env.E2E_SCREENSHOTS

async function fakeApis(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('naijatr.gate.joined', '1')
    localStorage.setItem('naijatr.gate.tv', '1')
  })
  await context.route('**/api/referral/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ goal: 5, signedIn: false, adFree: false, premium: false, promo: null, trial: null, serverNow: Date.now() }) }),
  )
  await context.route('**/api/live/**', (route) => route.fulfill({ contentType: 'application/json', body: '{}' }))
}

/** When the splash started leaving and when it was removed, from the page's own clock. */
const watchSplash = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { splashTimes: { leaving?: number; removed?: number } }
    w.splashTimes = {}
    new MutationObserver(() => {
      const splash = document.getElementById('nt-splash')
      if (splash?.classList.contains('is-leaving') && w.splashTimes.leaving === undefined) w.splashTimes.leaving = performance.now()
      if (!splash && document.body && w.splashTimes.removed === undefined && document.getElementById('root')) w.splashTimes.removed = performance.now()
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
  })
const splashTimes = (page: Page) => page.evaluate(() => (window as unknown as { splashTimes: { leaving?: number; removed?: number } }).splashTimes)

async function closeWelcome(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click({ timeout: 6000 }).catch(() => {})
}

test('first visit and reload: the splash plays, then leaves for the app (600 ms – 4 s)', async ({ page, context }, testInfo) => {
  await fakeApis(context)
  // The home page's titles take a moment: the splash waits for them.
  await context.route('**/api/tmdb/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await route.fallback()
  })
  await watchSplash(page)
  await page.goto('/', { waitUntil: 'commit' })
  const splash = page.locator('#nt-splash')
  await expect(splash).toBeVisible()
  // Hidden from screen readers; the page under it is the app.
  await expect(splash).toHaveAttribute('aria-hidden', 'true')
  // Mid-animation: the tile, "NT", the play button, the letters, the line and its popcorn, one fun line.
  await page.waitForTimeout(500)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/splash-${testInfo.project.name}.png` })
  const parts = await page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>('.nt-splash__tips span')].filter((s) => Number(getComputedStyle(s).opacity) > 0.5).map((s) => s.textContent)
    const stage = document.querySelector('.nt-splash__stage')!.getBoundingClientRect()
    return {
      word: document.querySelector('.nt-splash__word')!.textContent!.replace(/ /g, ' '),
      popcorn: document.querySelector('.nt-splash__fill em')!.textContent,
      tipsShowing: visible.length,
      inView: stage.left >= 0 && stage.right <= innerWidth && stage.top >= 0 && stage.bottom <= innerHeight,
      background: getComputedStyle(document.getElementById('nt-splash')!).backgroundColor,
    }
  })
  expect(parts).toEqual({ word: 'NAIJA TR', popcorn: '🍿', tipsShowing: expect.any(Number), inView: true, background: 'rgb(11, 11, 15)' })
  expect(parts.tipsShowing).toBeLessThanOrEqual(1)

  // Gone, and removed from the page, once the home page is ready.
  await expect(splash).toHaveCount(0, { timeout: 6000 })
  const times = await splashTimes(page)
  expect(times.leaving).toBeGreaterThanOrEqual(600)
  expect(times.leaving).toBeLessThanOrEqual(4100)
  expect(times.removed! - times.leaving!).toBeGreaterThanOrEqual(300)
  await expect(page.locator('.navbar')).toBeVisible()
  await closeWelcome(page)

  // ---- Reload: again. ----
  await page.reload({ waitUntil: 'commit' })
  await expect(page.locator('#nt-splash')).toBeVisible()
  await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 6000 })
  expect((await splashTimes(page)).leaving).toBeGreaterThanOrEqual(600)
})

test('moving between pages: no splash, but the red bar, the corner logo when slow, and skeleton cards', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await fakeApis(context)
  await page.goto('/')
  await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 6000 })
  await closeWelcome(page)
  await expect(page.locator('[data-testid="nav-progress"]')).toHaveCount(0, { timeout: 10_000 })

  // From now on the titles take 1.5 s to come.
  await context.route('**/api/tmdb/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.fallback()
  })
  const movies = page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Movies', exact: true })
  if (!(await movies.isVisible())) await page.getByRole('button', { name: 'Open menu' }).click()
  await (mobile ? movies.tap() : movies.click())
  const bar = page.locator('[data-testid="nav-progress"]')
  await expect(bar).toBeVisible({ timeout: 1000 })
  await expect(page.locator('[data-testid="nav-progress-logo"]')).toBeVisible({ timeout: 1000 })
  // Skeleton cards meanwhile, never the splash.
  expect(await page.locator('.skeleton, .poster-card--skeleton').count()).toBeGreaterThan(0)
  await expect(page.locator('#nt-splash')).toHaveCount(0)
  // At the very top, over the navbar, under the details panel (it never covers the player).
  const box = await bar.evaluate((el) => ({ top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height, z: Number(getComputedStyle(el).zIndex) }))
  expect(box.top).toBe(0)
  expect(box.height).toBeLessThanOrEqual(4)
  expect(box.z).toBeLessThan(100)
  await page.waitForTimeout(400)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/nav-progress-${testInfo.project.name}.png` })
  // Loaded: both go.
  await expect(bar).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('[data-testid="nav-progress-logo"]')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('slow 3G: the splash paints before the app has arrived, and still goes by 4 s', async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium' || testInfo.project.name !== 'desktop', 'Chrome network throttling, once')
  test.setTimeout(180_000)
  await fakeApis(context)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  // Chrome DevTools' "Slow 3G".
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 })
  // In the page, by its own clock: when the splash was first on screen, whether the app had started then, and when it went.
  await page.addInitScript(() => {
    const w = window as unknown as { slow: { shown?: number; appThen?: boolean; gone?: number } }
    w.slow = {}
    const tick = () => {
      const splash = document.getElementById('nt-splash')
      if (splash && w.slow.shown === undefined) {
        w.slow.shown = performance.now()
        w.slow.appThen = (document.getElementById('root')?.childElementCount ?? 0) > 0
      }
      const hidden = !splash || getComputedStyle(splash).visibility === 'hidden' || splash.classList.contains('is-leaving')
      if (w.slow.shown !== undefined && hidden && w.slow.gone === undefined) w.slow.gone = performance.now()
      if (w.slow.gone === undefined) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const started = Date.now()
  await page.goto('/', { waitUntil: 'commit', timeout: 60_000 })
  await expect(page.locator('#nt-splash')).toBeVisible({ timeout: 20_000 })
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/splash-slow3g.png` })
  await expect.poll(() => page.evaluate(() => (window as unknown as { slow: { gone?: number } }).slow.gone !== undefined), { timeout: 20_000 }).toBe(true)
  const slow = await page.evaluate(() => ({
    ...(window as unknown as { slow: { shown: number; appThen: boolean; gone: number } }).slow,
    paint: performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint')!.startTime,
  }))
  // Painted while the app's code was still on its way.
  expect(slow.appThen).toBe(false)
  // Gone within 4 s of appearing, even this slow (the CSS hides it if the app isn't there yet; a frame's slack).
  expect(slow.gone - slow.paint).toBeLessThan(4000 + 150)
  // And the app comes.
  await expect(page.locator('.navbar')).toBeVisible({ timeout: 120_000 })
  console.log(`slow 3G: splash painted at ${Math.round(slow.paint)} ms, on screen ${Math.round(slow.gone - slow.paint)} ms; the app after ${Date.now() - started} ms`)
})

test('reduced motion: no animation, a plain fade', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'once')
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  await fakeApis(context)
  // The titles take a while, so the splash is still there to look at.
  await context.route('**/api/tmdb/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await route.fallback()
  })
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'commit' })
  await expect(page.locator('#nt-splash')).toBeVisible()
  const running = () =>
    page.evaluate(() => {
      const splash = document.getElementById('nt-splash')
      if (!splash || splash.classList.contains('is-leaving')) return 'gone'
      return [...splash.querySelectorAll('*')].flatMap((el) => el.getAnimations()).map((a) => (a as CSSAnimation).animationName ?? '?').join(',')
    })
  // (The test browser applies reduced motion a moment after the page starts; a phone knows it from the start.)
  await expect.poll(running, { timeout: 2000 }).toBe('')
  // Everything in place, one line showing.
  const shown = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.nt-splash__tips span')].filter((s) => getComputedStyle(s).opacity === '1').length)
  expect(shown).toBe(1)
  await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 6000 })
  await context.close()
})

for (const { name, viewport, tv } of [
  { name: 'phone-landscape', viewport: { width: 915, height: 412 }, tv: false },
  { name: 'tv', viewport: { width: 1920, height: 1080 }, tv: true },
]) {
  test(`${name}: the splash fits the screen`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'once')
    const context = await browser.newContext({ viewport, hasTouch: !tv })
    await fakeApis(context)
    // The titles take a while, so the splash is still there to look at.
    await context.route('**/api/tmdb/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      await route.fallback()
    })
    const page = await context.newPage()
    await page.goto(tv ? '/?tv=1' : '/', { waitUntil: 'commit' })
    await expect(page.locator('#nt-splash')).toBeVisible()
    await page.waitForTimeout(300)
    const fits = await page.evaluate(() => {
      const r = document.querySelector('.nt-splash__stage')!.getBoundingClientRect()
      return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
    })
    expect(fits).toBe(true)
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/splash-${name}.png` })
    await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 6000 })
    await context.close()
  })
}
