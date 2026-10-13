import { useMemo, useState } from 'react'
import { CloudOff, FilterX } from 'lucide-react'
import { useTitlesByType } from '../hooks/useCatalog'
import type { MediaItem, MediaType } from '../types/media'
import { collectGenres, SORT_OPTIONS, sortItems, type SortKey } from '../utils/media'
import { StatusMessage } from './StatusMessage'
import { TitleGrid } from './TitleGrid'
import './BrowseView.css'

interface BrowseViewProps {
  type: MediaType
  onSelect: (item: MediaItem) => void
}

const COPY: Record<MediaType, { title: string; subtitle: string }> = {
  movie: { title: 'Movies', subtitle: 'Feature films, from blockbusters to hidden gems.' },
  series: { title: 'Series', subtitle: 'Bingeable shows, limited series and long-running favourites.' },
}

/** Full catalogue for one content type, with genre filter and sort. */
export function BrowseView({ type, onSelect }: BrowseViewProps) {
  const { state, retry } = useTitlesByType(type)
  const [genre, setGenre] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('popular')

  const items = useMemo(() => (state.status === 'success' ? state.data : []), [state])
  const genres = useMemo(() => collectGenres(items), [items])
  const visible = useMemo(
    () => sortItems(genre ? items.filter((item) => item.genres.includes(genre)) : items, sort),
    [items, genre, sort],
  )

  const isLoading = state.status === 'loading' || state.status === 'idle'
  const { title, subtitle } = COPY[type]
  const headingId = `browse-${type}-heading`

  return (
    <section className="page browse" aria-labelledby={headingId}>
      <header className="browse__header">
        <div>
          <h1 id={headingId} className="page__title">
            {title}
          </h1>
          <p className="page__subtitle">{subtitle}</p>
        </div>
        {state.status === 'success' && (
          <p className="browse__count" aria-live="polite">
            {visible.length} {visible.length === 1 ? 'title' : 'titles'}
          </p>
        )}
      </header>

      {state.status === 'error' ? (
        <StatusMessage
          icon={CloudOff}
          tone="error"
          title={`We couldn’t load ${title.toLowerCase()}`}
          message={state.error.message}
          action={{ label: 'Try again', onClick: retry }}
        />
      ) : (
        <>
          <div className="browse__toolbar">
            <div className="browse__genres" role="group" aria-label="Filter by genre">
              <button
                type="button"
                className="filter-chip"
                aria-pressed={genre === null}
                onClick={() => setGenre(null)}
                disabled={isLoading}
              >
                All
              </button>
              {genres.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="filter-chip"
                  aria-pressed={genre === name}
                  onClick={() => setGenre(genre === name ? null : name)}
                >
                  {name}
                </button>
              ))}
            </div>

            <label className="browse__sort">
              <span>Sort by</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                disabled={isLoading}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!isLoading && visible.length === 0 ? (
            <StatusMessage
              icon={FilterX}
              title={genre ? `No ${genre.toLowerCase()} ${title.toLowerCase()} yet` : `No ${title.toLowerCase()} available`}
              message={genre ? 'Try another genre or show everything.' : undefined}
              action={genre ? { label: 'Show all', onClick: () => setGenre(null) } : undefined}
            />
          ) : (
            <TitleGrid items={visible} isLoading={isLoading} onSelect={onSelect} />
          )}
        </>
      )}
    </section>
  )
}
