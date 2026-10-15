import { Star } from 'lucide-react'
import { useAdOnce } from '../hooks/useAdOnce'
import type { MediaItem } from '../types/media'
import { formatScore, formatVotes, formatYear, typeLabel } from '../utils/media'
import { MediaImage } from './MediaImage'
import './PosterCard.css'

interface PosterCardProps {
  item: MediaItem
  onSelect: (item: MediaItem) => void
  /** Chart position; shows a large rank numeral beside the poster. */
  rank?: number
}

export function PosterCard({ item, onSelect, rank }: PosterCardProps) {
  const openAd = useAdOnce()
  const score = formatScore(item)
  const label = [
    item.title,
    typeLabel(item.type),
    formatYear(item.year),
    score ? `rated ${score} out of 10` : 'not yet rated',
    ...(rank ? [`number ${rank} in Trending Now`] : []),
  ].join(', ')

  return (
    <article className={`poster-card ${rank ? 'poster-card--ranked' : ''}`}>
      {rank && (
        <span className="poster-card__rank" aria-hidden="true">
          {rank}
        </span>
      )}
      <button
        type="button"
        className="poster-card__button"
        onClick={(event) => {
          openAd(event, item)
          onSelect(item)
        }}
        aria-label={`View details for ${label}`}
      >
        <div className="poster-card__frame">
          <MediaImage
            className="poster-card__image"
            src={item.poster}
            alt=""
            fallbackTitle={item.title}
            fallbackType={item.type}
          />
          <span className={`poster-card__type poster-card__type--${item.type}`}>
            {typeLabel(item.type)}
          </span>
          <span className={`poster-card__score ${score ? '' : 'poster-card__score--none'}`}>
            {score ? (
              <>
                <Star aria-hidden="true" /> {score}
              </>
            ) : (
              'Not rated'
            )}
          </span>
          <div className="poster-card__overlay" aria-hidden="true">
            <span className="poster-card__overlay-meta">
              {[item.certification, item.length].filter(Boolean).join(' · ')}
            </span>
            {item.voteCount > 0 && (
              <span className="poster-card__votes">{formatVotes(item.voteCount)} ratings</span>
            )}
            <span className="poster-card__genres">{item.genres.slice(0, 3).join(' · ')}</span>
            <span className="poster-card__cta">View details</span>
          </div>
        </div>

        <div className="poster-card__info">
          <h3 className="poster-card__title">{item.title}</h3>
          <p className="poster-card__meta">
            {formatYear(item.year)}
            {item.genres[0] && ` · ${item.genres[0]}`}
          </p>
        </div>
      </button>
    </article>
  )
}

export function PosterCardSkeleton() {
  return (
    <div className="poster-card poster-card--skeleton" aria-hidden="true">
      <div className="poster-card__frame skeleton" />
      <div className="poster-card__info">
        <div className="skeleton skeleton--text" style={{ width: '85%' }} />
        <div className="skeleton skeleton--text" style={{ width: '50%' }} />
      </div>
    </div>
  )
}
