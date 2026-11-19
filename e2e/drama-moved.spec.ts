import { expect, test } from '@playwright/test'
import { DRAMA_ID, TITLE, details, fakeApis, json, press } from './dramaFakes'

/**
 * DramaBox's ids were numbers until Ezvid's November 2026 update; they're
 * name slugs now. A drama saved before ("Your short dramas") is found again by
 * its title, and Continue still picks up at the episode and time.
 */

// Real Chrome: Playwright's own Chromium can't play H.264 MP4.
test.use({ channel: 'chrome' })

const SLUG = 'he-broke-the-heart-that-saved-him'

test('a DramaBox drama saved under its old number opens under its new id, at the same episode and time', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000)
  const mobile = testInfo.project.name === 'mobile'
  await fakeApis(context, null)
  const searched: string[] = []
  // Added after fakeApis, so asked first: the old number is gone; the slug works.
  await context.route('**/api/dramas/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/drama') && url.searchParams.get('id') === DRAMA_ID) return json(route, { error: 'upstream-error' }, 502)
    if (url.pathname.endsWith('/drama')) return json(route, { ...details, drama: { ...details.drama, id: SLUG } })
    if (url.pathname.endsWith('/search')) {
      searched.push(url.searchParams.get('q') ?? '')
      return json(route, { dramas: [{ ...details.drama, id: 'another-drama', title: 'He Broke Another Heart' }, { ...details.drama, id: SLUG, title: 'He Broke the Heart That Saved Him!' }] })
    }
    return route.fallback()
  })
  await page.addInitScript(
    ({ id, title }) => {
      if (localStorage.getItem('naijatr:dramaHistory')) return
      localStorage.setItem(
        'naijatr:dramaHistory',
        JSON.stringify([{ id: `dramabox:${id}`, provider: 'dramabox', dramaId: id, title, poster: null, episode: 3, episodeId: '701', position: 8, duration: 90, episodeCount: 52, viewedAt: Date.now() }]),
      )
    },
    { id: DRAMA_ID, title: TITLE },
  )

  await page.goto('/')
  await page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click({ timeout: 6000 }).catch(() => {})
  const resume = page.getByRole('region', { name: 'Your short dramas' }).getByRole('link', { name: /^Continue Ep 3 · 0:08/ })
  await press(resume, mobile)
  for (const other of context.pages()) if (other !== page) await other.close()

  // Under the new id, in the player at episode 3, 0:08.
  await page.waitForURL((url) => url.pathname === `/dramas/dramabox/${SLUG}` && url.searchParams.get('ep') === 'ep3', { timeout: 20_000 })
  expect(searched).toEqual([TITLE])
  await expect(page.getByRole('dialog', { name: `${TITLE}, episode 3` })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLVideoElement>('.dr-player__video')?.currentTime ?? -1), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(7.5)
  // "Your short dramas" has it once, under the new id.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('naijatr:dramaHistory') ?? '[]') as { id: string; episode: number }[])
  expect(saved.map((e) => e.id)).toEqual([`dramabox:${SLUG}`])
  expect(saved[0].episode).toBe(3)
})
