import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { adClock } from './ads/adManager'
import { adTiming } from './ads/directLink'
import { analyticsBeforeSend } from './analytics'
import App from './App'
import { MediaImage } from './components/MediaImage'
import { createFallbackProvider } from './data/fallbackProvider'
import { createLocalProvider } from './data/localProvider'
import { CatalogProviderContext } from './data/provider'
import { AD_LINK, adLinkClicks } from './test/ads'
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

/** Debounced filters plus a debounced search can outlast waitFor's 1s default on a busy machine. */
const SLOW = { timeout: 5000 }

const primaryNav = () => screen.getByRole('navigation', { name: 'Primary' })

/** Poster buttons are labelled "View details for <title>, <Movie|Series>, <year>, ...". */
const posterButtons = () => screen.getAllByRole('button', { name: /^View details for / })

/** The filter options are hidden until the Filters button is clicked. */
async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Filters/ }))
  return screen.getByRole('group', { name: 'Genres' })
}

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

    // Close, Watch later, the Telegram card's Join Channel and the "Rate this" stars: Tab and Shift+Tab cycle through them.
    const later = within(dialog).getByRole('button', { name: 'Watch later' })
    const join = within(dialog).getByRole('link', { name: /Join Channel/ })
    const rate = within(dialog).getByRole('radiogroup', { name: 'Rate The Last Light of Orion' })
    await user.tab()
    expect(later).toHaveFocus()
    await user.tab()
    expect(join).toHaveFocus()
    await user.tab()
    expect(within(rate).getByRole('radio', { name: '1 star' })).toHaveFocus()
    for (let i = 0; i < 5; i += 1) await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(within(rate).getByRole('radio', { name: '5 stars' })).toHaveFocus()
    for (let i = 0; i < 5; i += 1) await user.tab({ shift: true })
    expect(join).toHaveFocus()
    await user.tab({ shift: true })
    expect(later).toHaveFocus()
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

