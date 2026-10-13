import { CloudOff, SearchX } from 'lucide-react'
import { useSearch } from '../hooks/useCatalog'
import type { MediaItem } from '../types/media'
import { StatusMessage } from './StatusMessage'
import { TitleGrid } from './TitleGrid'
import './SearchResults.css'

interface SearchResultsProps {
  query: string
  onSelect: (item: MediaItem) => void
  onClear: () => void
}

export function SearchResults({ query, onSelect, onClear }: SearchResultsProps) {
  const { state, retry, isPending } = useSearch(query)
  const isLoading = isPending || state.status === 'loading' || state.status === 'idle'
  const results = state.status === 'success' ? state.data : []

  return (
    <section className="page search-results" aria-labelledby="search-heading">
      <header className="search-results__header">
        <h1 id="search-heading" className="page__title search-results__title">
          Results for <span>“{query.trim()}”</span>
        </h1>
        <p className="search-results__count" aria-live="polite">
          {isLoading
            ? 'Searching…'
            : state.status === 'success'
              ? `${results.length} ${results.length === 1 ? 'title' : 'titles'}`
              : ''}
        </p>
      </header>

      {state.status === 'error' && !isPending ? (
        <StatusMessage
          icon={CloudOff}
          tone="error"
          title="Search is unavailable right now"
          message={state.error.message}
          action={{ label: 'Try again', onClick: retry }}
        />
      ) : !isLoading && results.length === 0 ? (
        <StatusMessage
          icon={SearchX}
          title="No titles match your search"
          message="Try a title, a genre like “thriller”, a type like “series”, or a year."
          action={{ label: 'Clear search', onClick: onClear }}
        />
      ) : (
        <TitleGrid items={results} isLoading={isLoading} skeletonCount={6} onSelect={onSelect} />
      )}
    </section>
  )
}
