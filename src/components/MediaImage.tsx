import { useState } from 'react'
import { Clapperboard, Tv } from 'lucide-react'
import type { MediaType } from '../types/media'
import './MediaImage.css'

interface MediaImageProps {
  /** Image URL, or null when the title has no artwork. */
  src: string | null
  alt: string
  className?: string
  /** Load eagerly for above-the-fold images such as the hero. */
  priority?: boolean
  /** Shown on the fallback artwork when the image is missing or fails to load. */
  fallbackTitle?: string
  fallbackType?: MediaType
}

/** Image with a shimmer while loading and designed fallback artwork if it is missing or fails. */
export function MediaImage({
  src,
  alt,
  className = '',
  priority = false,
  fallbackTitle,
  fallbackType = 'movie',
}: MediaImageProps) {
  // Track which src loaded/failed, so a new src automatically resets the state.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  const status = !src || failedSrc === src ? 'error' : loadedSrc === src ? 'loaded' : 'loading'
  const Icon = fallbackType === 'series' ? Tv : Clapperboard

  return (
    <div className={`media-image media-image--${status} ${className}`}>
      {status !== 'error' && src ? (
        <img
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <div
          className={`media-image__fallback media-image__fallback--${fallbackType}`}
          role={alt ? 'img' : undefined}
          aria-label={alt || undefined}
          aria-hidden={alt ? undefined : true}
          data-testid="image-fallback"
        >
          <Icon className="media-image__fallback-icon" aria-hidden="true" />
          {fallbackTitle && <span className="media-image__fallback-title">{fallbackTitle}</span>}
          <span className="media-image__fallback-note">Artwork unavailable</span>
        </div>
      )}
    </div>
  )
}
