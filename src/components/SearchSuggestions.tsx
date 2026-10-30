import { SUGGESTIONS_ID, suggestionId } from '../search/useSuggestions'
import type { MediaItem } from '../types/media'
import { formatYear, typeLabel } from '../utils/media'
import './SearchSuggestions.css'

interface SearchSuggestionsProps {
  items: MediaItem[]
  activeIndex: number
  onPick: (item: MediaItem) => void
}

export function SearchSuggestions({ items, activeIndex, onPick }: SearchSuggestionsProps) {
  return (
    <ul id={SUGGESTIONS_ID} className="search-suggestions" role="listbox" aria-label="Suggestions">
      {items.map((item, index) => (
        <li key={item.id} role="presentation">
          <button
            id={suggestionId(index)}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`search-suggestions__item ${index === activeIndex ? 'search-suggestions__item--active' : ''}`}
            // Keep focus in the search box, so a tap isn't lost to its blur.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(item)}
          >
            {item.poster ? (
              <img className="search-suggestions__poster" src={item.poster} alt="" loading="lazy" />
            ) : (
              <span className="search-suggestions__poster" aria-hidden="true" />
            )}
            <span className="search-suggestions__text">
              <span className="search-suggestions__title">{item.title}</span>
              <span className="search-suggestions__meta">
                {[typeLabel(item.type), item.year ? formatYear(item.year) : null].filter(Boolean).join(' · ')}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
