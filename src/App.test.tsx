import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'
import { MediaImage } from './components/MediaImage'
import { createFallbackProvider } from './data/fallbackProvider'
import { createLocalProvider } from './data/localProvider'
import { CatalogProviderContext } from './data/provider'
import type { CatalogProvider } from './types/media'

const fastProvider = createLocalProvider({ latencyMs: 0 })

function renderApp(provider: CatalogProvider = fastProvider) {
  const user = userEvent.setup()
  render(
    <CatalogProviderContext.Provider value={provider}>
      <App />
    </CatalogProviderContext.Provider>,
  )
  return { user }
}

const primaryNav = () => screen.getByRole('navigation', { name: 'Primary' })

/** Poster buttons are labelled "View details for <title>, <Movie|Series>, <year>, ...". */
const posterButtons = () => screen.getAllByRole('button', { name: /^View details for / })

describe('homepage', () => {
  it('shows skeletons, then the hero and all four sections', async () => {
    renderApp(createLocalProvider({ latencyMs: 50 }))
    expect(screen.getByLabelText('Loading featured title')).toBeInTheDocument()

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'The Last Light of Orion',
    )
    for (const title of ['Trending Now', 'Popular Movies', 'Popular Series', 'New & Recent']) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument()
    }
    const watchFree = screen.getByRole('region', { name: 'Watch Free' })
    expect(
      within(watchFree).getByRole('button', { name: /^View details for Big Buck Bunny/ }),
    ).toBeInTheDocument()
    const popularMovies = screen.getByRole('region', { name: 'Popular Movies' })
    const cards = within(popularMovies).getAllByRole('button', { name: /^View details for / })
    expect(cards.every((card) => /, Movie, /.test(card.getAttribute('aria-label')!))).toBe(true)
  })

  it('shows an error state with a working retry', async () => {
    let calls = 0
    const flaky: CatalogProvider = {
      ...fastProvider,
      getHome: async (signal) => {
        calls += 1
        if (calls === 1) throw new Error('Network is down')
        return fastProvider.getHome(signal)
      },
    }
    const { user } = renderApp(flaky)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('We couldn’t load the catalogue')
    expect(alert).toHaveTextContent('Network is down')

    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Trending Now' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('details panel', () => {
  it('opens from View Details, traps focus, and closes with Escape returning focus', async () => {
    const { user } = renderApp()
    const viewDetails = await screen.findByRole('button', { name: 'View Details' })
    await user.click(viewDetails)

    const dialog = screen.getByRole('dialog', { name: 'The Last Light of Orion' })
    const close = within(dialog).getByRole('button', { name: 'Close details' })
    expect(close).toHaveFocus()
    expect(dialog).toHaveTextContent('8.7 / 10')
    expect(dialog).toHaveTextContent('21 November 2025')

    // Only one focusable element: Tab and Shift+Tab must stay on it.
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(close).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(viewDetails).toHaveFocus()
  })

  it('opens from a poster card and closes via the close button and the backdrop', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Popular Series' })
    const series = screen.getByRole('region', { name: 'Popular Series' })
    const [firstCard] = await within(series).findAllByRole('button', { name: /^View details for / })

    await user.click(firstCard)
    await user.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(firstCard)
    const backdrop = screen.getByRole('dialog').parentElement!
    await user.click(backdrop)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('Movies and Series navigation', () => {
  it('Movies shows only movies, Series shows only series, and updates the URL', async () => {
    const { user } = renderApp()

    await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Movies' })).toBeInTheDocument()
    await waitFor(() => expect(posterButtons().length).toBe(16))
    expect(posterButtons().every((b) => /, Movie, /.test(b.getAttribute('aria-label')!))).toBe(true)
    expect(window.location.hash).toBe('#/movies')
    expect(within(primaryNav()).getByRole('button', { name: 'Movies' })).toHaveAttribute(
      'aria-current',
      'page',
    )

    await user.click(within(primaryNav()).getByRole('button', { name: 'Series' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Series' })).toBeInTheDocument()
    await waitFor(() => expect(posterButtons().length).toBe(16))
    expect(posterButtons().every((b) => /, Series, /.test(b.getAttribute('aria-label')!))).toBe(true)
    expect(window.location.hash).toBe('#/series')
  })

  it('filters by genre and sorts', async () => {
    const { user } = renderApp()
    await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
    const genres = await screen.findByRole('group', { name: 'Filter by genre' })
    await waitFor(() => expect(posterButtons().length).toBe(16))

    await user.click(within(genres).getByRole('button', { name: 'Horror' }))
    expect(within(genres).getByRole('button', { name: 'Horror' })).toHaveAttribute('aria-pressed', 'true')
    const horrorTitles = posterButtons().map((b) => b.getAttribute('aria-label'))
    expect(horrorTitles).toHaveLength(2)
    expect(horrorTitles.join()).toMatch(/Hollow Ground/)
    expect(horrorTitles.join()).toMatch(/Whispers in the Pines/)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'title')
    expect(posterButtons()[0]).toHaveAccessibleName(/^View details for Hollow Ground/)

    await user.click(within(genres).getByRole('button', { name: 'All' }))
    expect(posterButtons()).toHaveLength(16)
  })

  it('opens the right view from a deep link', async () => {
    window.history.replaceState(null, '', '/#/series')
    renderApp()
    expect(await screen.findByRole('heading', { level: 1, name: 'Series' })).toBeInTheDocument()
  })
})

describe('search', () => {
  it('finds titles by genre across movies and series', async () => {
    const { user } = renderApp()
    await user.type(screen.getByRole('searchbox', { name: 'Search titles' }), 'mystery')

    expect(await screen.findByRole('heading', { name: /Results for/ })).toHaveTextContent('mystery')
    await waitFor(() => expect(screen.getByText(/^\d+ titles?$/)).toBeInTheDocument())
    const labels = posterButtons().map((b) => b.getAttribute('aria-label')!)
    expect(labels.some((l) => /, Movie, /.test(l))).toBe(true)
    expect(labels.some((l) => /, Series, /.test(l))).toBe(true)
    expect(labels.join()).toMatch(/Velvet Hour/)
  })

  it('shows an empty state that can clear the search', async () => {
    const { user } = renderApp()
    const input = screen.getByRole('searchbox', { name: 'Search titles' })
    await user.type(input, 'zzzz nothing')

    const empty = await screen.findByRole('status')
    expect(empty).toHaveTextContent('No titles match your search')
    await user.click(within(empty).getByRole('button', { name: 'Clear search' }))
    expect(input).toHaveValue('')
    expect(await screen.findByRole('heading', { name: 'Trending Now' })).toBeInTheDocument()
  })

  it('shows an error state when search fails', async () => {
    const failing: CatalogProvider = {
      ...fastProvider,
      search: async () => {
        throw new Error('Search service timed out')
      },
    }
    const { user } = renderApp(failing)
    await user.type(screen.getByRole('searchbox', { name: 'Search titles' }), 'orion')
    expect(await screen.findByRole('alert')).toHaveTextContent('Search service timed out')
  })

  it('clears the search when a nav link is used', async () => {
    const { user } = renderApp()
    const input = screen.getByRole('searchbox', { name: 'Search titles' })
    await user.type(input, 'drama')
    await screen.findByRole('heading', { name: /Results for/ })

    await user.click(within(primaryNav()).getByRole('button', { name: 'Series' }))
    expect(input).toHaveValue('')
    expect(await screen.findByRole('heading', { level: 1, name: 'Series' })).toBeInTheDocument()
  })
})

describe('image fallbacks', () => {
  it('shows designed fallback artwork when an image fails to load', () => {
    render(<MediaImage src="https://example.invalid/x.jpg" alt="" fallbackTitle="Broken Poster" />)
    expect(screen.queryByTestId('image-fallback')).not.toBeInTheDocument()

    fireEvent.error(document.querySelector('img')!)
    expect(screen.getByTestId('image-fallback')).toHaveTextContent('Broken Poster')
    expect(screen.getByTestId('image-fallback')).toHaveTextContent('Artwork unavailable')
  })

  it('shows the fallback straight away when a title has no artwork', async () => {
    const { user } = renderApp()
    await user.click(within(primaryNav()).getByRole('button', { name: 'Series' }))
    const card = await screen.findByRole('button', { name: /The Tidewater Saga, Series, TBA, not yet rated/ })
    expect(within(card).getByTestId('image-fallback')).toHaveTextContent('The Tidewater Saga')
    expect(within(card).getByText('Not rated')).toBeInTheDocument()
  })
})

describe('TMDB upgrade features', () => {
  it('shows Trending Now as a ranked top 10', async () => {
    renderApp()
    const trending = await screen.findByRole('region', { name: 'Trending Now' })
    expect(within(trending).getByText('Top 10 this week')).toBeInTheDocument()
    const cards = await within(trending).findAllByRole('button', { name: /^View details for / })
    expect(cards).toHaveLength(10)
    expect(cards[0]).toHaveAccessibleName(/number 1 in Trending Now$/)
    expect(cards[9]).toHaveAccessibleName(/number 10 in Trending Now$/)
  })

  it('loads extra details (cast, director, tagline) into the panel', async () => {
    const enriching: CatalogProvider = {
      ...fastProvider,
      getDetails: async (item) => ({
        ...item,
        tagline: 'Every signal fades.',
        makers: ['Ava Director'],
        cast: ['Lead Actor', 'Second Lead'],
        status: 'Post Production',
      }),
    }
    const { user } = renderApp(enriching)
    await user.click(await screen.findByRole('button', { name: 'View Details' }))
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText('Every signal fades.')).toBeInTheDocument()
    expect(within(dialog).getByText('Ava Director')).toBeInTheDocument()
    expect(within(dialog).getByText('Lead Actor, Second Lead')).toBeInTheDocument()
    expect(within(dialog).getByText('Post Production')).toBeInTheDocument()
  })

  it('keeps the panel usable when extra details fail to load', async () => {
    const broken: CatalogProvider = {
      ...fastProvider,
      getDetails: async () => {
        throw new Error('details down')
      },
    }
    const { user } = renderApp(broken)
    await user.click(await screen.findByRole('button', { name: 'View Details' }))
    const dialog = screen.getByRole('dialog', { name: 'The Last Light of Orion' })
    expect(await within(dialog).findByText(/extra details couldn’t be loaded/)).toBeInTheDocument()
    expect(dialog).toHaveTextContent('8.7 / 10')
  })

  it('falls back to sample titles with a notice when TMDB is unavailable', async () => {
    const down: CatalogProvider = {
      name: 'TMDB',
      getHome: async () => {
        throw new Error('TMDB request failed (503).')
      },
      getByType: async () => {
        throw new Error('TMDB request failed (503).')
      },
      search: async () => {
        throw new Error('TMDB request failed (503).')
      },
      getDetails: async (item) => item,
    }
    const { user } = renderApp(createFallbackProvider(down, fastProvider))

    expect(await screen.findByRole('heading', { name: 'Trending Now' })).toBeInTheDocument()
    const notice = (await screen.findByText(/Live catalogue unavailable/)).closest('[role=status]')
    expect(notice).toHaveTextContent('Showing sample titles instead. TMDB request failed (503).')

    // Movies still works from the fallback.
    await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
    await waitFor(() => expect(posterButtons().length).toBe(16))

    await user.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(screen.queryByText(/Live catalogue unavailable/)).not.toBeInTheDocument()
  })
})
