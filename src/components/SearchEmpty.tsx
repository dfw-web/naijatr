import { SearchX } from 'lucide-react'
import { GENRES } from '../config/discoverFilters'
import { useHomeCatalog } from '../hooks/useCatalog'
import { attributeScores, topValues, useTaste } from '../taste/profile'
import type { MediaItem } from '../types/media'
import { StatusMessage } from './StatusMessage'
import { TitleGrid } from './TitleGrid'

/** TMDB genre ids (movie and TV) → our genre chips. */
const CHIP_FOR_TMDB_GENRE: Record<number, string> = {
  28: 'action', 12: 'adventure', 10759: 'action', 35: 'comedy', 10749: 'romance', 18: 'drama', 27: 'horror',
  53: 'thriller', 80: 'crime', 9648: 'mystery', 14: 'fantasy', 878: 'scifi', 10765: 'scifi', 16: 'animation',
  10751: 'family', 99: 'documentary', 10752: 'war', 10768: 'war', 36: 'history', 10402: 'music', 37: 'western',
}
/** For someone with no viewing history yet. */
const DEFAULT_CHIPS = ['action', 'comedy', 'drama', 'romance', 'horror']
const GENRE_COUNT = 5
const TRENDING_COUNT = 12

/** The viewer's favourite genres (from what they watch), else popular ones. */
function useTopGenres() {
  const taste = useTaste()
  const ids = topValues(attributeScores(taste), 'g:', 10)
    .map(({ value }) => CHIP_FOR_TMDB_GENRE[Number(value)])
    .filter(Boolean)
  const chips = [...new Set([...ids, ...DEFAULT_CHIPS])].slice(0, GENRE_COUNT)
  return chips.flatMap((id) => GENRES.find((g) => g.id === id) ?? [])
}

interface SearchEmptyProps {
  onClear: () => void
  onSelect: (item: MediaItem) => void
  onBrowseGenre: (genreId: string) => void
}

/** Nothing found by any search step: say so, and offer somewhere to go. */
export function SearchEmpty({ onClear, onSelect, onBrowseGenre }: SearchEmptyProps) {
  const genres = useTopGenres()
  const home = useHomeCatalog()
  const trending = home.state.status === 'success' ? (home.state.data.sections.find((s) => s.id === 'trending')?.items ?? []) : []

  return (
    <div className="search-empty">
      <StatusMessage
        icon={SearchX}
        title="No results found"
        message="Check the spelling or try a shorter title."
        action={{ label: 'Clear search', onClick: onClear }}
      />
      <nav className="search-empty__genres" aria-label="Browse by genre">
        {genres.map((genre) => (
          <button key={genre.id} type="button" className="chip" onClick={() => onBrowseGenre(genre.id)}>
            {genre.label}
          </button>
        ))}
      </nav>
      {trending.length > 0 && (
        <section aria-labelledby="search-empty-trending">
          <h2 id="search-empty-trending" className="search-empty__heading">
            Trending now
          </h2>
          <TitleGrid items={trending.slice(0, TRENDING_COUNT)} onSelect={onSelect} />
        </section>
      )}
    </div>
  )
}
