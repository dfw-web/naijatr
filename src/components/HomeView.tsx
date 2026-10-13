import { CloudOff } from 'lucide-react'
import { freeMovieItems } from '../data/freeMovies'
import { useHomeCatalog } from '../hooks/useCatalog'
import type { MediaItem } from '../types/media'
import { Hero } from './Hero'
import { MediaRow } from './MediaRow'
import { StatusMessage } from './StatusMessage'

interface HomeViewProps {
  onSelect: (item: MediaItem) => void
  onBrowseTrending: () => void
}

/** Placeholder rows shown while the homepage catalogue loads. */
const LOADING_SECTIONS = [
  { id: 'trending', title: 'Trending Now' },
  { id: 'popular-movies', title: 'Popular Movies' },
  { id: 'popular-series', title: 'Popular Series' },
  { id: 'recent', title: 'New & Recent' },
]

export function HomeView({ onSelect, onBrowseTrending }: HomeViewProps) {
  const { state, retry } = useHomeCatalog()

  if (state.status === 'error') {
    return (
      <section className="page">
        <StatusMessage
          icon={CloudOff}
          tone="error"
          title="We couldn’t load the catalogue"
          message={state.error.message}
          action={{ label: 'Try again', onClick: retry }}
        />
      </section>
    )
  }

  const catalog = state.status === 'success' ? state.data : null
  const sections = catalog?.sections ?? LOADING_SECTIONS.map((s) => ({ ...s, items: [] }))

  return (
    <>
      {/* Only fall back to the skeleton hero while loading; a catalogue with no featured title skips it. */}
      {(!catalog || catalog.featured) && (
        <Hero item={catalog?.featured ?? null} onViewDetails={onSelect} onBrowse={onBrowseTrending} />
      )}
      <div className={`app-rows ${catalog && !catalog.featured ? 'app-rows--no-hero' : ''}`}>
        {sections.map((section) => {
          const isTrending = section.id === 'trending'
          return (
            <MediaRow
              key={section.id}
              id={section.id}
              title={section.title}
              subtitle={isTrending ? 'Top 10 this week' : undefined}
              items={isTrending ? section.items.slice(0, 10) : section.items}
              variant={isTrending ? 'ranked' : 'default'}
              isLoading={!catalog}
              onSelect={onSelect}
            />
          )
        })}
        {/* Legal full movies are curated locally, so this row never waits on the catalogue. */}
        <MediaRow
          id="watch-free"
          title="Watch Free"
          subtitle="Full movies: public domain and open films"
          items={freeMovieItems}
          onSelect={onSelect}
        />
      </div>
    </>
  )
}
