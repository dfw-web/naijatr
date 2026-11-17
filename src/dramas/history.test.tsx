import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installQuietZones } from '../ads/adManager'
import { DramaHistoryRow } from '../components/DramaHistoryRow'
import { EpisodePicker } from './EpisodePicker'
import {
  DRAMA_HISTORY_KEY,
  episodeProgress,
  readDramaHistory,
  recordDramaView,
  removeDramaEntry,
  resetDramaHistory,
  setDramaEpisode,
} from './history'
import { officialDramaUrl, titleSlug } from './officialLinks'

const view = (dramaId: string, over: Partial<Parameters<typeof recordDramaView>[0]> = {}) => ({
  provider: 'dramabox',
  dramaId,
  title: `Drama ${dramaId}`,
  poster: `https://img.example/${dramaId}.jpg`,
  episodeCount: 80,
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  resetDramaHistory()
})

describe('short drama history', () => {
  it('keeps each drama once, newest first, at most 20', () => {
    for (let i = 1; i <= 22; i++) recordDramaView(view(String(i)), i)
    recordDramaView(view('5'), 100)
    const list = readDramaHistory()
    expect(list).toHaveLength(20)
    expect(list[0].id).toBe('dramabox:5')
    expect(list.map((e) => e.id)).not.toContain('dramabox:1')
    expect(list.filter((e) => e.id === 'dramabox:5')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(DRAMA_HISTORY_KEY)!)).toHaveLength(20)
  })

  it('saves the episode the viewer is on, inside the drama, and keeps it on the next visit', () => {
    recordDramaView(view('1'), 1)
    recordDramaView(view('2'), 2)
    setDramaEpisode('dramabox:1', 12, 3)
    // Setting the episode makes it the newest.
    expect(readDramaHistory()[0]).toMatchObject({ id: 'dramabox:1', episode: 12, viewedAt: 3 })
    setDramaEpisode('dramabox:1', 500)
    expect(readDramaHistory()[0].episode).toBe(80)
    setDramaEpisode('dramabox:1', 0)
    expect(readDramaHistory()[0].episode).toBe(1)
    setDramaEpisode('dramabox:1', 7)
    // Opened again (no poster this time): the episode and poster stay.
    recordDramaView(view('1', { poster: null }), 10)
    expect(readDramaHistory()[0]).toMatchObject({ episode: 7, poster: 'https://img.example/1.jpg', viewedAt: 10 })
    setDramaEpisode('dramabox:1', null)
    expect(readDramaHistory()[0].episode).toBeNull()
  })

  it('labels the episode', () => {
    expect(episodeProgress({ episode: 12, episodeCount: 80 })).toBe('Episode 12 of 80')
    expect(episodeProgress({ episode: 12, episodeCount: null })).toBe('Episode 12')
    expect(episodeProgress({ episode: null, episodeCount: 80 })).toBeNull()
  })

  it('ignores broken storage', () => {
    localStorage.setItem(DRAMA_HISTORY_KEY, '{not json')
    expect(readDramaHistory()).toEqual([])
    localStorage.setItem(DRAMA_HISTORY_KEY, JSON.stringify([{ id: 'x' }, { ...view('1'), id: 'dramabox:1', episode: -3, viewedAt: 1 }]))
    expect(readDramaHistory()).toEqual([])
  })
})

