import { useCallback, useEffect, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { AdsBackNotice } from './ads/AdsBackNotice'
import { rememberNoAdsFlag } from './ads/directLink'
import { useMultitag } from './ads/monetag'
import { AD_SECTIONS } from './config/ads'
import { analyticsBeforeSend } from './analytics'
import { BrowseView } from './components/BrowseView'
import { DetailsModal } from './components/DetailsModal'
import { FallbackNotice } from './components/FallbackNotice'
import { Footer } from './components/Footer'
import { HomeView } from './components/HomeView'
import { Navbar } from './components/Navbar'
import { SearchResults } from './components/SearchResults'
import { DEFAULT_FILTERS, hasNarrowingFilters } from './config/discoverFilters'
import { useFilterParams } from './hooks/useFilterParams'
import { TvAdBreakHost } from './tv/TvAdBreak'
import { TelegramGateHost } from './gate/TelegramGate'
import { InstallAppHost } from './components/InstallApp'
import { FeedbackHost } from './feedback/Feedback'
import { ContestHost } from './referral/Invite'
import { hashForView, NAV_LINKS, type NavLink, type View, viewFromHash } from './navigation'
import type { MediaItem } from './types/media'
import './App.css'

const TRENDING_LINK: NavLink = { ...NAV_LINKS[0], section: 'trending' }

/**
 * A title opened from a link (?title=movie-550 or ?title=series-1399, e.g. the
 * TV's "watch on your phone" QR code). Only the id is known; the details
 * panel fills in the rest.
 */
function titleFromUrl(search = window.location.search): MediaItem | null {
  const match = /^(movie|series)-([1-9]\d{0,9})$/.exec(new URLSearchParams(search).get('title') ?? '')
  if (!match) return null
  const type = match[1] as MediaItem['type']
  const tmdbId = Number(match[2])
  return {
    id: `tmdb-${type}-${tmdbId}`,
    tmdbId,
    type,
    title: '',
    year: null,
    releaseDate: null,
    genres: [],
    score: 0,
    voteCount: 0,
    popularity: 0,
    description: '',
    poster: null,
    backdrop: null,
  }
}

/** Drops the link's ?title= (and its tracking tag) once the panel closes, so a reload doesn't reopen it. */
function forgetTitleLink() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('title')) return
  url.searchParams.delete('title')
  url.searchParams.delete('utm_source')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
}

function App() {
  // Before useFilterParams rewrites the query string.
  useState(() => rememberNoAdsFlag())
  // The Monetag Multitag, once (after the ?noads= check above), while the movie section has ads.
  useMultitag(AD_SECTIONS.movies)
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash))
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MediaItem | null>(titleFromUrl)
  // Wrapped in an object so clicking the same link twice still scrolls.
  const [scrollRequest, setScrollRequest] = useState<{ section: string | null } | null>(null)
  // Bumped by "Try again" to remount the views, which re-runs every request.
  const [refreshKey, setRefreshKey] = useState(0)
  // Browse filters live in the query string (?genre=comedy&industry=nollywood#/movies).
  const { filters, committed, setFilters, reset: resetFilters } = useFilterParams()

  const isSearching = query.trim().length > 0
  // On a browse page with filters, a text search is filtered too (see BrowseView).
  const isFilteredSearch = isSearching && view !== 'home' && hasNarrowingFilters(filters)

  // Browser Back/Forward between views.
  useEffect(() => {
    const onPopState = () => {
      setView(viewFromHash(window.location.hash))
      setQuery('')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Scroll after render, so the target view/section exists.
  useEffect(() => {
    if (!scrollRequest) return
    const target = scrollRequest.section && document.getElementById(scrollRequest.section)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [scrollRequest])

  const handleNavigate = (link: NavLink) => {
    if (link.href) return window.location.assign(link.href)
    // A new view starts unfiltered, so drop the filter query string too.
    const url = window.location.pathname + hashForView(link.view)
    if (window.location.hash !== hashForView(link.view) || window.location.search) {
      window.history.pushState(null, '', url)
    }
    setView(link.view)
    setQuery('')
    resetFilters()
    setScrollRequest({ section: link.section ?? null })
  }

  // From the search's empty state: Movies, filtered to that genre.
  const browseGenre = (genreId: string) => {
    handleNavigate(NAV_LINKS.find((link) => link.view === 'movies')!)
    setFilters({ ...DEFAULT_FILTERS, genres: [genreId] })
  }

  const handleQueryChange = (next: string) => {
    // Starting a new search: jump to the top so results are in view.
    if (!isSearching && next.trim()) window.scrollTo({ top: 0 })
    setQuery(next)
  }

  const closeDetails = useCallback(() => {
    forgetTitleLink()
    setSelected(null)
  }, [])

  const activeId = isSearching && !isFilteredSearch ? null : view

  return (
    <>
      {/* The Invite & Win contest's popup and banners, and the invite guide. */}
      <ContestHost />
      <Navbar
        links={NAV_LINKS}
        activeId={activeId}
        query={query}
        onQueryChange={handleQueryChange}
        onNavigate={handleNavigate}
        onSelect={setSelected}
      />

      <main className="app-main" key={refreshKey}>
        {isSearching && !isFilteredSearch ? (
          <SearchResults
            query={query}
            filters={filters}
            committed={committed}
            onFiltersChange={setFilters}
            onSelect={setSelected}
            onClear={() => setQuery('')}
            onBrowseGenre={browseGenre}
          />
        ) : view === 'home' ? (
          <HomeView onSelect={setSelected} onBrowseTrending={() => handleNavigate(TRENDING_LINK)} />
        ) : (
          <BrowseView
            key={view}
            type={view === 'movies' ? 'movie' : 'series'}
            filters={filters}
            committed={committed}
            onFiltersChange={setFilters}
            query={isFilteredSearch ? query : ''}
            onSelect={setSelected}
          />
        )}
      </main>

      <Footer
        links={NAV_LINKS}
        onNavigate={handleNavigate}
        onBackToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      />

      <FallbackNotice onRetry={() => setRefreshKey((n) => n + 1)} />

      {selected && (
        <DetailsModal key={selected.id} item={selected} onClose={closeDetails} onSelect={setSelected} />
      )}
      <TvAdBreakHost />
      <TelegramGateHost />
      {AD_SECTIONS.movies && <AdsBackNotice />}
      <InstallAppHost />
      <FeedbackHost />

      {/* Vercel Web Analytics: page views, plus route changes via history.pushState. */}
      <Analytics beforeSend={analyticsBeforeSend} />
    </>
  )
}

export default App
