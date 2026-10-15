import type { ReactNode } from 'react'
import {
  CATEGORIES,
  GENRES,
  INDUSTRIES,
  resolveType,
  TYPE_OPTIONS,
  type DiscoverFilters,
} from '../config/discoverFilters'
import type { MediaType } from '../types/media'
import './FilterPanel.css'

interface FilterPanelProps {
  value: DiscoverFilters
  onChange: (next: DiscoverFilters) => void
  /** The page's own type, used when no Type filter is chosen. */
  pageType: MediaType
  /** "panel": wrapping chip rows (desktop). "sheet": sideways-scrolling rows (mobile bottom sheet). */
  layout: 'panel' | 'sheet'
}

const toggle = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]

function Group({ label, extra, children }: { label: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="filter-group">
      <div className="filter-group__head">
        <span className="filter-group__label">{label}</span>
        {extra}
      </div>
      <div className="filter-group__chips" role="group" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="filter-chip" aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  )
}

/** Every filter group. Controlled: the parent decides whether changes apply live or on "Apply". */
export function FilterPanel({ value, onChange, pageType, layout }: FilterPanelProps) {
  const set = (patch: Partial<DiscoverFilters>) => onChange({ ...value, ...patch })
  const type = resolveType(value, pageType)

  return (
    <div className={`filter-panel filter-panel--${layout}`}>
      <Group label="Type">
        {TYPE_OPTIONS.map((option) => (
          <Chip
            key={option.id}
            pressed={type === option.id}
            onClick={() => set({ type: option.id === pageType ? null : option.id })}
          >
            {option.label}
          </Chip>
        ))}
      </Group>

      <Group label="Industry">
        {INDUSTRIES.map((industry) => (
          <Chip
            key={industry.id}
            pressed={value.industries.includes(industry.id)}
            onClick={() => set({ industries: toggle(value.industries, industry.id) })}
          >
            {industry.label}
          </Chip>
        ))}
      </Group>

      <Group
        label="Genres"
        extra={
          <div className="filter-match" role="group" aria-label="Genre matching">
            {(['all', 'any'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className="filter-match__option"
                aria-pressed={value.genreMatch === mode}
                onClick={() => set({ genreMatch: mode })}
              >
                Match {mode}
              </button>
            ))}
          </div>
        }
      >
        {GENRES.map((genre) => (
          <Chip
            key={genre.id}
            pressed={value.genres.includes(genre.id)}
            onClick={() => set({ genres: toggle(value.genres, genre.id) })}
          >
            {genre.label}
          </Chip>
        ))}
      </Group>

      <Group label="Categories">
        {CATEGORIES.map((category) => (
          <Chip
            key={category.id}
            pressed={value.categories.includes(category.id)}
            onClick={() => set({ categories: toggle(value.categories, category.id) })}
          >
            {category.label}
          </Chip>
        ))}
      </Group>
    </div>
  )
}
