import { expect, test, type BrowserContext, type Frame, type Locator, type Page } from '@playwright/test'

/**
 * "Slow or not loading?" help on the movie player (src/components/PlayerHelp.tsx),
 * in a real browser on desktop and a phone, with the real ad scripts:
 * the yellow hint 12 s after a player that never answers, and after a 10 s
 * stall mid-show; it goes once the video moves again; the video and its
 * buttons never move or get covered; no ad from the ✕ or the notes.
 *
 * /api/play is a fake player page here, which sends the real players'
 * postMessage events ({ source: 'embedmaster_player', event, info }) when
 * the test tells it to.
 */

const SCREENSHOTS = process.env.E2E_SCREENSHOTS
const HINT = /Taking too long\?.*Switch server from the menu at the top-left of the player\./
const press = async (locator: Locator, mobile: boolean) => (mobile ? locator.tap() : locator.click())

const FAKE_PLAYER = `<!doctype html><html><body style="margin:0;background:#111;color:#888;font:14px sans-serif;display:grid;place-items:center;height:100vh">
fake player<script>window.send = (event, info) => parent.postMessage({ source: 'embedmaster_player', event, info }, '*')</script></body></html>`

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
  // Problem reports (beacons, which routes don't see): read off the requests.
  const problems: unknown[] = []
  context.on('request', (request) => {
    if (request.url().endsWith('/api/live/problem')) problems.push(request.postDataJSON())
  })
  await context.route('**/api/live/**', (route) => route.fulfill({ contentType: 'application/json', body: '{}' }))
  return problems
}

function watchTabs(context: BrowserContext) {
  const opened: number[] = []
  context.on('page', () => opened.push(Date.now()))
  return { since: (at: number) => opened.filter((time) => time >= at).length }
}

/** Where the video and its buttons are, to tell if anything moved. */
async function layout(page: Page) {
  return page.evaluate(() => {
    // From the player's own top-left: the title panel scrolls inside itself when a button is tapped.
    const origin = document.querySelector('.player')!.getBoundingClientRect()
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect()
      return { top: Math.round(r.top - origin.top), left: Math.round(r.left - origin.left), width: Math.round(r.width), height: Math.round(r.height) }
    }
    // The bar's own height may change (the CC menu appears once the video plays): where it starts is what matters.
    const bar = box('.player__bar')
    return { frame: box('.player__frame'), barTop: bar.top, barLeft: bar.left, slot: box('.player__status') }
  })
}

async function openPlayer(page: Page, mobile: boolean): Promise<Frame> {
  // Already followed the Telegram channel on this device (its gate has its own tests).
  await page.addInitScript(() => localStorage.setItem('naijatr.gate.joined', '1'))
  await page.goto('/?title=movie-550')
  const welcome = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Not now' }) })
  await welcome.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
  if (await welcome.isVisible()) await press(welcome.getByRole('button', { name: 'Not now' }), mobile)
  await press(page.getByRole('dialog', { name: 'Fight Club' }).getByRole('button', { name: 'Play', exact: true }), mobile)
  // A Play may open the direct-link ad in a tab: back to this one.
  await page.bringToFront()
  for (const other of page.context().pages()) if (other !== page) await other.close()
  const iframe = page.locator('.player__frame iframe')
  await expect(iframe).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => page.frames().find((f) => f.url().includes('/api/play/movie/550')), { timeout: 15_000 }).toBeTruthy()
  return page.frames().find((f) => f.url().includes('/api/play/movie/550'))!
}

