import type { ReactNode } from 'react'
import {
  CATEGORIES,
  GENRES,
  INDUSTRIES,
  MAX_RATING,
  MIN_YEAR,
  resolveType,
  RUNTIMES,
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

const CURRENT_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: CURRENT_YEAR + 2 - MIN_YEAR }, (_, i) => CURRENT_YEAR + 1 - i)

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

  const setYear = (field: 'yearFrom' | 'yearTo', raw: string) => {
    const year = raw ? Number(raw) : null
    const next = { ...value, [field]: year }
    // Keep the range the right way round.
    if (next.yearFrom !== null && next.yearTo !== null && next.yearFrom > next.yearTo) {
      if (field === 'yearFrom') next.yearTo = next.yearFrom
      else next.yearFrom = next.yearTo
    }
    onChange(next)
  }

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

      <div className="filter-extras">
        <div className="filter-group">
          <span className="filter-group__label">Release year</span>
          <div className="filter-years">
            <label className="filter-select">
              <span className="visually-hidden">From year</span>
              <select value={value.yearFrom ?? ''} onChange={(e) => setYear('yearFrom', e.target.value)}>
                <option value="">Any</option>
                {YEARS.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>
            <span aria-hidden="true">to</span>
            <label className="filter-select">
              <span className="visually-hidden">To year</span>
              <select value={value.yearTo ?? ''} onChange={(e) => setYear('yearTo', e.target.value)}>
                <option value="">Any</option>
                {YEARS.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="filter-group">
          <label className="filter-group__label" htmlFor={`min-rating-${layout}`}>
            Minimum rating: <strong>{value.minRating > 0 ? `${value.minRating}+` : 'Any'}</strong>
          </label>
          <input
            id={`min-rating-${layout}`}
            className="filter-range"
            type="range"
            min={0}
            max={MAX_RATING}
            step={1}
            value={value.minRating}
            onChange={(e) => set({ minRating: Number(e.target.value) })}
          />
        </div>

        {type !== 'series' && (
          <Group label="Runtime">
            {RUNTIMES.map((runtime) => (
              <Chip
                key={runtime.id}
                pressed={value.runtime === runtime.id}
                onClick={() => set({ runtime: value.runtime === runtime.id ? null : runtime.id })}
              >
                {runtime.label}
              </Chip>
            ))}
          </Group>
        )}
      </div>
    </div>
  )
}
