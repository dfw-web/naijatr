import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * "More like this" (TMDB's recommendations) at the bottom of every film and
 * series page, on desktop and a phone, not only on TV: below the player and
 * everything else, its cards opening the title.
 */

const SCREENSHOTS = process.env.E2E_SCREENSHOTS
const press = async (locator: Locator, mobile: boolean) => (mobile ? locator.tap() : locator.click())

async function open(page: Page, mobile: boolean, url: string, name: string) {
  await page.addInitScript(() => localStorage.setItem('naijatr.gate.joined', '1'))
  await page.context().route('**/api/referral/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ goal: 5, signedIn: false, adFree: false, premium: false, promo: null, trial: null, serverNow: Date.now() }) }),
  )
  await page.context().route('**/api/live/**', (route) => route.fulfill({ contentType: 'application/json', body: '{}' }))
  await page.goto(url)
  const welcome = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Not now' }) })
  await welcome.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
  if (await welcome.isVisible()) await press(welcome.getByRole('button', { name: 'Not now' }), mobile)
  return page.getByRole('dialog', { name })
}

for (const { kind, url, name } of [
  { kind: 'movie', url: '/?title=movie-550', name: 'Fight Club' },
  { kind: 'series', url: '/?title=series-1399', name: 'Game of Thrones' },
]) {
  test(`a ${kind} shows "More like this" at the bottom`, async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    const mobile = testInfo.project.name === 'mobile'
    const dialog = await open(page, mobile, url, name)
    const more = dialog.getByRole('region', { name: 'More like this' })
    await expect(more).toBeAttached({ timeout: 20_000 })
    await more.scrollIntoViewIfNeeded()
    const cards = more.getByRole('button', { name: /^View details for/ })
    await expect(cards.first()).toBeVisible()
    expect(await cards.count()).toBeGreaterThan(2)
    // The first posters load (lazily, as they come into view).
    await expect
      .poll(() => more.locator('img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 15_000 })
      .toBe(true)
    await page.waitForTimeout(600)
    // Below the player and everything else on the page.
    const below = await page.evaluate(() => {
      const row = document.getElementById('more-like-this')!.getBoundingClientRect()
      const watch = document.querySelector('section[aria-label="Watch"]')!.getBoundingClientRect()
      return { belowPlayer: row.top >= watch.bottom, noSideScroll: document.documentElement.scrollWidth <= innerWidth }
    })
    expect(below).toEqual({ belowPlayer: true, noSideScroll: true })
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/more-like-this-${kind}-${testInfo.project.name}.png` })
  })
}
