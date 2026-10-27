import { Info, ListVideo, Star } from 'lucide-react'
import { cardAd } from '../ads/adManager'
import type { MediaItem } from '../types/media'
import { formatScore, formatYear, typeLabel } from '../utils/media'
import { MediaImage } from './MediaImage'
import { WatchLaterButton } from './WatchLater'
import './Hero.css'

interface HeroProps {
  item: MediaItem | null
  onViewDetails: (item: MediaItem) => void
  onBrowse: () => void
}

export function Hero({ item, onViewDetails, onBrowse }: HeroProps) {
  if (!item) {
    return (
      <section className="hero hero--loading" aria-busy="true" aria-label="Loading featured title">
        <div className="hero__backdrop skeleton" />
        <div className="hero__content">
          <div className="skeleton skeleton--text" style={{ width: '9rem' }} />
          <div className="skeleton skeleton--title" />
          <div className="skeleton skeleton--text" style={{ width: '80%' }} />
          <div className="skeleton skeleton--text" style={{ width: '60%' }} />
          <div className="skeleton skeleton--button" />
        </div>
      </section>
    )
  }

  const score = formatScore(item)

  return (
    <section className="hero" aria-labelledby="hero-title">
      <MediaImage
        className="hero__backdrop"
        src={item.backdrop}
        alt=""
        priority
        fallbackType={item.type}
      />
      <div className="hero__shade" aria-hidden="true" />

      <div className="hero__content">
        <p className="hero__eyebrow">
          <span className="hero__badge">Featured</span>
          {[typeLabel(item.type), item.genres.slice(0, 3).join(' / ')].filter(Boolean).join(' · ')}
        </p>

        <h1 id="hero-title" className="hero__title">
          {item.title}
        </h1>

        <ul className="hero__meta" aria-label="Details">
          {score && (
            <li className="hero__score">
              <Star aria-hidden="true" /> {score}
            </li>
          )}
          <li>{formatYear(item.year)}</li>
          {item.certification && <li className="hero__rating">{item.certification}</li>}
          {item.length && <li>{item.length}</li>}
        </ul>

        <p className="hero__description">{item.description}</p>

        <div className="hero__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={(event) => {
              cardAd(event.nativeEvent, item)
              onViewDetails(item)
            }}
          >
            <Info aria-hidden="true" /> View Details
          </button>
          <WatchLaterButton item={item} />
          <button type="button" className="btn btn--ghost" onClick={onBrowse}>
            <ListVideo aria-hidden="true" /> Browse Trending
          </button>
        </div>
      </div>
    </section>
  )
}
