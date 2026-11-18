import { expect, test, type BrowserContext, type Frame, type Locator, type Page } from '@playwright/test'

/**
 * "No server found" (src/components/NotAvailable.tsx): a title on none of
 * the servers. In a real browser on desktop, a phone and TV mode, with the
 * real ad scripts: 15 s with no sign of life from the player brings "😔 Not available on NAIJA TR yet" under
 * the player, never over it, and nothing above it moves; the switch-server
 * tips go; "Request this title" saves the request; "Watch something similar"
 * scrolls to "More like this"; none of it opens an ad.
 *
 * /api/play is a fake player page that never answers unless told to, like
 * the real players' "No server found" (they send no ready/play/time event).
 */

const SCREENSHOTS = process.env.E2E_SCREENSHOTS
const BOX = 'Not available on NAIJA TR yet'
const press = async (locator: Locator, mobile: boolean) => (mobile ? locator.tap() : locator.click())

const FAKE_PLAYER = `<!doctype html><html><body style="margin:0;background:#111;color:#888;font:14px sans-serif;display:grid;place-items:center;height:100vh">
No server found<script>window.send = (event, info) => parent.postMessage({ source: 'embedmaster_player', event, info }, '*')</script></body></html>`

async function fakeApis(context: BrowserContext) {
  await context.route('**/api/referral/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ goal: 5, signedIn: false, adFree: false, premium: false, promo: null, trial: null, serverNow: Date.now() }) }),
  )
  await context.route(/uplcm\.com/, (route) => route.fulfill({ contentType: 'text/html', body: '<title>ad</title>' }))
  await context.route('**/api/play/**', (route) =>
    new URL(route.request().url()).searchParams.has('check')
      ? route.fulfill({ contentType: 'application/json', body: '{"available":true}' })
      : route.fulfill({ contentType: 'text/html', body: FAKE_PLAYER }),
  )
  await context.route('**/api/live/**', (route) => route.fulfill({ contentType: 'application/json', body: '{}' }))
  const requests: Record<string, unknown>[] = []
  await context.route('**/api/live/request', (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>)
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, count: requests.length, already: false, email: false }) })
  })
  return requests
}

function watchTabs(context: BrowserContext) {
  const opened: number[] = []
  context.on('page', () => opened.push(Date.now()))
  return { since: (at: number) => opened.filter((time) => time >= at).length }
}

/** The video, its buttons and the slot above it, from the player's own top-left. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const origin = document.querySelector('.player')!.getBoundingClientRect()
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect()
      return { top: Math.round(r.top - origin.top), left: Math.round(r.left - origin.left), width: Math.round(r.width), height: Math.round(r.height) }
    }
    const bar = box('.player__bar')
    return { frame: box('.player__frame'), barTop: bar.top, slot: box('.player__status') }
  })
}

/** Where the box is: under the buttons, clear of the video, inside the page's width. */
const placement = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.player__missing')!.getBoundingClientRect()
    const frame = document.querySelector('.player__frame')!.getBoundingClientRect()
    const bar = document.querySelector('.player__bar')!.getBoundingClientRect()
    return {
      underButtons: box.top >= bar.bottom - 0.5,
      clearOfVideo: box.top >= frame.bottom - 0.5,
      inWidth: box.left >= -0.5 && box.right <= innerWidth + 0.5,
      noSideScroll: document.documentElement.scrollWidth <= innerWidth,
    }
  })

async function openPlayer(page: Page, mobile: boolean, url = '/?title=movie-550'): Promise<Frame> {
  await page.addInitScript(() => {
    localStorage.setItem('naijatr.gate.joined', '1')
    // TV mode's own channel gate (a QR code), already passed on this TV.
    localStorage.setItem('naijatr.gate.tv', '1')
  })
  await page.goto(url)
  const welcome = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Not now' }) })
  await welcome.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
  if (await welcome.isVisible()) await press(welcome.getByRole('button', { name: 'Not now' }), mobile)
  await press(page.getByRole('dialog', { name: 'Fight Club' }).getByRole('button', { name: 'Play', exact: true }), mobile)
  // TV mode: a short ad break first, then Continue.
  if (url.includes('tv=1')) await page.locator('.tv-ad-break__continue').click({ timeout: 15_000 }).catch(() => {})
  await page.bringToFront()
  for (const other of page.context().pages()) if (other !== page) await other.close()
  await expect(page.locator('.player__frame iframe')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => page.frames().find((f) => f.url().includes('/api/play/movie/550')), { timeout: 15_000 }).toBeTruthy()
  return page.frames().find((f) => f.url().includes('/api/play/movie/550'))!
}

