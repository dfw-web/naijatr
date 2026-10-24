import { Fragment, useMemo, useState } from 'react'
import { CloudOff } from 'lucide-react'
import { ADS_ENABLED } from '../config/ads'
import { MATCH_ALERTS_URL, TV_BANNER_ZONE } from '../config/tvAds'
import { freeMovieItems } from '../data/freeMovies'
import { useHomeCatalog } from '../hooks/useCatalog'
import type { MediaItem } from '../types/media'
import { ContinueWatchingRow } from './ContinueWatchingRow'
import { WatchLaterRow } from './WatchLater'
import { Hero } from './Hero'
import { MediaRow } from './MediaRow'
import { StatusMessage } from './StatusMessage'
import { TelegramBanner } from './Telegram'
import { AdSlot } from '../tv/AdSlot'
import { QrCode } from '../tv/QrCode'
import { isTvMode } from '../tv/tvMode'
import { useContinueWatching } from '../utils/continueWatching'
import { dedupeRows, planPersonalHome } from '../taste/personalHome'
import { isColdStart, readTaste, recordTaste, useTaste } from '../taste/profile'
import { useNearScreen, usePersonalRows } from '../taste/usePersonalHome'
import { TastePicker } from '../taste/TastePicker'

interface HomeViewProps {
  onSelect: (item: MediaItem) => void
  onBrowseTrending: () => void
}

/** Placeholder rows shown while the homepage catalogue loads. */
/** The catalogue's own rows: always shown, even when empty. */
const catalogIds = new Set(['trending', 'popular-movies', 'popular-series', 'recent'])

const LOADING_SECTIONS = [
  { id: 'trending', title: 'Trending Now' },
  { id: 'popular-movies', title: 'Popular Movies' },
  { id: 'popular-series', title: 'Popular Series' },
  { id: 'recent', title: 'New & Recent' },
]

interface Row {
  id: string
  title: string
  subtitle?: string
  items: MediaItem[]
  loading: boolean
  ranked?: boolean
  limit?: number
}

export function HomeView({ onSelect, onBrowseTrending }: HomeViewProps) {
  const { state, retry } = useHomeCatalog()
  const tv = isTvMode()
  const taste = useTaste()
  const cold = isColdStart(taste)
  // Planned once per visit (and again when the viewer warms up or resets), so
  // rows don't reshuffle under them as they browse.
  const plan = useMemo(() => (cold ? null : planPersonalHome(readTaste())), [cold])
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const personal = usePersonalRows(plan, useNearScreen(sentinel))
  const continuing = useContinueWatching()

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
  const hidden = new Set(taste.hidden)
  const visible = (items: MediaItem[]) => items.filter((item) => !hidden.has(item.id))

  // Screen order: personal rows, Trending Now, Try something different, the rest.
  const [trending, ...rest] = sections
  const catalogRow = (section: (typeof sections)[number]): Row => ({
    id: section.id,
    title: section.title,
    items: visible(section.id === 'trending' ? section.items.slice(0, 10) : section.items),
    loading: !catalog,
    ranked: section.id === 'trending',
    subtitle: section.id === 'trending' ? 'Top 10 this week' : undefined,
  })
  const ordered: Row[] = [
    ...personal.top.map((row) => ({ ...row, items: visible(row.items) })),
    ...(trending ? [catalogRow(trending)] : []),
    ...(personal.variety ? [{ ...personal.variety, items: visible(personal.variety.items), limit: personal.varietyLimit }] : []),
    ...rest.map(catalogRow),
  ]
  // Personal home only: one title, one row; nothing watched, playing or hidden is suggested.
  const rows = plan
    ? dedupeRows(ordered, new Set([...plan.exclude, ...continuing.map((e) => e.id)]), new Set(['trending'])).map((row) =>
        row.limit ? { ...row, items: row.items.slice(0, row.limit) } : row,
      )
    : ordered
  const notInterested = tv ? undefined : (item: MediaItem) => recordTaste(item, 'notInterested')

  return (
    <>
      {/* Only fall back to the skeleton hero while loading; a catalogue with no featured title skips it. */}
      {(!catalog || catalog.featured) && (
        <Hero item={catalog?.featured ?? null} onViewDetails={onSelect} onBrowse={onBrowseTrending} />
      )}
      <div className={`app-rows ${catalog && !catalog.featured ? 'app-rows--no-hero' : ''}`}>
        {/* What this device was watching (hidden until something is played). First in the rows, which overlap the hero's fade. */}
        <ContinueWatchingRow onSelect={onSelect} />
        {/* Titles saved with "Watch later" (hidden while there are none). */}
        <WatchLaterRow onSelect={onSelect} />
        <TelegramBanner />
        {/* The personal rows load when this comes near the screen. */}
        <div ref={setSentinel} aria-hidden="true" />
        {cold && !taste.asked && !tv && <TastePicker />}
        {plan?.football && (
          <a className="taste-football" href="/football">
            ⚽ Live football: scores and streams →
          </a>
        )}
        {rows.map((row, index) => {
          // A personal row that came back empty is left out.
          if (!row.loading && row.items.length === 0 && !catalogIds.has(row.id)) return null
          return (
            <Fragment key={row.id}>
              <MediaRow
                id={row.id}
                title={row.title}
                subtitle={row.subtitle}
                items={row.items}
                variant={row.ranked ? 'ranked' : 'default'}
                isLoading={row.loading}
                onSelect={onSelect}
                onNotInterested={notInterested}
              />
              {/* TV only: one ad between the first and second rows. */}
              {tv && index === 0 && ADS_ENABLED && TV_BANNER_ZONE && <AdSlot zone={TV_BANNER_ZONE} className="tv-ad-slot--row" />}
            </Fragment>
          )
        })}
        {tv && MATCH_ALERTS_URL && (
          <aside className="tv-alerts-card" aria-label="Match alerts">
            <QrCode url={MATCH_ALERTS_URL} label="QR code: join our match alerts channel" size="7em" />
            <p>
              <strong>Get match alerts</strong>
              Scan to join the official NAIJA TR Telegram channel.
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
