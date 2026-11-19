import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * The NAIJA TR loading animations: the wordless splash on a page load (inline
 * in index.html: projector, falling stripes, "NT" revealed, a loader ring;
 * the exit's ring becomes a pressed ▶ and an iris opens on the site), its
 * short version on a reload, and the slim red bar plus the bouncing corner
 * logo when moving between pages inside the app (src/components/NavProgress.tsx).
 * Also slow 3G, reduced motion, a phone in landscape and TV mode.
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

/** The titles take this long, so there's a splash to look at. */
async function slowTitles(context: BrowserContext, ms: number) {
  await context.route('**/api/tmdb/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    await route.fallback()
  })
}

interface Times {
  shownAt?: number
  quick?: boolean
  leaving?: number
  exit?: string
  removed?: number
  appDrawn?: boolean
}

/** The splash's moments, by the page's own clock. */
const watchSplash = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { splashTimes: Times; ntSplashAt?: number }
    w.splashTimes = {}
    new MutationObserver(() => {
      const splash = document.getElementById('nt-splash')
      const t = w.splashTimes
      if (splash && t.quick === undefined && w.ntSplashAt !== undefined) t.quick = splash.classList.contains('nt-splash--quick')
      if (splash?.classList.contains('is-leaving') && t.leaving === undefined) {
        t.leaving = performance.now()
        t.shownAt = w.ntSplashAt
        t.exit = splash.classList.contains('is-leaving--full') ? 'full' : 'quick'
        // What's under it as it goes: the app, drawn.
        t.appDrawn = Boolean(document.querySelector('#root .navbar'))
      }
      if (!splash && t.leaving !== undefined && t.removed === undefined) t.removed = performance.now()
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
  })
const splashTimes = (page: Page) => page.evaluate(() => (window as unknown as { splashTimes: Times }).splashTimes)

async function closeWelcome(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click({ timeout: 8000 }).catch(() => {})
}

/** Centred, and inside the screen. */
const stagePlacement = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector('.nt-splash__stage')!.getBoundingClientRect()
    return {
      centred: Math.abs(r.left + r.width / 2 - innerWidth / 2) <= 1 && Math.abs(r.top + r.height / 2 - innerHeight / 2) <= 1,
      inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
    }
  })

const sinceSplash = (page: Page, ms: number) =>
  page.waitForFunction((t) => performance.now() - ((window as unknown as { ntSplashAt?: number }).ntSplashAt ?? 0) >= t, ms)

test('first visit: the film, then the full exit once the app is ready; a reload: the short version', async ({ page, context }) => {
  await fakeApis(context)
  await slowTitles(context, 1500)
  await watchSplash(page)
  await page.goto('/', { waitUntil: 'commit' })
  const splash = page.locator('#nt-splash')
  await expect(splash).toBeVisible()
  // Hidden from screen readers; the page under it is the app.
  await expect(splash).toHaveAttribute('aria-hidden', 'true')
  // The intro has played: the loader is up.
  await sinceSplash(page, 1400)
  const scene = await page.evaluate(() => {
    const q = (sel: string) => document.querySelector(sel)!
    return {
      // No words at all: the animation tells it.
      text: q('#nt-splash').textContent!.trim(),
      fallen: document.querySelectorAll('.nt-splash__drop i').length,
      tile: getComputedStyle(q('.nt-splash__flag')).opacity,
      ntUncovered: getComputedStyle(q('.nt-splash__reveal')).transform,
      ringTurning: q('.nt-splash__spin').getAnimations().some((a) => a.playState === 'running'),
      sparkles: document.querySelectorAll('.nt-splash__sparks i').length,
      dark: getComputedStyle(q('.nt-splash__iris')).boxShadow.includes('rgb(11, 11, 15)'),
    }
  })
  expect(scene).toEqual({ text: '', fallen: 3, tile: '1', ntUncovered: expect.stringMatching(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/), ringTurning: true, sparkles: 6, dark: true })
  expect(await stagePlacement(page)).toEqual({ centred: true, inside: true })
  await expect(splash).toHaveCount(0, { timeout: 8000 })
  const first = await splashTimes(page)
  expect(first).toMatchObject({ quick: false, exit: 'full', appDrawn: true })
  // The intro played once; the exit started by 4 s; the full exit (ring, ▶, iris) took ~1.1 s.
  expect(first.leaving! - first.shownAt!).toBeGreaterThanOrEqual(1100)
  expect(first.leaving! - first.shownAt!).toBeLessThanOrEqual(4100)
  expect(first.removed! - first.leaving!).toBeGreaterThanOrEqual(1050)
  await expect(page.locator('.navbar')).toBeVisible()
  await closeWelcome(page)

  // ---- Reload, the titles quick now: the short version. ----
  await context.unrouteAll({ behavior: 'ignoreErrors' })
  await fakeApis(context)
  await page.reload({ waitUntil: 'commit' })
  await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 8000 })
  const again = await splashTimes(page)
  expect(again).toMatchObject({ quick: true, exit: 'quick', appDrawn: true })
  expect(again.leaving! - again.shownAt!).toBeGreaterThanOrEqual(450)
  // About 0.9 s on a cached reload (the app's code takes a moment to start).
  expect(again.removed! - again.shownAt!).toBeLessThan(1600)
  console.log(`splash: first visit ${Math.round(first.removed! - first.shownAt!)} ms; reload ${Math.round(again.removed! - again.shownAt!)} ms (${again.exit} exit)`)
})

