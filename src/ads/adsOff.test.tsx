import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SyntheticEvent } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { adLinkClicks } from '../test/ads'

// The site as deployed today: the master switch off (the other tests turn ads on).
// setup.ts has already loaded the ad modules, so load fresh copies that see the mock.
vi.resetModules()
vi.doMock('../config/ads', async (original) => ({
  ...(await original<typeof import('../config/ads')>()),
  ADS_ENABLED: false,
}))
const { useAdOnce } = await import('../hooks/useAdOnce')
const { useAdTwice } = await import('../hooks/useAdTwice')
const { TvAdBreakHost } = await import('../tv/TvAdBreak')
const { playAfterAdBreak } = await import('../tv/tvAdBreakStore')
const { adsDisabled, openAd, openAdFromAdBreak } = await import('./directLink')
const { loadMonetagTags } = await import('./monetag')
const { ADS_ENABLED } = await import('../config/ads')

const film = { type: 'movie', id: '550' } as const

function Card({ onSelect }: { onSelect: () => void }) {
  const ad = useAdOnce()
  return (
    <button
      type="button"
      onClick={(event: SyntheticEvent) => {
        ad(event, film)
        onSelect()
      }}
    >
      Card
    </button>
  )
}

function Tabs({ onTab }: { onTab: () => void }) {
  const onClickCapture = useAdTwice('match:1')
  return (
    <div role="tablist" onClickCapture={onClickCapture}>
      <button type="button" role="tab" onClick={onTab}>
        Watch
      </button>
    </div>
  )
}

describe('with ADS_ENABLED false', () => {
  beforeAll(() => expect(ADS_ENABLED).toBe(false))

  it('loads no Monetag tags', () => {
    const before = document.scripts.length
    loadMonetagTags()
    expect(document.scripts.length).toBe(before)
    expect(document.querySelector('script[data-zone]')).toBeNull()
  })

  it('never opens the direct-link ad', () => {
    expect(adsDisabled()).toBe(true)
    expect(openAd(new MouseEvent('click'), 'title:movie:550')).toBe(false)
    openAdFromAdBreak()
    expect(adLinkClicks()).toHaveLength(0)
    expect(window.open).not.toHaveBeenCalled()
  })

  it('cards open their details with no ad', async () => {
    const onSelect = vi.fn()
    render(<Card onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Card' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(adLinkClicks()).toHaveLength(0)
  })

  it('match tabs switch on the first click with no ad', async () => {
    const onTab = vi.fn()
    render(<Tabs onTab={onTab} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Watch' }))
    expect(onTab).toHaveBeenCalledTimes(1)
    expect(adLinkClicks()).toHaveLength(0)
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
