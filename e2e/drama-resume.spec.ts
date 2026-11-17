import { expect, test } from '@playwright/test'
import { DRAMA_ID, TITLE, account, fakeApis, newPhone, press, videoTime } from './dramaFakes'

/**
 * "Continue Ep 3 · 0:08" on the home page's "Your short dramas": our own
 * player picks up at the episode and the minute and second they stopped at,
 * on this device and, signed in, on another.
 */

// Real Chrome: Playwright's own Chromium can't play H.264 MP4 (the drama apps' videos, and this test's).
test.use({ channel: 'chrome' })

test('Continue picks up in our player at the episode and the minute and second they stopped at', async ({ page, context }, testInfo) => {
  test.setTimeout(150_000)
  const mobile = testInfo.project.name === 'mobile'
  await fakeApis(context, null)

  // ---- Watch episode 3 on NAIJA TR and stop at 0:08. ----
  await page.goto(`/dramas/dramabox/${DRAMA_ID}?ep=ep3`)
  await expect(page.getByRole('dialog', { name: `${TITLE}, episode 3` })).toBeVisible()
  await expect.poll(() => videoTime(page), { message: 'the video loaded', timeout: 20_000 }).toBeGreaterThanOrEqual(0)
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('.dr-player__video')!
    video.muted = true
    video.currentTime = 8
    video.pause()
  })
  await expect
    .poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('naijatr:dramaHistory') ?? '[]')))[0], { timeout: 10_000 })
    .toMatchObject({ episode: 3, episodeId: 'ep3', position: 8 })
  // The picker follows the player.
  await page.getByRole('button', { name: 'Close player' }).click()
  await expect(page.getByRole('spinbutton', { name: 'I’m on episode' })).toHaveValue('3')
  // The drama's page offers it too, above "Play episode 1".
  await expect(page.getByRole('button', { name: '▶ Continue Ep 3 · 0:08' })).toBeVisible()

  // ---- Home: "Continue Ep 3 · 0:08" opens the player at episode 3, 0:08. ----
  await page.goto('/')
  const row = page.getByRole('region', { name: 'Your short dramas' })
  const resume = row.getByRole('link', { name: /^Continue Ep 3 · 0:08/ })
  await expect(resume).toBeVisible()
  // The welcome popup (signed out), when it comes up.
  await page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click({ timeout: 6000 }).catch(() => {})
  // Inside its card, on any screen.
  expect(await resume.evaluate((link) => link.scrollWidth <= link.clientWidth + 1 && link.getBoundingClientRect().right <= link.closest('article')!.getBoundingClientRect().right + 1)).toBe(true)
  if (process.env.E2E_SCREENSHOTS) await row.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  if (process.env.E2E_SCREENSHOTS) await row.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/drama-row-${testInfo.project.name}.png` })
  await press(resume, mobile)
  for (const other of context.pages()) if (other !== page) await other.close()
  await page.waitForURL((url) => url.pathname === `/dramas/dramabox/${DRAMA_ID}` && url.searchParams.get('ep') === 'ep3')
  await expect(page.getByRole('dialog', { name: `${TITLE}, episode 3` })).toBeVisible()
  await expect.poll(() => videoTime(page), { message: 'back at 0:08', timeout: 20_000 }).toBeGreaterThanOrEqual(7.5)
  expect(await videoTime(page)).toBeLessThan(15)
})

test('signed in: the episode and time follow the account to another phone', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000)
  const mobile = testInfo.project.name === 'mobile'
  const store = account()
  const a = await newPhone(browser, mobile, baseURL, store)
  await a.page.goto(`/dramas/dramabox/${DRAMA_ID}?ep=ep5`)
  await expect.poll(() => videoTime(a.page), { timeout: 20_000 }).toBeGreaterThanOrEqual(0)
  await a.page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('.dr-player__video')!
    video.muted = true
    video.currentTime = 9
    video.pause()
  })
  await expect.poll(() => store.rows.get(`dramabox:${DRAMA_ID}`), { timeout: 20_000 }).toMatchObject({ episode: 5, episode_id: 'ep5', position_s: 9 })

  const b = await newPhone(browser, mobile, baseURL, store)
  await b.page.goto('/')
  const row = b.page.getByRole('region', { name: 'Your short dramas' })
  await expect(row.getByRole('link', { name: /^Continue Ep 5 · 0:09/ })).toBeVisible({ timeout: 20_000 })
  // The card's link (resume=1), opened as a fresh load on phone B.
  await b.page.goto(`/dramas/dramabox/${DRAMA_ID}?resume=1`)
  await b.page.waitForURL((url) => url.searchParams.get('ep') === 'ep5')
  await expect.poll(() => videoTime(b.page), { message: 'phone B at 0:09', timeout: 20_000 }).toBeGreaterThanOrEqual(8.5)
  await a.context.close()
  await b.context.close()
})
