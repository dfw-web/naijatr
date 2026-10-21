import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Inbox } from 'lucide-react'
import type { MediaItem } from '../types/media'
import { PosterCard, PosterCardSkeleton } from './PosterCard'
import { StatusMessage } from './StatusMessage'
import './MediaRow.css'

interface MediaRowProps {
  id: string
  title: string
  items: MediaItem[]
  subtitle?: string
  isLoading?: boolean
  /** "ranked" shows a numbered top-10 chart. */
  variant?: 'default' | 'ranked'
  onSelect: (item: MediaItem) => void
  /** Adds "Not interested" to each card's ⋯ menu. */
  onNotInterested?: (item: MediaItem) => void
  /** Cards of another kind (e.g. Continue watching), shown instead of posters for `items`. */
  children?: ReactNode
}

const SKELETON_COUNT = 7

export function MediaRow({
  id,
  title,
  subtitle,
  items,
  isLoading = false,
  variant = 'default',
  onSelect,
  onNotInterested,
  children,
}: MediaRowProps) {
  const isRanked = variant === 'ranked'
  const trackRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const track = trackRef.current
    if (!track) return
    setCanScrollLeft(track.scrollLeft > 4)
    setCanScrollRight(track.scrollLeft + track.clientWidth < track.scrollWidth - 4)
  }, [])

  useEffect(() => {
    updateScrollState()
    const track = trackRef.current
    if (!track) return
    const observer = new ResizeObserver(updateScrollState)
    observer.observe(track)
    return () => observer.disconnect()
  }, [items, children, isLoading, updateScrollState])

  const scrollByPage = (direction: 1 | -1) => {
    const track = trackRef.current
    if (!track) return
    track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: 'smooth' })
  }

  const headingId = `${id}-heading`

  return (
    <section id={id} className="media-row" aria-labelledby={headingId} aria-busy={isLoading}>
      <div className="media-row__header">
        <div>
          <h2 id={headingId} className="media-row__title">
            {title}
          </h2>
          {subtitle && <p className="media-row__subtitle">{subtitle}</p>}
        </div>
        <div className="media-row__controls">
          <button
            type="button"
            className="media-row__arrow"
            aria-label={`Scroll ${title} left`}
            disabled={!canScrollLeft}
            onClick={() => scrollByPage(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="media-row__arrow"
            aria-label={`Scroll ${title} right`}
            disabled={!canScrollRight}
            onClick={() => scrollByPage(1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>

      {!isLoading && items.length === 0 && !children ? (
        <StatusMessage icon={Inbox} title={`No titles in ${title} right now`} compact />
      ) : (
        <div
          ref={trackRef}
          className={`media-row__track ${isRanked ? 'media-row__track--ranked' : ''}`}
          onScroll={updateScrollState}
        >
          {children ??
            (isLoading
            ? Array.from({ length: SKELETON_COUNT }, (_, i) => <PosterCardSkeleton key={i} />)
            : items.map((item, index) => (
                <PosterCard
                  key={item.id}
                  item={item}
                  onSelect={onSelect}
                  onNotInterested={onNotInterested}
                  rank={isRanked ? index + 1 : undefined}
                />
              )))}
        </div>
      )}
    </section>
  )
}
