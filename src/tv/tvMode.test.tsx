import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openAd } from '../ads/directLink'
import { analyticsBeforeSend } from '../analytics'
import { PlayerPanel } from '../components/PlayerPanel'
import type { MediaItem } from '../types/media'
import { readContinueWatching } from '../utils/continueWatching'
import { goBack } from './remote'
import { TvAdBreakHost } from './TvAdBreak'
import { playAfterAdBreak } from './tvAdBreakStore'
import { phoneLink } from './tvMode'

const tvOn = () => document.documentElement.classList.add('tv-mode')

/** Runs the ad break's countdown, one second (and one render) at a time. */
const countDown = () => {
  for (let i = 0; i < 5; i += 1) act(() => vi.advanceTimersByTime(1000))
}

const film: MediaItem = {
  id: 'tmdb-movie-550',
  tmdbId: 550,
  title: 'Fight Club',
  type: 'movie',
  year: 1999,
  releaseDate: '1999-10-15',
  genres: [],
  score: 8.4,
  voteCount: 1000,
  popularity: 1,
  description: '',
  poster: null,
  backdrop: null,
}

describe('TV ad break', () => {
  beforeEach(tvOn)

  it('shows once per title before playback, counts down, then Continue plays', () => {
    vi.useFakeTimers()
    const action = vi.fn()
    render(<TvAdBreakHost />)
    act(() => playAfterAdBreak('title:a', action, phoneLink(film)))
    expect(screen.getByRole('dialog', { name: 'Ad break' })).toBeInTheDocument()
    expect(screen.getByText('Your video starts in 5…')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /watch this on your phone/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue/ })).not.toBeInTheDocument()

    countDown()
    const next = screen.getByRole('button', { name: /Continue/ })
    expect(next).toHaveFocus()
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(next)
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // The same title again plays straight away; another title gets its own break.
    act(() => playAfterAdBreak('title:a', action))
    expect(action).toHaveBeenCalledTimes(2)
    act(() => playAfterAdBreak('title:b', action))
    expect(screen.getByRole('dialog', { name: 'Ad break' })).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('closes with Back without playing, so the remote is never stuck', () => {
    const action = vi.fn()
    render(<TvAdBreakHost />)
    act(() => playAfterAdBreak('title:c', action))
    act(() => {
      expect(goBack()).toBe(true)
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(action).not.toHaveBeenCalled()
  })

  it('plays straight away off TV', () => {
    document.documentElement.classList.remove('tv-mode')
    const action = vi.fn()
    render(<TvAdBreakHost />)
    act(() => playAfterAdBreak('title:d', action))
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('TV mode', () => {
  beforeEach(tvOn)

  it('never tries to open the new-tab ad', () => {
    expect(openAd(new MouseEvent('click'), 'title:x')).toBe(false)
  })

  it('tags analytics events with device=tv', () => {
    const event = analyticsBeforeSend({ type: 'pageview', url: 'https://www.naijatr.com/#/movies' })
    expect(event?.url).toBe('https://www.naijatr.com/movies?device=tv')
  })

  it('links QR codes to the title on naijatr.com, tagged as TV traffic', () => {
    expect(phoneLink(film)).toBe('https://www.naijatr.com/?title=movie-550&utm_source=tv_qr')
  })

  it('shows the ad break before the first Play, then plays and remembers the title', async () => {
    // This TV already went through the Telegram gate (src/gate), which comes before the ad break.
    localStorage.setItem('naijatr.gate.tv', '1')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ available: true }))) as unknown as typeof fetch
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <>
        <PlayerPanel item={film} availability={{ movie: true, tv: true }} fetchImpl={fetchImpl} />
        <TvAdBreakHost />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('dialog', { name: 'Ad break' })).toBeInTheDocument()
    expect(screen.queryByTitle('Fight Club player')).not.toBeInTheDocument()
    countDown()
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await screen.findByTitle('Fight Club player')).toBeInTheDocument()
    expect(readContinueWatching().map((t) => t.title)).toEqual(['Fight Club'])
    vi.useRealTimers()
  })
})
