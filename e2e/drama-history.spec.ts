import { expect, test } from '@playwright/test'
import { DRAMA_ID, TITLE, USER_ID, account, closeWelcome, fakeApis, newPhone, press, watchTabs } from './dramaFakes'

/**
 * "Your short dramas" (src/dramas/history.ts): opening a short drama saves it,
 * the "I'm on episode __" picker saves the episode, and the home page shows
 * the row with "Continue Ep 12" (our own player, never the drama's app) and a
 * ✕. Signed out it's this browser's own; signed in it follows the account to
 * another "phone" (a second browser context with its own storage). The
 * Multitag is the real one: no tab may open from the picker's taps or a ✕.
 * Resuming at the minute and second: drama-resume.spec.ts.
 */

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

  // ---- The home page: the row, with the episode; Continue opens our own player, never the app. ----
  await page.goto('/')
  const row = page.getByRole('region', { name: 'Your short dramas' })
  await expect(row).toBeVisible()
  await expect(row.getByText('Episode 12 of 52')).toBeVisible()
  await expect(row.getByRole('link', { name: /^Continue Ep 12/ })).toHaveAttribute('href', `/dramas/dramabox/${DRAMA_ID}?resume=1`)
  expect(await row.locator('a[href^="http"], a[target="_blank"]').count(), 'links out of the site').toBe(0)
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
