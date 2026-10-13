import type { MediaItem } from '../types/media'
import { PosterCard, PosterCardSkeleton } from './PosterCard'
import './TitleGrid.css'

interface TitleGridProps {
  items: MediaItem[]
  isLoading?: boolean
  skeletonCount?: number
  onSelect: (item: MediaItem) => void
}

/** Responsive poster grid used by search results and the browse pages. */
export function TitleGrid({ items, isLoading = false, skeletonCount = 12, onSelect }: TitleGridProps) {
  return (
    <div className="title-grid" aria-busy={isLoading}>
      {isLoading
        ? Array.from({ length: skeletonCount }, (_, i) => <PosterCardSkeleton key={i} />)
        : items.map((item) => <PosterCard key={item.id} item={item} onSelect={onSelect} />)}
    </div>
  )
}
