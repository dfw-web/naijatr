import { useCallback, useEffect, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { hashRouteAsPath } from './analytics'
import { BrowseView } from './components/BrowseView'
import { DetailsModal } from './components/DetailsModal'
import { FallbackNotice } from './components/FallbackNotice'
import { Footer } from './components/Footer'
import { HomeView } from './components/HomeView'
import { Navbar } from './components/Navbar'
import { SearchResults } from './components/SearchResults'
import { hasNarrowingFilters } from './config/discoverFilters'
import { useFilterParams } from './hooks/useFilterParams'
import { hashForView, NAV_LINKS, type NavLink, type View, viewFromHash } from './navigation'
import type { MediaItem } from './types/media'
import './App.css'

const TRENDING_LINK: NavLink = { ...NAV_LINKS[0], section: 'trending' }

function App() {
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash))
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MediaItem | null>(null)
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

  const handleQueryChange = (next: string) => {
    // Starting a new search: jump to the top so results are in view.
    if (!isSearching && next.trim()) window.scrollTo({ top: 0 })
    setQuery(next)
  }

  const closeDetails = useCallback(() => setSelected(null), [])

  const activeId = isSearching && !isFilteredSearch ? null : view

  return (
    <>
      <Navbar
        links={NAV_LINKS}
        activeId={activeId}
        query={query}
        onQueryChange={handleQueryChange}
        onNavigate={handleNavigate}
      />

      <main className="app-main" key={refreshKey}>
        {isSearching && !isFilteredSearch ? (
          <SearchResults query={query} onSelect={setSelected} onClear={() => setQuery('')} />
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

      {selected && <DetailsModal item={selected} onClose={closeDetails} />}

      {/* Vercel Web Analytics: page views, plus route changes via history.pushState. */}
      <Analytics beforeSend={hashRouteAsPath} />
    </>
  )
}

export default App