test('the film, frame by frame: projector, stripes, "NT", the ring; then the exit: ring closes, ▶ pressed, iris', async ({ page, context }, testInfo) => {
  await fakeApis(context)
  // Without the app's code the splash stays, to be looked at frame by frame.
  await context.route(/\/assets\/.*\.js$/, (route) => route.abort())
  await page.goto('/', { waitUntil: 'commit' })
  await expect(page.locator('#nt-splash')).toBeVisible()
  const look = () =>
    page.evaluate(() => {
      const op = (sel: string) => Number(getComputedStyle(document.querySelector(sel)!).opacity)
      const first = document.querySelector('.nt-splash__drop i')!.getBoundingClientRect()
      const tile = document.querySelector('.nt-splash__tile')!.getBoundingClientRect()
      return {
        beam: op('.nt-splash__beam'),
        stripeAbove: first.bottom < tile.top,
        tile: op('.nt-splash__flag'),
        ring: op('.nt-splash__ring'),
        badge: op('.nt-splash__badge'),
        irisScale: new DOMMatrix(getComputedStyle(document.querySelector('.nt-splash__iris')!).transform).a,
      }
    })
  /** The intro at `ms` (the page's animations, paused there). */
  const intro = async (ms: number) => {
    await page.evaluate((t) => {
      for (const a of document.getElementById('nt-splash')!.getAnimations({ subtree: true })) {
        a.pause()
        a.currentTime = t
      }
    }, ms)
    return look()
  }
  expect(await intro(120)).toMatchObject({ stripeAbove: true, tile: 0, ring: 0 })
  const loaded = await intro(1700)
  expect(loaded).toMatchObject({ stripeAbove: false, tile: 1, ring: 1, badge: 0, irisScale: 1 })
  expect(loaded.beam).toBeGreaterThan(0.7)
  if (SCREENSHOTS) {
    for (const at of [100, 250, 500, 640, 800, 950, 1150, 1700]) {
      await intro(at)
      await page.screenshot({ path: `${SCREENSHOTS}/film-${testInfo.project.name}-${String(at).padStart(4, '0')}.png` })
    }
  }

  // ---- The exit, as src/ui/splash.ts starts it, at `ms` into it (the intro finished). ----
  await page.evaluate(() => {
    const splash = document.getElementById('nt-splash')!
    for (const a of splash.getAnimations({ subtree: true })) a.currentTime = 2000
    ;(window as unknown as { introAnimations: Set<Animation> }).introAnimations = new Set(splash.getAnimations({ subtree: true }))
    splash.style.setProperty('--nt-iris-scale', String(Math.ceil(Math.hypot(innerWidth, innerHeight) / 60) + 2))
    splash.classList.add('is-leaving', 'is-leaving--full')
  })
  const exit = async (ms: number) => {
    await page.evaluate((t) => {
      const before = (window as unknown as { introAnimations: Set<Animation> }).introAnimations
      for (const a of document.getElementById('nt-splash')!.getAnimations({ subtree: true })) {
        a.pause()
        if (!before.has(a)) a.currentTime = t
      }
    }, ms)
    return look()
  }
  // The ring closes into a circle (and flashes), then shrinks into the ▶; the ▶ is pressed; the iris opens.
  expect((await exit(500)).badge).toBeGreaterThan(0.95)
  expect((await exit(640)).irisScale).toBe(1)
  // Open: the hole (60 px across before) clears every corner of the screen.
  const open = await exit(1100)
  expect(open.irisScale * 30).toBeGreaterThanOrEqual(await page.evaluate(() => Math.hypot(innerWidth, innerHeight) / 2))
  if (SCREENSHOTS) {
    for (const at of [90, 170, 300, 420, 580, 720, 850, 1000]) {
      await exit(at)
      await page.screenshot({ path: `${SCREENSHOTS}/exit-${testInfo.project.name}-${String(at).padStart(4, '0')}.png` })
    }
  }
})

test('moving between pages: no splash, but the red bar, the corner logo when slow, and skeleton cards', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await fakeApis(context)
  await page.goto('/')
  await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 8000 })
  await closeWelcome(page)
  await expect(page.locator('[data-testid="nav-progress"]')).toHaveCount(0, { timeout: 10_000 })

  // From now on the titles take 1.5 s to come.
  await slowTitles(context, 1500)
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

