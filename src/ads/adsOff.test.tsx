import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { adLinkClicks } from '../test/ads'

// The master switch off (VITE_ADS_ENABLED=false; the other tests have ads on).
// setup.ts has already loaded the ad modules, so load fresh copies that see the mock.
vi.resetModules()
vi.doMock('../config/ads', async (original) => ({
  ...(await original<typeof import('../config/ads')>()),
  ADS_ENABLED: false,
}))
const { cardAd, playbackAd, searchAd } = await import('./adManager')
const { TvAdBreakHost } = await import('../tv/TvAdBreak')
const { playAfterAdBreak } = await import('../tv/tvAdBreakStore')
const { adsDisabled, openAd, openAdFromAdBreak } = await import('./directLink')
const { loadMultitag } = await import('./monetag')
const { ADS_ENABLED } = await import('../config/ads')

describe('with ADS_ENABLED false', () => {
  beforeAll(() => expect(ADS_ENABLED).toBe(false))

  it('loads no Monetag tag', () => {
    expect(loadMultitag()).toBe(false)
    expect(document.querySelector('script[data-zone]')).toBeNull()
  })

  it('never opens the direct-link ad', async () => {
    expect(adsDisabled()).toBe(true)
    expect(openAd(new MouseEvent('click'), 'title:movie:550')).toBe(false)
    openAdFromAdBreak()
    const onClick = vi.fn(() => {
      cardAd(undefined, { id: 'movie-550' })
      playbackAd('title:movie-550')
      playbackAd('match:1')
      searchAd(undefined)
    })
    render(
      <button type="button" onClick={onClick}>
        Tap
      </button>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Tap' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(adLinkClicks()).toHaveLength(0)
    expect(window.open).not.toHaveBeenCalled()
  })

  it('plays straight away on TVs, with no ad break', () => {
    document.documentElement.classList.add('tv-mode')
    const action = vi.fn()
    render(<TvAdBreakHost />)
    act(() => playAfterAdBreak('title:a', action))
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