test('slow start and stall: the hint above the player, nothing moves, no ads', async ({ page, context }, testInfo) => {
  test.setTimeout(150_000)
  const mobile = testInfo.project.name === 'mobile'
  const problems = await fakeApis(context)
  const tabs = watchTabs(context)
  const player = await openPlayer(page, mobile)
  const send = (event: string, info?: unknown) => player.evaluate(([e, i]) => (window as unknown as { send: (e: string, i: unknown) => void }).send(e, i), [event, info] as const)

  // The notes under the buttons: ⚡ first, then the audio note, one list.
  const notes = page.locator('.player__notes li')
  await expect(notes).toHaveCount(3)
  await expect(notes.nth(0)).toContainText('⚡ Movie slow to load or not playing?')
  await expect(notes.nth(1)).toContainText('❓ ‘No server found’ = this title isn’t on NAIJA TR yet.')
  await expect(notes.nth(2)).toContainText('🔊 Different sources')

  // ---- No answer from the player for 12 s: the hint, and nothing moved. ----
  const before = await layout(page)
  await expect(page.getByText(HINT)).toHaveCount(0)
  await expect(page.getByText(HINT)).toBeVisible({ timeout: 16_000 })
  const during = await layout(page)
  expect(during, 'the video and its buttons stay put').toEqual(before)
  // Above the video, never over it, and it fits its slot.
  const fits = await page.evaluate(() => {
    const hint = document.querySelector('.player__slow')!.getBoundingClientRect()
    const slot = document.querySelector('.player__status')!.getBoundingClientRect()
    const frame = document.querySelector('.player__frame')!.getBoundingClientRect()
    return { aboveVideo: hint.bottom <= frame.top + 0.5, inSlot: hint.top >= slot.top - 0.5 && hint.bottom <= slot.bottom + 0.5, noSideScroll: document.documentElement.scrollWidth <= innerWidth }
  })
  expect(fits).toEqual({ aboveVideo: true, inSlot: true, noSideScroll: true })
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/player-hint-${testInfo.project.name}.png` })
  await expect.poll(() => problems.length).toBe(1)
  expect(problems[0]).toMatchObject({ kind: 'slow', item: 'movie:550', server: 'nextstream', device: mobile ? 'android' : 'desktop' })

  // ---- The player answers and plays: gone. ----
  await send('duration', 8000)
  await send('play')
  for (let t = 1; t <= 3; t++) {
    await send('time', t)
    await page.waitForTimeout(500)
  }
  await expect(page.getByText(HINT)).toHaveCount(0)
  expect(await layout(page)).toEqual(before)

  // ---- Stuck for 10 s mid-show: back; moving again: gone. ----
  await send('serverchange', 'MovieJoy')
  await expect(page.getByText(HINT)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => problems.length).toBe(2)
  expect(problems[1]).toMatchObject({ kind: 'stall', item: 'movie:550', source: 'MovieJoy' })
  expect(await layout(page)).toEqual(before)
  await send('time', 4)
  await expect(page.getByText(HINT)).toHaveCount(0)

  // ---- ✕ on the hint and on the ⚡ note: no ad tab. ----
  await page.waitForTimeout(4000)
  await expect(page.getByText(HINT)).toBeVisible({ timeout: 15_000 })
  const tapped = Date.now()
  await press(page.getByText(HINT), mobile)
  await press(page.getByRole('button', { name: 'Dismiss switch-server hint' }), mobile)
  await expect(page.getByText(HINT)).toHaveCount(0)
  await press(page.getByRole('button', { name: 'Dismiss slow-loading tip' }), mobile)
  await expect(notes).toHaveCount(2)
  await page.waitForTimeout(2500)
  expect(tabs.since(tapped), 'tabs opened by the hint, its ✕ or the note’s ✕').toBe(0)
  expect(await layout(page)).toMatchObject({ frame: before.frame, barTop: before.barTop })
  expect(await page.evaluate(() => Number(localStorage.getItem('naijatr.slowNoteDismissedAt')))).toBeGreaterThan(0)
})

test('the hint fits a small phone (320 px) without moving the video', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone width only')
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 320, height: 640 })
  await fakeApis(context)
  await openPlayer(page, true)
  const before = await layout(page)
  await expect(page.getByText(HINT)).toBeVisible({ timeout: 16_000 })
  expect(await layout(page)).toEqual(before)
  const fit = await page.evaluate(() => {
    const hint = document.querySelector<HTMLElement>('.player__slow')!
    const slot = document.querySelector<HTMLElement>('.player__status')!
    return { fits: hint.offsetHeight <= slot.clientHeight, noSideScroll: document.documentElement.scrollWidth <= innerWidth }
  })
  expect(fit).toEqual({ fits: true, noSideScroll: true })
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/player-hint-320.png` })
})