test('slow 3G: the splash paints before the app has arrived, and its exit starts by 4 s', async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium' || testInfo.project.name !== 'desktop', 'Chrome network throttling, once')
  test.setTimeout(180_000)
  await fakeApis(context)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  // Chrome DevTools' "Slow 3G".
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 })
  // In the page, by its own clock: whether the app had started when the splash went up, and when it started going.
  await page.addInitScript(() => {
    const w = window as unknown as { slow: { appThen?: boolean; going?: number } }
    w.slow = {}
    const tick = () => {
      const splash = document.getElementById('nt-splash')
      if (splash && w.slow.appThen === undefined) w.slow.appThen = (document.getElementById('root')?.childElementCount ?? 0) > 0
      const going = !splash || splash.classList.contains('is-leaving') || Number(getComputedStyle(splash).opacity) < 1
      if (w.slow.appThen !== undefined && going && w.slow.going === undefined) w.slow.going = performance.now()
      if (w.slow.going === undefined) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const started = Date.now()
  await page.goto('/', { waitUntil: 'commit', timeout: 60_000 })
  await expect(page.locator('#nt-splash')).toBeVisible({ timeout: 20_000 })
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/splash-slow3g.png` })
  await expect.poll(() => page.evaluate(() => (window as unknown as { slow: { going?: number } }).slow.going !== undefined), { timeout: 30_000 }).toBe(true)
  const slow = await page.evaluate(() => ({
    ...(window as unknown as { slow: { appThen: boolean; going: number } }).slow,
    paint: performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint')!.startTime,
  }))
  // Painted while the app's code was still on its way.
  expect(slow.appThen).toBe(false)
  // Going by 4 s after it appeared (a frame's slack), even this slow.
  expect(slow.going - slow.paint).toBeLessThan(4000 + 150)
  // The app comes, and the splash is gone from the page.
  await expect(page.locator('.navbar')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 10_000 })
  console.log(`slow 3G: splash painted at ${Math.round(slow.paint)} ms, going at ${Math.round(slow.going)} ms; the app after ${Date.now() - started} ms`)
})

test('reduced motion: the still logo, and a plain fade', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'once')
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  await fakeApis(context)
  await slowTitles(context, 2500)
  const page = await context.newPage()
  await watchSplash(page)
  await page.goto('/', { waitUntil: 'commit' })
  await expect(page.locator('#nt-splash')).toBeVisible()
  const running = () =>
    page.evaluate(() => {
      const splash = document.getElementById('nt-splash')
      if (!splash || splash.classList.contains('is-leaving')) return 'gone'
      return [...splash.querySelectorAll('*')].flatMap((el) => el.getAnimations()).length
    })
  // (The test browser applies reduced motion a moment after the page starts; a phone knows it from the start.)
  await expect.poll(running, { timeout: 2000 }).toBe(0)
  // The finished logo, still: the tile, "NT" uncovered; no falling stripes, no ring.
  const still = await page.evaluate(() => ({
    tile: getComputedStyle(document.querySelector('.nt-splash__flag')!).opacity,
    nt: getComputedStyle(document.querySelector('.nt-splash__reveal')!).transform,
    drop: getComputedStyle(document.querySelector('.nt-splash__drop')!).display,
    ring: getComputedStyle(document.querySelector('.nt-splash__ring')!).display,
  }))
  expect(still).toEqual({ tile: '1', nt: 'none', drop: 'none', ring: 'none' })
  await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 8000 })
  const times = await splashTimes(page)
  // A plain fade: quick, no ▶, no iris.
  expect(times.removed! - times.leaving!).toBeLessThan(700)
  await context.close()
})

for (const { name, viewport, tv } of [
  { name: 'phone-landscape', viewport: { width: 915, height: 412 }, tv: false },
  { name: 'iphone', viewport: { width: 390, height: 844 }, tv: false },
  { name: 'tv', viewport: { width: 1920, height: 1080 }, tv: true },
]) {
  test(`${name}: the splash is centred and fits the screen`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'once')
    const context = await browser.newContext({ viewport, hasTouch: !tv, deviceScaleFactor: tv ? 1 : 3 })
    await fakeApis(context)
    await slowTitles(context, 2500)
    const page = await context.newPage()
    await page.goto(tv ? '/?tv=1' : '/', { waitUntil: 'commit' })
    await expect(page.locator('#nt-splash')).toBeVisible()
    await sinceSplash(page, 1300)
    expect(await stagePlacement(page)).toEqual({ centred: true, inside: true })
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/splash-${name}.png` })
    await expect(page.locator('#nt-splash')).toHaveCount(0, { timeout: 8000 })
    await context.close()
  })
}
