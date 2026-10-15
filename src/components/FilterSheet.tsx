import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { clearFilters, resolveType, type DiscoverFilters, type TypeFilter } from '../config/discoverFilters'
import { useDiscover } from '../hooks/useDiscover'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { FILTER_DEBOUNCE_MS } from '../hooks/useFilterParams'
import { FilterPanel } from './FilterPanel'
import './FilterSheet.css'

interface FilterSheetProps {
  initial: DiscoverFilters
  pageType: TypeFilter
  query: string
  onApply: (filters: DiscoverFilters) => void
  onClose: () => void
}

const FOCUSABLE = 'button:not([disabled]), select, input, [href], [tabindex]:not([tabindex="-1"])'

/** Mobile bottom sheet: edit a draft, preview its result count, then Apply. */
export function FilterSheet({ initial, pageType, query, onApply, onClose }: FilterSheetProps) {
  const [draft, setDraft] = useState(initial)
  const debouncedDraft = useDebouncedValue(draft, FILTER_DEBOUNCE_MS)
  const preview = useDiscover({ filters: debouncedDraft, type: resolveType(debouncedDraft, pageType), query })
  const settling = draft !== debouncedDraft || preview.isLoading

  const sheetRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Same modal behaviour as the details panel: focus, scroll lock, Escape, Tab trap.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose()
      if (event.key !== 'Tab' || !sheetRef.current) return
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  const count = preview.totalResults ?? preview.items.length
  // A filtered text search only knows its count page by page; with nothing on
  // the first page yet more to check, don't claim zero.
  const unknown = preview.totalResults === null && count === 0 && preview.hasMore
  const applyLabel = settling || unknown
    ? 'Show results'
    : preview.error
      ? 'Apply'
      : `Show ${count.toLocaleString()}${preview.totalResults === null && preview.hasMore ? '+' : ''} ${count === 1 ? 'title' : 'titles'}`

  return (
    <div className="sheet" onClick={onClose}>
      <div
        ref={sheetRef}
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet__header">
          <h2 id="filter-sheet-title" className="sheet__title">
            Filters
          </h2>
          <button ref={closeRef} type="button" className="sheet__close" aria-label="Close filters" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="sheet__body">
          <FilterPanel value={draft} onChange={setDraft} pageType={pageType} layout="sheet" />
        </div>

        <footer className="sheet__footer">
          <button type="button" className="btn btn--ghost sheet__clear" onClick={() => setDraft(clearFilters(draft))}>
            Clear all
          </button>
          <button
            type="button"
            className="btn btn--primary sheet__apply"
            aria-live="polite"
            onClick={() => onApply(draft)}
          >
            {applyLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