test('15 s with no sign of life: "Not available" under the player, Request, Watch something similar, no ads', async ({ page, context }, testInfo) => {
  test.setTimeout(150_000)
  const mobile = testInfo.project.name === 'mobile'
  const requests = await fakeApis(context)
  const tabs = watchTabs(context)
  const player = await openPlayer(page, mobile)
  const send = (event: string, info?: unknown) => player.evaluate(([e, i]) => (window as unknown as { send: (e: string, i: unknown) => void }).send(e, i), [event, info] as const)
  const before = await layout(page)
  const notes = page.locator('.player__notes li')
  await expect(notes.filter({ hasText: '❓ ‘No server found’ = this title isn’t on NAIJA TR yet. Tap Request and we’ll add it soon.' })).toHaveCount(1)

  // ---- 15 s: the box, under the player; no "switch server" tips; nothing above moved. ----
  const box = page.getByRole('region', { name: BOX })
  await expect(box).toBeVisible({ timeout: 20_000 })
  await expect(box).toContainText('‘No server found’ means this title isn’t available on any of our servers right now, so there’s no need to switch servers.')
  await expect(page.getByText(/Taking too long\?/)).toHaveCount(0)
  await expect(page.getByText(/Movie slow to load or not playing\?/)).toHaveCount(0)
  expect(await layout(page), 'the video, its buttons and the slot above stay put').toEqual(before)
  expect(await placement(page)).toEqual({ underButtons: true, clearOfVideo: true, inWidth: true, noSideScroll: true })
  if (SCREENSHOTS) {
    await box.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SCREENSHOTS}/not-available-${testInfo.project.name}.png` })
  }

  // ---- Request this title: saved, "Requested", no ad. ----
  const tapped = Date.now()
  await press(box.getByRole('button', { name: 'Request this title' }), mobile)
  await expect(box.getByRole('button', { name: 'Requested' })).toBeDisabled()
  await expect(box.getByText('Thanks! Your request is saved.')).toBeVisible()
  await expect(notes.filter({ hasText: 'Requested ✓ We’ll add it soon.' })).toHaveCount(1)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ item: 'movie:550', title: 'Fight Club', ep: null })

  // ---- Watch something similar: "More like this", scrolled to. ----
  await press(box.getByRole('button', { name: 'Watch something similar' }), mobile)
  const more = page.getByRole('region', { name: 'More like this' })
  await expect(more).toBeVisible({ timeout: 10_000 })
  await expect(more).toBeInViewport({ timeout: 5000 })
  await page.waitForTimeout(2500)
  expect(tabs.since(tapped), 'tabs opened by Request or Watch something similar').toBe(0)

  // ---- Back in the page: the player plays after all: the box goes. ----
  await send('ready')
  await expect(box).toHaveCount(0)
})

test('TV mode: out of fullscreen, the box under the player, the remote on Request', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'TV mode is a big screen')
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  await fakeApis(context)
  const player = await openPlayer(page, false, '/?tv=1&title=movie-550')
  await expect(page.locator('html')).toHaveClass(/tv-mode/)
  // One server failing isn't "no server found"; 15 s of nothing is.
  await player.evaluate(() => (window as unknown as { send: (e: string, i: unknown) => void }).send('error', 'VidStore failed'))
  const box = page.getByRole('region', { name: BOX })
  await page.waitForTimeout(2000)
  await expect(box).toHaveCount(0)
  // Play opened fullscreen on the TV: it leaves it, so the box (under the player, never over it) can be seen.
  await expect(box).toBeVisible({ timeout: 20_000 })
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  expect(await placement(page)).toEqual({ underButtons: true, clearOfVideo: true, inWidth: true, noSideScroll: true })
  // The remote is on Request.
  await expect(box.getByRole('button', { name: 'Request this title' })).toBeFocused()
  if (SCREENSHOTS) {
    await box.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SCREENSHOTS}/not-available-tv.png` })
  }
  await box.getByRole('button', { name: 'Watch something similar' }).click()
  await expect(page.getByRole('region', { name: 'More like this' })).toBeInViewport({ timeout: 5000 })
})
