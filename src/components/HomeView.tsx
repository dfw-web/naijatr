import { Fragment, useState } from 'react'
import { CloudOff } from 'lucide-react'
import { MATCH_ALERTS_URL, TV_BANNER_ZONE } from '../config/tvAds'
import { freeMovieItems } from '../data/freeMovies'
import { useHomeCatalog } from '../hooks/useCatalog'
import type { MediaItem } from '../types/media'
import { Hero } from './Hero'
import { MediaRow } from './MediaRow'
import { StatusMessage } from './StatusMessage'
import { AdSlot } from '../tv/AdSlot'
import { QrCode } from '../tv/QrCode'
import { isTvMode } from '../tv/tvMode'
import { readRecentTitles } from '../utils/watchHistory'

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
  const tv = isTvMode()
  // Read once per visit to the home page; playing a title updates it for next time.
  const [recent] = useState(() => (tv ? readRecentTitles() : []))

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
        {recent.length > 0 && (
          <MediaRow id="continue-watching" title="Continue watching" items={recent} onSelect={onSelect} />
        )}
        {sections.map((section, index) => {
          const isTrending = section.id === 'trending'
          return (
            <Fragment key={section.id}>
              <MediaRow
                id={section.id}
                title={section.title}
                subtitle={isTrending ? 'Top 10 this week' : undefined}
                items={isTrending ? section.items.slice(0, 10) : section.items}
                variant={isTrending ? 'ranked' : 'default'}
                isLoading={!catalog}
                onSelect={onSelect}
              />
              {/* TV only: one ad between the first and second rows. */}
              {tv && index === 0 && TV_BANNER_ZONE && <AdSlot zone={TV_BANNER_ZONE} className="tv-ad-slot--row" />}
            </Fragment>
          )
        })}
        {tv && MATCH_ALERTS_URL && (
          <aside className="tv-alerts-card" aria-label="Match alerts">
            <QrCode url={MATCH_ALERTS_URL} label="QR code: join our match alerts channel" size="7em" />
            <p>
              <strong>Get match alerts</strong>
              Scan to join our WhatsApp/Telegram channel.
            </p>
          </aside>
        )}
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
