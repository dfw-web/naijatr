import { Download } from 'lucide-react'
import type { MediaItem } from '../types/media'
import './WorkerDownload.css'

/** ScreenScape provides title download pages, not a direct file API. */
export function ScreenScapeDownload({ item }: { item: MediaItem }) {
  if (!Number.isSafeInteger(item.tmdbId) || Number(item.tmdbId) <= 0) return null
  const type = item.type === 'series' ? 'tv' : 'movie'
  return (
    <section className="worker-download" aria-label="Download">
      <a className="btn btn--ghost" href={`https://nxsha.screenscape.me/download/${type}/${item.tmdbId}`} target="_blank" rel="noopener noreferrer">
        <Download aria-hidden="true" /> Download
      </a>
      <p className="worker-download__hint">
        Opens ScreenScape in a new tab. Choose {type === 'tv' ? 'your season, episode and ' : ''}a quality and available download link there.
      </p>
    </section>
  )
}
