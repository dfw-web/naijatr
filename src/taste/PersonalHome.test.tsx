import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../components/HomeView'
import { createLocalProvider } from '../data/localProvider'
import { CatalogProviderContext } from '../data/provider'
import type { CatalogProvider, MediaItem } from '../types/media'
import { readTaste, recordTaste, TASTE_KEY } from './profile'

const anime = (n: number): MediaItem => ({
  id: `tmdb-series-${n}`,
  tmdbId: n,
  title: `Anime ${n}`,
  type: 'series',
  year: 2024,
  releaseDate: null,
  genres: ['Animation'],
  genreIds: [16],
  originCountry: ['JP'],
  originalLanguage: 'ja',
  score: 8,
  voteCount: 500,
  popularity: 100 - n,
  description: '',
  poster: null,
  backdrop: null,
})

function renderHome(listTmdb: CatalogProvider['listTmdb']) {
  const provider: CatalogProvider = { ...createLocalProvider({ latencyMs: 0 }), listTmdb }
  return render(
    <CatalogProviderContext.Provider value={provider}>
      <HomeView onSelect={() => {}} onBrowseTrending={() => {}} />
    </CatalogProviderContext.Provider>,
  )
}

afterEach(() => window.localStorage.clear())

describe('personal home', () => {
  it('shows the default home and the picker on a first visit', async () => {
    const listTmdb = vi.fn(async () => [])
    renderHome(listTmdb)
    expect(await screen.findByRole('region', { name: 'Trending Now' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'What do you like?' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Picked for you' })).not.toBeInTheDocument()
    expect(listTmdb).not.toHaveBeenCalled()
  })

  it('a pick personalises the home at once', async () => {
    const user = userEvent.setup()
    renderHome(vi.fn(async () => [anime(1), anime(2)]))
    await user.click(screen.getByRole('button', { name: 'Anime' }))
    await user.click(screen.getByRole('button', { name: 'Show my picks' }))
    const picked = await screen.findByRole('region', { name: 'Picked for you' })
    expect(await within(picked).findByRole('button', { name: /View details for Anime 1,/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'What do you like?' })).not.toBeInTheDocument()
  })

  it('puts personal rows first, with no title twice and nothing watched', async () => {
    // Watched Anime 1 three times over.
    for (let i = 0; i < 3; i += 1) {
      recordTaste(anime(1), 'play')
      recordTaste(anime(1), 'watched')
    }
    renderHome(vi.fn(async () => [anime(1), anime(2), anime(3), anime(4)]))
    const rows = await screen.findAllByRole('region')
    await screen.findAllByRole('button', { name: /Anime 2/ })
    const titles = rows.map((r) => document.getElementById(r.getAttribute('aria-labelledby') ?? '')?.textContent ?? r.getAttribute('aria-label'))
    expect(titles.indexOf('Trending Now')).toBeGreaterThan(titles.findIndex((t) => /Anime 1$/.test(t ?? '')))
    // Each anime shows once on the whole screen, and Anime 1 (watched) not at all.
    for (const n of [2, 3, 4]) expect(screen.getAllByRole('button', { name: new RegExp(`Anime ${n},`) })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /View details for Anime 1,/ })).not.toBeInTheDocument()
  })

  it('"Not interested" hides the title and counts against its kind', async () => {
    const user = userEvent.setup()
    for (let i = 0; i < 2; i += 1) recordTaste(anime(1), 'watched')
    renderHome(vi.fn(async () => [anime(2), anime(3)]))
    await user.click(await screen.findByRole('button', { name: 'More options for Anime 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Not interested' }))
    expect(screen.queryByRole('button', { name: /View details for Anime 2,/ })).not.toBeInTheDocument()
    expect(readTaste().hidden).toEqual(['tmdb-series-2'])
    // 10 from watching twice, less 5.
    expect(JSON.parse(window.localStorage.getItem(TASTE_KEY)!).attrs['cat:anime'].s).toBeCloseTo(5)
  })
})
