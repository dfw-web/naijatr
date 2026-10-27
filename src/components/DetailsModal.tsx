import { useEffect, useRef } from 'react'
import { CalendarDays, Clock, Star, X } from 'lucide-react'
import { AdBreak } from '../ads/AdBreak'
import { titleAdKey } from '../hooks/useAdOnce'
import { useItemDetails } from '../hooks/useCatalog'
import type { MediaItem } from '../types/media'
import { formatScore, formatVotes, formatYear, typeLabel } from '../utils/media'
import { QrCode } from '../tv/QrCode'
import { isTvMode, phoneLink } from '../tv/tvMode'
import { MediaImage } from './MediaImage'
import { MediaRow } from './MediaRow'
import { PlayerPanel } from './PlayerPanel'
import { ScreenScapeDownload } from './ScreenScapeDownload'
import { TelegramCard } from './Telegram'
import { WatchProviders } from './WatchProviders'
import { WatchLaterButton } from './WatchLater'
import { RateThis } from '../feedback/Feedback'
import { recordTaste } from '../taste/profile'
import './DetailsModal.css'

interface DetailsModalProps {
  item: MediaItem
  onClose: () => void
  /** Opens another title (the TV "More like this" row). */
  onSelect?: (item: MediaItem) => void
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const formatReleaseDate = (date: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(`${date}T00:00:00`),
  )

export function DetailsModal({ item: baseItem, onClose, onSelect }: DetailsModalProps) {
  const { state: detailState } = useItemDetails(baseItem)
  // Show what we have immediately; swap in the enriched item when it arrives.
  const item = detailState.status === 'success' ? detailState.data : baseItem
  const isLoadingMore = detailState.status === 'loading' && baseItem.tmdbId !== undefined

  // Taste: an opened details page, once its full detail (keywords, countries) is in.
  const settled = detailState.status === 'success' || detailState.status === 'error'
  const tasteItem = detailState.status === 'success' ? detailState.data : baseItem
  const openedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!settled || openedRef.current === tasteItem.id) return
    openedRef.current = tasteItem.id
    recordTaste(tasteItem, 'open')
  }, [settled, tasteItem])

  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Focus the close button, lock page scroll, close on Escape, keep Tab inside
  // the dialog, and return focus to whatever opened it when it closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    closeRef.current?.focus()

    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  const score = formatScore(item)

  return (
    <div className="modal" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby="modal-description"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          ref={closeRef}
          type="button"
          className="modal__close"
          aria-label="Close details"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>

        <div className="modal__media">
          <MediaImage
            className="modal__backdrop"
            src={item.backdrop}
            alt=""
            priority
            fallbackType={item.type}
          />
          <div className="modal__media-shade" aria-hidden="true" />
        </div>

        <div className="modal__body">
          <span className={`modal__type modal__type--${item.type}`}>{typeLabel(item.type)}</span>
          <h2 id="modal-title" className="modal__title">
            {item.title || 'Loading…'}
          </h2>
          {item.tagline && <p className="modal__tagline">{item.tagline}</p>}

          <ul className="modal__meta" aria-label="Details">
            <li className="modal__score">
              <Star aria-hidden="true" />
              {score ? (
                <>
                  {score} / 10
                  <span className="modal__votes">({formatVotes(item.voteCount)} ratings)</span>
                </>
              ) : (
                'Not yet rated'
              )}
            </li>
            <li>{formatYear(item.year)}</li>
            {item.certification && <li className="modal__rating">{item.certification}</li>}
            {item.length && (
              <li className="modal__length">
                <Clock aria-hidden="true" /> {item.length}
              </li>
            )}
          </ul>

          <div className="modal__save">
            <WatchLaterButton item={item} />
          </div>

          <p id="modal-description" className="modal__description">
            {item.description}
          </p>

          <dl className="modal__facts">
            {item.genres.length > 0 && (
              <div>
                <dt>Genres</dt>
                <dd>
                  {item.genres.map((genre) => (
                    <span key={genre} className="chip">
                      {genre}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            <div>
              <dt>{item.type === 'movie' ? 'Released' : 'First aired'}</dt>
              <dd className="modal__date">
                <CalendarDays aria-hidden="true" />
                {item.releaseDate ? formatReleaseDate(item.releaseDate) : 'To be announced'}
              </dd>
            </div>
            {item.makers && item.makers.length > 0 && (
              <div>
                <dt>{item.type === 'movie' ? 'Director' : 'Created by'}</dt>
                <dd>{item.makers.join(', ')}</dd>
              </div>
            )}
            {item.cast && item.cast.length > 0 && (
              <div>
                <dt>Starring</dt>
                <dd>{item.cast.join(', ')}</dd>
              </div>
            )}
            {item.status && (
              <div>
                <dt>Status</dt>
                <dd>{item.status}</dd>
              </div>
            )}
            {isLoadingMore && (
              <div className="modal__loading" aria-label="Loading more details" role="status">
                <dt className="skeleton skeleton--text" />
                <dd>
                  <span className="skeleton skeleton--text" />
                  <span className="skeleton skeleton--text" />
                </dd>
              </div>
            )}
            {detailState.status === 'error' && (
              <div>
                <dt>Note</dt>
                <dd className="modal__note">Some extra details couldn’t be loaded right now.</dd>
              </div>
            )}
          </dl>

          <PlayerPanel item={item} isLoading={isLoadingMore} />
          {!isTvMode() && <ScreenScapeDownload item={item} />}
          {item.watchProviders && <WatchProviders providers={item.watchProviders} />}
          <TelegramCard from="details" />
          {item.title && <RateThis titleKey={`${item.type}:${item.tmdbId ?? item.id}`} title={item.title} />}
          {isTvMode() && item.tmdbId !== undefined && (
            <div className="tv-phone-card">
              <QrCode url={phoneLink(item)} label={`QR code: watch ${item.title} on your phone`} size="7em" />
              <p>
                <strong>Scan to watch on your phone</strong>
                Opens {item.title || 'this title'} on naijatr.com.
              </p>
            </div>
          )}
        </div>
        {isTvMode() && onSelect && item.similar && item.similar.length > 0 && (
          <div className="modal__more">
            <MediaRow id="more-like-this" title="More like this" items={item.similar} onSelect={onSelect} />
          </div>
        )}
      </div>
      <AdBreak adKey={titleAdKey(baseItem)} />
    </div>
  )
}
