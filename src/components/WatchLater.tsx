import { Bookmark, BookmarkCheck } from 'lucide-react'
import { useAccount } from '../account/account'
import { goToPage } from '../account/pages'
import { recordTaste } from '../taste/profile'
import { isTvMode } from '../tv/tvMode'
import type { MediaItem } from '../types/media'
import { removeFromLater, saveForLater, savedItem, useWatchLater } from '../utils/watchLater'
import { MediaRow } from './MediaRow'
import './WatchLater.css'

const toggle = (item: MediaItem, saved: boolean) => {
  if (saved) return removeFromLater(item.id)
  saveForLater(item)
  recordTaste(item, 'saved')
}

/** "＋ My List" / "✓ Saved": saves the movie or series (on this device, and the account when signed in). */
export function WatchLaterButton({ item, className = 'btn btn--ghost' }: { item: MediaItem; className?: string }) {
  const saved = useWatchLater().some((e) => e.id === item.id)
  if (!item.title) return null
  return (
    <button
      type="button"
      className={`${className} watch-later ${saved ? 'watch-later--saved' : ''}`}
      aria-pressed={saved}
      onClick={() => toggle(item, saved)}
    >
      {saved ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
      {saved ? '✓ Saved' : '＋ My List'}
    </button>
  )
}

/** The small ＋ / ✓ on a poster card. Not on TVs (the remote moves between cards). */
export function CardSaveButton({ item }: { item: MediaItem }) {
  const saved = useWatchLater().some((e) => e.id === item.id)
  if (!item.title || isTvMode()) return null
  return (
    <button
      type="button"
      className={`poster-card__save ${saved ? 'poster-card__save--saved' : ''}`}
      aria-pressed={saved}
      aria-label={saved ? `Remove ${item.title} from My List` : `Add ${item.title} to My List`}
      onClick={() => toggle(item, saved)}
    >
      <span aria-hidden="true">{saved ? '✓' : '＋'}</span>
    </button>
  )
}

/** Home row of the titles in My List, newest first. Hidden while empty. */
export function WatchLaterRow({ onSelect }: { onSelect: (item: MediaItem) => void }) {
  const entries = useWatchLater()
  const { status } = useAccount()
  if (entries.length === 0) return null
  return (
    <MediaRow
      id="my-list"
      title="My List"
      subtitle={status === 'signedIn' ? 'On all your devices' : 'Saved on this device'}
      items={entries.map(savedItem)}
      onSelect={onSelect}
      action={
        <button type="button" className="media-row__see-all" onClick={() => goToPage('my-list')}>
          See all
        </button>
      }
    />
  )
}