describe('official links', () => {
  it('opens the drama on its app’s own site', () => {
    expect(officialDramaUrl({ provider: 'dramabox', dramaId: '42000023802', title: 'He Broke the Heart That Saved Him' })).toBe(
      'https://www.dramaboxdb.com/movie/42000023802',
    )
    expect(
      officialDramaUrl({ provider: 'netshort', dramaId: '2118996275277217793', title: 'Satan’s Daughter, Revenge With Demonic Might' }),
    ).toBe('https://www.netshort.com/episode/satans-daughter-revenge-with-demonic-might-2118996275277217793')
    expect(titleSlug('Shock！My Teacher Is a Crime Boss')).toBe('shockmy-teacher-is-a-crime-boss')
    expect(titleSlug('!!!')).toBe('drama')
  })

  it('finds DramaWave in the phone’s app store', () => {
    const entry = { provider: 'dramawave', dramaId: 'abc', title: 'X' }
    expect(officialDramaUrl(entry, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('https://apps.apple.com/us/iphone/search?term=DramaWave')
    expect(officialDramaUrl(entry, 'Mozilla/5.0 (Linux; Android 14)')).toBe('https://play.google.com/store/search?q=DramaWave&c=apps')
  })
})

describe('Your short dramas row', () => {
  it('is hidden until a drama has been opened', () => {
    const { container } = render(<DramaHistoryRow />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows each drama with its episode and a link to carry on in its app', () => {
    recordDramaView(view('42000023802', { title: 'He Broke the Heart That Saved Him' }), 1)
    recordDramaView(view('2118996275277217793', { provider: 'netshort', title: 'When Housewives Turn Deadly', episodeCount: null }), 2)
    setDramaEpisode('dramabox:42000023802', 12, 3)
    render(<DramaHistoryRow />)
    const row = screen.getByRole('region', { name: 'Your short dramas' })
    const cards = within(row).getAllByRole('article')
    expect(cards).toHaveLength(2)
    // Newest first: the episode was just set.
    expect(within(cards[0]).getByRole('heading')).toHaveTextContent('He Broke the Heart That Saved Him')
    expect(within(cards[0]).getByText('Episode 12 of 80')).toBeInTheDocument()
    expect(within(cards[0]).getByRole('link', { name: 'Continue on DramaBox' })).toHaveAttribute('href', 'https://www.dramaboxdb.com/movie/42000023802')
    expect(within(cards[0]).getByRole('link', { name: 'Continue on DramaBox' })).toHaveAttribute('target', '_blank')
    expect(within(cards[0]).getByRole('link', { name: /He Broke the Heart/ })).toHaveAttribute('href', '/dramas/dramabox/42000023802')
    // No episode set: no episode line.
    expect(within(cards[1]).queryByText(/^Episode/)).toBeNull()
    expect(within(cards[1]).getByRole('link', { name: 'Continue on NetShort' })).toHaveAttribute(
      'href',
      'https://www.netshort.com/episode/when-housewives-turn-deadly-2118996275277217793',
    )
  })

  it('removes a drama with its ✕, and the tap never reaches the ad script', async () => {
    recordDramaView(view('1'), 1)
    recordDramaView(view('2'), 2)
    const host = document.createElement('div')
    document.body.append(host)
    installQuietZones(host)
    const adScript = vi.fn()
    document.addEventListener('click', adScript)
    render(<DramaHistoryRow />, { container: host })
    await userEvent.click(screen.getByRole('button', { name: 'Remove Drama 2 from Your short dramas' }))
    expect(readDramaHistory().map((e) => e.id)).toEqual(['dramabox:1'])
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(adScript).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Remove Drama 1/ }))
    expect(screen.queryByRole('region', { name: 'Your short dramas' })).toBeNull()
    document.removeEventListener('click', adScript)
    host.remove()
  })

  it('updates when another tab opens a drama', () => {
    render(<DramaHistoryRow />)
    act(() => {
      recordDramaView(view('9'))
      window.dispatchEvent(new StorageEvent('storage', { key: DRAMA_HISTORY_KEY }))
    })
    expect(screen.getByRole('heading', { name: 'Drama 9' })).toBeInTheDocument()
  })
})

describe('episode picker', () => {
  afterEach(() => removeDramaEntry('dramabox:1'))

  it('sets the episode with − / + and typing, inside the drama, without ads', async () => {
    recordDramaView(view('1', { episodeCount: 3 }))
    const host = document.createElement('div')
    document.body.append(host)
    installQuietZones(host)
    const adScript = vi.fn()
    document.addEventListener('click', adScript)
    render(<EpisodePicker entryId="dramabox:1" />, { container: host })
    const input = screen.getByRole('spinbutton', { name: 'I’m on episode' })
    const minus = screen.getByRole('button', { name: 'Previous episode' })
    const plus = screen.getByRole('button', { name: 'Next episode' })
    expect(input).toHaveValue(null)
    expect(minus).toBeDisabled()
    await userEvent.click(plus)
    expect(input).toHaveValue(1)
    await userEvent.click(plus)
    await userEvent.click(plus)
    expect(input).toHaveValue(3)
    expect(plus).toBeDisabled()
    await userEvent.click(minus)
    expect(readDramaHistory()[0].episode).toBe(2)
    await userEvent.clear(input)
    expect(readDramaHistory()[0].episode).toBeNull()
    await userEvent.type(input, '9')
    // Past the end: kept at the last episode.
    expect(readDramaHistory()[0].episode).toBe(3)
    expect(screen.getByText('of 3')).toBeInTheDocument()
    expect(adScript).not.toHaveBeenCalled()
    document.removeEventListener('click', adScript)
    host.remove()
  })

  it('shows nothing before the drama is in the history', () => {
    const { container } = render(<EpisodePicker entryId="dramabox:404" />)
    expect(container).toBeEmptyDOMElement()
  })
})
