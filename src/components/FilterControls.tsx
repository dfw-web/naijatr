import { useCallback, useId, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import {
  activeFilters,
  DISCOVER_SORTS,
  type DiscoverFilters,
  type DiscoverSort,
  type TypeFilter,
} from '../config/discoverFilters'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { ActiveFilters } from './ActiveFilters'
import { FilterPanel } from './FilterPanel'
import { FilterSheet } from './FilterSheet'
import './BrowseView.css'

interface FilterControlsProps {
  filters: DiscoverFilters
  onChange: (next: DiscoverFilters) => void
  /** The page's default type: movie/series on the browse pages, both on search. */
  pageType: TypeFilter
  /** Text search the filters combine with, for the mobile sheet's result count. */
  query: string
}

/**
 * Filters button and sort menu, the filter options (a panel on desktop, a
 * bottom sheet on phones; hidden until the button is clicked), and the
 * applied filters as removable chips. Shared by Browse and Search.
 */
export function FilterControls({ filters, onChange, pageType, query }: FilterControlsProps) {
  const isMobile = useMediaQuery('(max-width: 760px)')
  const [panelOpen, setPanelOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const panelId = useId()
  const activeCount = activeFilters(filters, pageType).length
  const closeSheet = useCallback(() => setSheetOpen(false), [])

  return (
    <>
      <div className="browse__toolbar">
        <button
          type="button"
          className="browse__filters-button"
          aria-expanded={isMobile ? sheetOpen : panelOpen}
          aria-controls={isMobile ? undefined : panelId}
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
            onChange={(event) => onChange({ ...filters, sort: event.target.value as DiscoverSort })}
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
        <div id={panelId} className="browse__panel">
          <FilterPanel value={filters} onChange={onChange} pageType={pageType} layout="panel" />
        </div>
      )}

      <ActiveFilters filters={filters} pageType={pageType} onChange={onChange} />

      {sheetOpen && (
        <FilterSheet
          initial={filters}
          pageType={pageType}
          query={query}
          onClose={closeSheet}
          onApply={(next) => {
            onChange(next)
            setSheetOpen(false)
          }}
        />
      )}
    </>
  )
}
