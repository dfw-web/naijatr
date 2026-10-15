import { activeFilters, clearFilters, resolveType, type DiscoverFilters } from '../config/discoverFilters'
import { useDiscover } from '../hooks/useDiscover'
import type { MediaItem, MediaType } from '../types/media'
import { discoverCountText, searchIgnoresCategories } from '../utils/discover'
import { DiscoverResults } from './DiscoverResults'
import { FilterControls } from './FilterControls'
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

/** Catalogue for one content type, with TMDB Discover filters, sort and infinite scroll. */
export function BrowseView({ type: pageType, filters, committed, onFiltersChange, query, onSelect }: BrowseViewProps) {
  const text = query.trim()
  const discover = useDiscover({ filters: committed, type: resolveType(committed, pageType), query: text })

  const { title, subtitle } = COPY[resolveType(filters, pageType)]
  const headingId = `browse-${pageType}-heading`
  const hasFilters = activeFilters(filters, pageType).length > 0

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
          {discoverCountText(discover)}
        </p>
      </header>

      <FilterControls filters={filters} onChange={onFiltersChange} pageType={pageType} query={text} />

      {text && searchIgnoresCategories(filters.categories) && (
        <p className="browse__note">Category filters don’t apply to text searches.</p>
      )}

      <DiscoverResults
        discover={discover}
        settling={filters !== committed}
        errorSubject={title.toLowerCase()}
        onClearFilters={hasFilters ? () => onFiltersChange(clearFilters(filters)) : undefined}
        onSelect={onSelect}
      />
    </section>
  )
}
