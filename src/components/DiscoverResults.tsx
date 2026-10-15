import { useEffect, useRef } from 'react'
import { CloudOff, FilterX } from 'lucide-react'
import type { useDiscover } from '../hooks/useDiscover'
import type { MediaItem } from '../types/media'
import { isScanning } from '../utils/discover'
import { StatusMessage } from './StatusMessage'
import { TitleGrid } from './TitleGrid'
import './BrowseView.css'

interface DiscoverResultsProps {
  discover: ReturnType<typeof useDiscover>
  /** Filters changed and the new results are on their way: dim the old ones. */
  settling: boolean
  /** Shown as "We couldn’t load …" when the first page fails. */
  errorSubject: string
  /** Offered in the empty state when filters are applied. */
  onClearFilters?: () => void
  onSelect: (item: MediaItem) => void
}

/** Filtered titles with empty and error states, plus "Load more" and infinite scroll. */
export function DiscoverResults({ discover, settling, errorSubject, onClearFilters, onSelect }: DiscoverResultsProps) {
  const { items, hasMore, isLoadingMore, loadMore, error, retry } = discover
  const scanning = isScanning(discover)
  const isLoading = discover.isLoading || scanning || (items.length === 0 && isLoadingMore)

  // Nothing on this page yet more pages exist: look further before saying "no titles".
  useEffect(() => {
    if (scanning && !isLoadingMore) loadMore()
  }, [scanning, isLoadingMore, loadMore])

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

  return (
    <div className={`browse__results ${settling ? 'browse__results--settling' : ''}`}>
      {error && items.length === 0 ? (
        <StatusMessage
          icon={CloudOff}
          tone="error"
          title={`We couldn’t load ${errorSubject}`}
          message={error.message}
          action={{ label: 'Try again', onClick: retry }}
        />
      ) : !isLoading && items.length === 0 ? (
        <StatusMessage
          icon={FilterX}
          title="No titles match"
          message="Try removing a filter."
          action={onClearFilters ? { label: 'Clear all filters', onClick: onClearFilters } : undefined}
        />
      ) : (
        <>
          <TitleGrid items={items} isLoading={isLoading} onSelect={onSelect} />
          <div ref={sentinelRef} className="browse__more">
            {error ? (
              <StatusMessage
                icon={CloudOff}
                tone="error"
                compact
                title="Couldn’t load more titles"
                message={error.message}
                action={{ label: 'Try again', onClick: retry }}
              />
            ) : items.length > 0 && (hasMore || isLoadingMore) ? (
              <button type="button" className="btn btn--ghost" onClick={loadMore} disabled={isLoadingMore}>
                {isLoadingMore ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

