import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudOff, FilterX, SlidersHorizontal } from 'lucide-react'
import {
  activeFilters,
  clearFilters,
  DISCOVER_SORTS,
  resolveType,
  type DiscoverFilters,
  type DiscoverSort,
} from '../config/discoverFilters'
import { useDiscover } from '../hooks/useDiscover'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type { MediaItem, MediaType } from '../types/media'
import { ActiveFilters } from './ActiveFilters'
import { FilterPanel } from './FilterPanel'
import { FilterSheet } from './FilterSheet'
import { StatusMessage } from './StatusMessage'
import { TitleGrid } from './TitleGrid'
import './BrowseView.css'

interface BrowseViewProps {
  type: MediaType
  /** Live filters (chips update instantly). */
  filters: DiscoverFilters
  /** Debounced filters that drive the request. */
  committed: DiscoverFilters
  onFiltersChange: (next: DiscoverFilters) => void
  /** Navbar text search, combined with the filters. Blank for plain browsing. */
  query: string
  onSelect: (item: MediaItem) => void
}

const COPY: Record<MediaType | 'both', { title: string; subtitle: string }> = {
  movie: { title: 'Movies', subtitle: 'Feature films, from blockbusters to hidden gems.' },
  series: { title: 'Series', subtitle: 'Bingeable shows, limited series and long-running favourites.' },
  both: { title: 'Movies & Series', subtitle: 'Films and shows together, ranked side by side.' },
}

/** Keyword categories can't apply to a text search (keywords aren't in /search results). */
const SEARCH_UNSUPPORTED = (f: DiscoverFilters) => f.categories.some((id) => id !== 'anime')

/** Catalogue for one content type, with TMDB Discover filters, sort and infinite scroll. */
export function BrowseView({ type: pageType, filters, committed, onFiltersChange, query, onSelect }: BrowseViewProps) {
  const isMobile = useMediaQuery('(max-width: 760px)')
  const [panelOpen, setPanelOpen] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)

  const text = query.trim()
  const committedType = resolveType(committed, pageType)
  const discover = useDiscover({ filters: committed, type: committedType, query: text })
  const settling = filters !== committed
  const isLoading = discover.isLoading
  const { items, hasMore, isLoadingMore, loadMore } = discover

  const type = resolveType(filters, pageType)
  const { title, subtitle } = COPY[type]
  const headingId = `browse-${pageType}-heading`
  const activeCount = activeFilters(filters, pageType).length

  // Infinite scroll: load the next page as the end of the grid comes into view.
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore || isLoadingMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore()
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, isLoadingMore, loadMore])

  const closeSheet = useCallback(() => setSheetOpen(false), [])

  const countText = isLoading
    ? 'Loading…'
    : discover.error
      ? ''
      : discover.totalResults !== null
        ? `${discover.totalResults.toLocaleString()} ${discover.totalResults === 1 ? 'title' : 'titles'}`
        : `${items.length}${hasMore ? '+' : ''} ${items.length === 1 && !hasMore ? 'title' : 'titles'}`

  return (
    <section className="page browse" aria-labelledby={headingId}>
      <header className="browse__header">
        <div>
          <h1 id={headingId} className="page__title">
            {title}
          </h1>
          <p className="page__subtitle">
            {text ? (
              <>
                Results for <span className="browse__query">“{text}”</span> matching your filters
              </>
            ) : (
              subtitle
            )}
          </p>
        </div>
        <p className="browse__count" aria-live="polite">
          {countText}
        </p>
      </header>

      <div className="browse__toolbar">
        <button
          type="button"
          className="browse__filters-button"
          aria-expanded={isMobile ? sheetOpen : panelOpen}
          aria-controls={isMobile ? undefined : 'browse-filter-panel'}
          onClick={() => (isMobile ? setSheetOpen(true) : setPanelOpen((open) => !open))}
        >
          <SlidersHorizontal aria-hidden="true" />
          Filters
          {activeCount > 0 && (
            <span className="browse__filters-badge" aria-label={`${activeCount} active`}>
              {activeCount}
            </span>
          )}
        </button>

        <label className="browse__sort">
          <span>Sort by</span>
          <select
            value={filters.sort}
            onChange={(event) => onFiltersChange({ ...filters, sort: event.target.value as DiscoverSort })}
          >
            {DISCOVER_SORTS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!isMobile && panelOpen && (
        <div id="browse-filter-panel" className="browse__panel">
          <FilterPanel value={filters} onChange={onFiltersChange} pageType={pageType} layout="panel" />
        </div>
      )}

      <ActiveFilters filters={filters} pageType={pageType} onChange={onFiltersChange} />

      {text && SEARCH_UNSUPPORTED(filters) && (
        <p className="browse__note">Category filters don’t apply to text searches.</p>
      )}

      <div className={`browse__results ${settling ? 'browse__results--settling' : ''}`}>
        {discover.error && items.length === 0 ? (
          <StatusMessage
            icon={CloudOff}
            tone="error"
            title={`We couldn’t load ${title.toLowerCase()}`}
            message={discover.error.message}
            action={{ label: 'Try again', onClick: discover.retry }}
          />
        ) : !isLoading && items.length === 0 ? (
          <StatusMessage
            icon={FilterX}
            title="No titles match"
            message="Try removing a filter."
            action={activeCount > 0 ? { label: 'Clear all filters', onClick: () => onFiltersChange(clearFilters(filters)) } : undefined}
          />
        ) : (
          <>
            <TitleGrid items={items} isLoading={isLoading} onSelect={onSelect} />
            <div ref={sentinelRef} className="browse__more">
              {discover.error ? (
                <StatusMessage
                  icon={CloudOff}
                  tone="error"
                  compact
                  title="Couldn’t load more titles"
                  message={discover.error.message}
                  action={{ label: 'Try again', onClick: discover.retry }}
                />
              ) : hasMore || isLoadingMore ? (
                <button type="button" className="btn btn--ghost" onClick={loadMore} disabled={isLoadingMore}>
                  {isLoadingMore ? 'Loading…' : 'Load more'}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>

      {sheetOpen && (
        <FilterSheet
          initial={filters}
          pageType={pageType}
          query={text}
          onClose={closeSheet}
          onApply={(next) => {
            onFiltersChange(next)
            setSheetOpen(false)
          }}
        />
      )}
    </section>
  )
}
