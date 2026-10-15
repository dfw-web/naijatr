import { X } from 'lucide-react'
import { activeFilters, clearFilters, type DiscoverFilters } from '../config/discoverFilters'
import type { MediaType } from '../types/media'

interface ActiveFiltersProps {
  filters: DiscoverFilters
  pageType: MediaType
  onChange: (next: DiscoverFilters) => void
}

/** Applied filters as removable chips, plus "Clear all". Renders nothing when none apply. */
export function ActiveFilters({ filters, pageType, onChange }: ActiveFiltersProps) {
  const chips = activeFilters(filters, pageType)
  if (chips.length === 0) return null

  return (
    <div className="active-filters" role="group" aria-label="Active filters">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="active-filters__chip"
          aria-label={`Remove filter: ${chip.label}`}
          onClick={() => onChange(chip.remove(filters))}
        >
          {chip.label}
          <X aria-hidden="true" />
        </button>
      ))}
      <button type="button" className="active-filters__clear" onClick={() => onChange(clearFilters(filters))}>
        Clear all
      </button>
    </div>
  )
}
