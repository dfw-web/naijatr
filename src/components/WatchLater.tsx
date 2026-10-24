import { Bookmark, BookmarkCheck } from 'lucide-react'
import { recordTaste } from '../taste/profile'
import type { MediaItem } from '../types/media'
import { removeFromLater, saveForLater, savedItem, useWatchLater } from '../utils/watchLater'
import { MediaRow } from './MediaRow'
import './WatchLater.css'

/** "Watch later" / "Saved": saves the movie or series on this device, or takes it off the list. */
export function WatchLaterButton({ item, className = 'btn btn--ghost' }: { item: MediaItem; className?: string }) {
  const saved = useWatchLater().some((e) => e.id === item.id)
  if (!item.title) return null
  return (
    <button
      type="button"
      className={`${className} watch-later ${saved ? 'watch-later--saved' : ''}`}
      aria-pressed={saved}
      onClick={() => {
        if (saved) return removeFromLater(item.id)
        saveForLater(item)
        recordTaste(item, 'saved')
      }}
    >
      {saved ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
      {saved ? 'Saved to Watch later' : 'Watch later'}
    </button>
  )
}

/** Home row of the titles saved for later, newest first. Hidden while empty. */
export function WatchLaterRow({ onSelect }: { onSelect: (item: MediaItem) => void }) {
  const entries = useWatchLater()
  if (entries.length === 0) return null
  return (
    <MediaRow
      id="watch-later"
      title="Watch later"
      subtitle="Saved on this device"
      items={entries.map(savedItem)}
      onSelect={onSelect}
    />
  )
}
