import { useState } from 'react'
import { CloudOff } from 'lucide-react'
import { activeFilters, clearFilters, resolveType, type DiscoverFilters } from '../config/discoverFilters'
import { SEARCH_DEBOUNCE_MS, useSmartSearch } from '../hooks/useCatalog'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useDiscover } from '../hooks/useDiscover'
import type { MediaItem } from '../types/media'
import { discoverCountText, searchIgnoresCategories } from '../utils/discover'
import { DiscoverResults } from './DiscoverResults'
import { FilterControls } from './FilterControls'
import { SearchEmpty } from './SearchEmpty'
import { StatusMessage } from './StatusMessage'
import { TitleGrid } from './TitleGrid'
import './SearchResults.css'

interface SearchResultsProps {
  query: string
  /** Live filters (chips update instantly). */
  filters: DiscoverFilters
  /** Debounced filters that drive the request. */
  committed: DiscoverFilters
  onFiltersChange: (next: DiscoverFilters) => void
  onSelect: (item: MediaItem) => void
  onClear: () => void
  /** A genre from the empty state: browse it. */
  onBrowseGenre: (genreId: string) => void
}

/** Search covers movies and series unless the Type filter narrows it. */
const SEARCH_TYPE = 'both'

/** Uses the filtered search once any filter or a non-default sort is chosen. */
const isFiltered = (f: DiscoverFilters) => activeFilters(f, SEARCH_TYPE).length > 0 || f.sort !== 'popular'

export function SearchResults({ query, filters, committed, onFiltersChange, onSelect, onClear, onBrowseGenre }: SearchResultsProps) {
  const filtered = isFiltered(committed)
  const text = query.trim()
  const debouncedText = useDebouncedValue(text, SEARCH_DEBOUNCE_MS)
  // "Search instead for …": exactly what was typed, for this query only.
  const [strictFor, setStrictFor] = useState<string | null>(null)
  const strict = strictFor !== null && strictFor === debouncedText

  // Without filters: TMDB's multi-search, typo-tolerant (src/search/smartSearch.ts).
  const plain = useSmartSearch(filtered ? '' : query, strict)
  // With filters: per-type search, filtered client-side (see tmdbDiscover.ts).
  const discover = useDiscover(
    filtered && debouncedText
      ? { filters: committed, type: resolveType(committed, SEARCH_TYPE), query: debouncedText }
      : null,
  )
  const isPending = text !== debouncedText

  const plainLoading = plain.isPending || plain.state.status === 'loading' || plain.state.status === 'idle'
  const results = plain.state.status === 'success' ? plain.state.data.items : []
  const showingFor = !plainLoading && plain.state.status === 'success' ? plain.state.data.showingFor : null

  const count = filtered
    ? isPending
      ? 'Searching…'
      : discoverCountText(discover)
    : plainLoading
      ? 'Searching…'
      : plain.state.status === 'success'
        ? `${results.length} ${results.length === 1 ? 'title' : 'titles'}`
        : ''

  return (
    <section className="page search-results" aria-labelledby="search-heading">
      <header className="search-results__header">
        <h1 id="search-heading" className="page__title search-results__title">
          Results for <span>“{text}”</span>
        </h1>
        <p className="search-results__count" aria-live="polite">
          {count}
        </p>
      </header>

      <FilterControls filters={filters} onChange={onFiltersChange} pageType={SEARCH_TYPE} query={debouncedText} />

      {!filtered && showingFor && (
        <p className="search-results__corrected">
          Showing results for <strong>{showingFor}</strong>.{' '}
          <button type="button" className="search-results__instead" onClick={() => setStrictFor(debouncedText)}>
            Search instead for “{debouncedText}”
          </button>
        </p>
      )}

      {searchIgnoresCategories(filters.categories) && (
        <p className="browse__note">Category filters don’t apply to text searches.</p>
      )}

      {filtered ? (
        <DiscoverResults
          discover={discover}
          settling={filters !== committed || isPending}
          errorSubject="search results"
          onClearFilters={() => onFiltersChange(clearFilters(filters))}
          onSelect={onSelect}
        />
      ) : plain.state.status === 'error' && !plain.isPending ? (
        <StatusMessage
          icon={CloudOff}
          tone="error"
          title="Search is unavailable right now"
          message={plain.state.error.message}
          action={{ label: 'Try again', onClick: plain.retry }}
        />
      ) : !plainLoading && results.length === 0 ? (
        <SearchEmpty onClear={onClear} onSelect={onSelect} onBrowseGenre={onBrowseGenre} />
      ) : (
        <TitleGrid items={results} isLoading={plainLoading} skeletonCount={6} onSelect={onSelect} />
      )}
    </section>
  )
}
