import { Play, X } from 'lucide-react'
import { useAdOnce } from '../hooks/useAdOnce'
import type { MediaItem } from '../types/media'
import {
  entryTitle,
  episodeLabel,
  removeEntry,
  requestResume,
  useContinueWatching,
  type ContinueEntry,
} from '../utils/continueWatching'
import { MediaImage } from './MediaImage'
import { MediaRow } from './MediaRow'
import './ContinueWatchingRow.css'

interface ContinueWatchingRowProps {
  /** Opens the title's details page; its player then starts the saved movie or episode. */
  onSelect: (item: MediaItem) => void
}

/** The first home row: what this device was watching, newest first. Hidden while empty. */
export function ContinueWatchingRow({ onSelect }: ContinueWatchingRowProps) {
  const entries = useContinueWatching()
  const openAd = useAdOnce()
  if (entries.length === 0) return null
  return (
    <MediaRow id="continue-watching" title="Continue watching" items={[]} onSelect={onSelect}>
      {entries.map((entry) => (
        <ContinueCard
          key={entry.id}
          entry={entry}
          onPlay={(event) => {
            const item = entryTitle(entry)
            openAd(event, item)
            requestResume(entry)
            onSelect(item)
          }}
        />
      ))}
    </MediaRow>
  )
}

const percent = (entry: ContinueEntry) =>
  entry.progressSeconds !== null && entry.durationSeconds
    ? Math.min(100, Math.max(2, Math.round((entry.progressSeconds / entry.durationSeconds) * 100)))
    : null

function ContinueCard({ entry, onPlay }: { entry: ContinueEntry; onPlay: (event: React.MouseEvent) => void }) {
  const episode = episodeLabel(entry)
  const progress = percent(entry)
  const label = [`Continue watching ${entry.title}`, episode, progress !== null ? `${progress}% watched` : null]
    .filter(Boolean)
    .join(', ')
  return (
    <article className="continue-card">
      <button type="button" className="continue-card__button" onClick={onPlay} aria-label={label}>
        <div className="continue-card__frame">
          <MediaImage
            className="continue-card__image"
            src={entry.still ?? entry.backdrop ?? entry.poster}
            alt=""
            fallbackTitle={entry.title}
            fallbackType={entry.type === 'tv' ? 'series' : 'movie'}
          />
          <span className="continue-card__play" aria-hidden="true">
            <Play />
          </span>
          {progress !== null && (
            <span className="continue-card__progress" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </span>
          )}
        </div>
        <div className="continue-card__info">
          <h3 className="continue-card__title">{entry.title}</h3>
          {episode && <p className="continue-card__episode">{episode}</p>}
        </div>
      </button>
      <button
        type="button"
        className="continue-card__remove"
        aria-label={`Remove ${entry.title} from Continue watching`}
        onClick={() => removeEntry(entry.id)}
      >
        <X aria-hidden="true" />
      </button>
    </article>
  )
}