describe('title ad', () => {
  it('opens the ad on the first click of each title, a minute apart at most, while the details still open', async () => {
    let now = Date.UTC(2026, 9, 27, 12)
    adClock.now = () => now
    const { user } = renderApp()
    await user.click(await screen.findByRole('button', { name: 'View Details' }))
    expect(adLinkClicks()).toEqual([AD_LINK])
    const dialog = screen.getByRole('dialog', { name: 'The Last Light of Orion' })

    // Clicks inside the details panel never open it.
    await user.click(within(dialog).getByRole('button', { name: 'Close details' }))
    expect(adLinkClicks()).toHaveLength(1)

    // Within a minute of the last ad: the details open, the ad waits.
    const series = screen.getByRole('region', { name: 'Popular Series' })
    const [first, second] = within(series).getAllByRole('button', { name: /^View details for / })
    await user.click(first)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(adLinkClicks()).toHaveLength(1)
    await user.keyboard('{Escape}')

    // A minute later, that title's next click opens it.
    now += 60_000
    await user.click(first)
    expect(adLinkClicks()).toHaveLength(2)
    await user.keyboard('{Escape}')

    // Once per title: the first title's card ad is used up.
    now += 60_000
    await user.click(screen.getByRole('button', { name: 'View Details' }))
    expect(adLinkClicks()).toHaveLength(2)
    await user.keyboard('{Escape}')
    await user.click(second)
    expect(adLinkClicks()).toEqual([AD_LINK, AD_LINK, AD_LINK])
    expect(window.open).not.toHaveBeenCalled()
  })

  it('skips the ad with ?noads=1 for the rest of the visit', async () => {
    window.history.replaceState(null, '', '/?noads=1')
    const { user } = renderApp()
    await user.click(await screen.findByRole('button', { name: 'View Details' }))
    await user.keyboard('{Escape}')
    window.history.replaceState(null, '', '/#/movies')
    const series = screen.getByRole('region', { name: 'Popular Series' })
    await user.click(within(series).getAllByRole('button', { name: /^View details for / })[0])
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(adLinkClicks()).toHaveLength(0)
  })

  it('shows a one-time ad break on the details page when the browser blocks the ad', async () => {
    adTiming.blockCheckMs = 20
    const { user } = renderApp()
    await user.click(await screen.findByRole('button', { name: 'View Details' }))
    const adBreak = await screen.findByRole('dialog', { name: 'Ads keep NAIJA TR free' })
    expect(within(adBreak).getByText(/Skip in 5s/)).toBeInTheDocument()
    expect(analyticsBeforeSend({ type: 'pageview', url: 'https://www.naijatr.com/#/movies' })?.url).toBe(
      'https://www.naijatr.com/movies?ad=blocked',
    )

    // Escape stays with the ad break: the details stay open underneath.
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'The Last Light of Orion' })).toBeInTheDocument()

    await user.click(within(adBreak).getByRole('button', { name: /Continue/ }))
    expect(adLinkClicks()).toEqual([AD_LINK, AD_LINK])
    expect(screen.queryByRole('dialog', { name: 'Ads keep NAIJA TR free' })).not.toBeInTheDocument()
    const details = screen.getByRole('dialog', { name: 'The Last Light of Orion' })
    expect(analyticsBeforeSend({ type: 'pageview', url: 'https://www.naijatr.com/' })?.url).toBe(
      'https://www.naijatr.com/?ad=fallback-continue',
    )

    // At most once per title.
    await user.click(within(details).getByRole('button', { name: 'Close details' }))
    await user.click(screen.getByRole('button', { name: 'View Details' }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(screen.queryByRole('dialog', { name: 'Ads keep NAIJA TR free' })).not.toBeInTheDocument()
  })

  it('shows no ad break when the ad tab took over the page', async () => {
    adTiming.blockCheckMs = 20
    // The new tab takes focus as the link is clicked.
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => fireEvent.blur(window))
    const { user } = renderApp()
    await user.click(await screen.findByRole('button', { name: 'View Details' }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(screen.queryByRole('dialog', { name: 'Ads keep NAIJA TR free' })).not.toBeInTheDocument()
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

  it('shows the filter options only while the Filters button is toggled on', async () => {
    const { user } = renderApp()
    await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
    const button = await screen.findByRole('button', { name: /^Filters/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'Genres' })).not.toBeInTheDocument()

    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('group', { name: 'Genres' })).toBeInTheDocument()

    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'Genres' })).not.toBeInTheDocument()
  })

  it('filters by genre, keeps filters in the URL, and removes them as chips', async () => {
    const { user } = renderApp()
    await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
    const genres = await openFilters(user)
    await waitFor(() => expect(posterButtons().length).toBe(16))

    await user.click(within(genres).getByRole('button', { name: 'Horror' }))
    expect(within(genres).getByRole('button', { name: 'Horror' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(posterButtons()).toHaveLength(2))
    const horrorTitles = posterButtons().map((b) => b.getAttribute('aria-label')).join()
    expect(horrorTitles).toMatch(/Hollow Ground/)
    expect(horrorTitles).toMatch(/Whispers in the Pines/)
    expect(screen.getByText('2 titles')).toBeInTheDocument()
    await waitFor(() => expect(window.location.search).toBe('?genre=horror'))
    expect(window.location.hash).toBe('#/movies')

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'oldest')
    await waitFor(() => expect(window.location.search).toBe('?genre=horror&sort=oldest'))

    const active = screen.getByRole('group', { name: 'Active filters' })
    await user.click(within(active).getByRole('button', { name: 'Remove filter: Horror' }))
    await waitFor(() => expect(posterButtons()).toHaveLength(16))
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument()
    await waitFor(() => expect(window.location.search).toBe('?sort=oldest'))
  })

  it('shows an empty state with Clear all when nothing matches', async () => {
    const { user } = renderApp()
    await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
    const genres = await openFilters(user)
    await user.click(within(genres).getByRole('button', { name: 'Horror' }))
    await user.click(within(genres).getByRole('button', { name: 'Comedy' }))

    const empty = await screen.findByRole('status')
    expect(empty).toHaveTextContent('No titles match')
    expect(empty).toHaveTextContent('Try removing a filter.')

    // Match any: Horror OR Comedy.
    await user.click(screen.getByRole('button', { name: 'Match any' }))
    await waitFor(() => expect(posterButtons().length).toBeGreaterThan(2))

    await user.click(within(screen.getByRole('group', { name: 'Active filters' })).getByRole('button', { name: 'Clear all' }))
    await waitFor(() => expect(posterButtons()).toHaveLength(16))
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('restores filters from a shared link and drops them on navigation', async () => {
    window.history.replaceState(null, '', '/?genre=mystery&type=both#/movies')
    const { user } = renderApp()
    expect(await screen.findByRole('heading', { level: 1, name: 'Movies & Series' })).toBeInTheDocument()
    // Applied filters show as chips, but the options stay hidden until asked for.
    expect(screen.queryByRole('group', { name: 'Genres' })).not.toBeInTheDocument()
    await openFilters(user)
    expect(within(screen.getByRole('group', { name: 'Genres' })).getByRole('button', { name: 'Mystery' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await waitFor(() => expect(posterButtons().length).toBeGreaterThan(0))
    const labels = posterButtons().map((b) => b.getAttribute('aria-label')!)
    expect(labels.some((l) => /, Series, /.test(l))).toBe(true)
    expect(labels.some((l) => /, Movie, /.test(l))).toBe(true)

    await user.click(within(primaryNav()).getByRole('button', { name: 'Series' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Series' })).toBeInTheDocument()
    expect(window.location.search).toBe('')
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument()
  })

  it('steps back through filter changes with the Back button', async () => {
    const { user } = renderApp()
    await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
    const genres = await openFilters(user)
    await user.click(within(genres).getByRole('button', { name: 'Horror' }))
    await waitFor(() => expect(window.location.search).toBe('?genre=horror'))

    window.history.back()
    await waitFor(() => expect(window.location.search).toBe(''))
    await waitFor(() =>
      expect(within(screen.getByRole('group', { name: 'Genres' })).getByRole('button', { name: 'Horror' })).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    )
    await waitFor(() => expect(posterButtons()).toHaveLength(16))
  })

  it('filters a text search when filters are active, and cards still open the ad', async () => {
    const { user } = renderApp()
    await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
    const genres = await openFilters(user)
    await user.click(within(genres).getByRole('button', { name: 'Horror' }))
    await waitFor(() => expect(posterButtons()).toHaveLength(2))

    await user.type(screen.getByRole('searchbox', { name: 'Search titles' }), 'hollow')
    expect(await screen.findByText(/matching your filters/)).toBeInTheDocument()
    await waitFor(() => expect(posterButtons()).toHaveLength(1))
    expect(posterButtons()[0]).toHaveAccessibleName(/^View details for Hollow Ground/)

    await user.click(posterButtons()[0])
    expect(adLinkClicks()).toHaveLength(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('uses a bottom sheet with a live count and Apply on mobile', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
    try {
      const { user } = renderApp()
      await user.click(within(primaryNav()).getByRole('button', { name: 'Movies' }))
      await waitFor(() => expect(posterButtons().length).toBe(16))
      expect(screen.queryByRole('group', { name: 'Genres' })).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Filters' }))
      const sheet = screen.getByRole('dialog', { name: 'Filters' })
      await user.click(within(within(sheet).getByRole('group', { name: 'Genres' })).getByRole('button', { name: 'Horror' }))
      const apply = await within(sheet).findByRole('button', { name: 'Show 2 titles' })
      // Nothing changes until Apply.
      expect(posterButtons()).toHaveLength(16)

      await user.click(apply)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      await waitFor(() => expect(posterButtons()).toHaveLength(2))
      for (const chip of within(screen.getByRole('group', { name: 'Active filters' })).getAllByRole('button')) {
        expect(chip.className).toMatch(/active-filters/)
      }
    } finally {
      window.matchMedia = original
    }
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
    expect(labels.some((l) => /, Movie, /.test(l))).toBe(true)
    expect(labels.join()).toMatch(/Velvet Hour/)
  })

  it('filters a search started from Home, keeping Home in the URL', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Trending Now' })
    // No filter controls on Home itself.
    expect(screen.queryByRole('button', { name: /^Filters/ })).not.toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search titles' }), 'drama')
    expect(await screen.findByRole('heading', { name: /Results for/ })).toHaveTextContent('drama')
    await waitFor(() => expect(posterButtons().length).toBeGreaterThan(0), SLOW)
    const labels = () => posterButtons().map((b) => b.getAttribute('aria-label')!)
    expect(labels().some((l) => /, Movie, /.test(l))).toBe(true)
    expect(labels().some((l) => /, Series, /.test(l))).toBe(true)

    const genres = await openFilters(user)
    const types = screen.getByRole('group', { name: 'Type' })
    expect(within(types).getByRole('button', { name: 'Both' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(types).getByRole('button', { name: 'Series' }))
    await waitFor(() => expect(labels().length > 0 && labels().every((l) => /, Series, /.test(l))).toBe(true), SLOW)
    await waitFor(() => expect(window.location.search).toBe('?type=series'), SLOW)
    expect(window.location.hash).toBe('')

    await user.click(within(genres).getByRole('button', { name: 'Horror' }))
    const empty = await screen.findByRole('status', {}, SLOW)
    expect(empty).toHaveTextContent('No titles match')
    await user.click(within(empty).getByRole('button', { name: 'Clear all filters' }))
    // Back to the plain search, which waits out its own debounce.
    await waitFor(() => expect(labels().some((l) => /, Movie, /.test(l))).toBe(true), SLOW)
  }, 15_000)

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
      discover: async () => {
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

describe('watch later', () => {
  it('saves a title from its details, lists it on the home page, and unsaves it', async () => {
    const { user } = renderApp()
    await user.click(await screen.findByRole('button', { name: 'View Details' }))
    const dialog = screen.getByRole('dialog', { name: 'The Last Light of Orion' })
    await user.click(within(dialog).getByRole('button', { name: 'Watch later' }))
    const saved = within(dialog).getByRole('button', { name: 'Saved to Watch later' })
    expect(saved).toHaveAttribute('aria-pressed', 'true')
    expect(JSON.parse(window.localStorage.getItem('naijatr:watchLater')!)).toMatchObject([{ item: { title: 'The Last Light of Orion' } }])
    await user.keyboard('{Escape}')
    const row = await screen.findByRole('region', { name: /Watch later/ })
    expect(within(row).getByText('The Last Light of Orion')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Saved to Watch later' })[0])
    expect(screen.queryByRole('region', { name: /Watch later/ })).not.toBeInTheDocument()
  })
})
