import { X } from 'lucide-react'
import { QUIET_ADS_ATTR } from '../ads/adManager'
import { isProvider, pathForDrama } from '../dramas/format'
import { episodeProgress, removeDramaEntry, useDramaHistory, type DramaHistoryEntry } from '../dramas/history'
import { officialDramaUrl, providerLabel } from '../dramas/officialLinks'
import { MediaRow } from './MediaRow'
import './DramaHistoryRow.css'

const noSelect = () => {}

/**
 * "Your short dramas" on the home page: the short dramas opened on this
 * device (or, signed in, on any), newest first, with the episode the viewer
 * said they're on and a link to carry on in the drama's own app. Hidden while
 * empty.
 */
export function DramaHistoryRow() {
  const entries = useDramaHistory()
  if (entries.length === 0) return null
  return (
    <MediaRow id="your-short-dramas" title="Your short dramas" items={[]} onSelect={noSelect}>
      {entries.map((entry) => (
        <DramaHistoryCard key={entry.id} entry={entry} />
      ))}
    </MediaRow>
  )
}

function DramaHistoryCard({ entry }: { entry: DramaHistoryEntry }) {
  const app = providerLabel(entry.provider)
  const progress = episodeProgress(entry)
  const page = isProvider(entry.provider) ? pathForDrama(entry.provider, entry.dramaId) : null
  const title = entry.title || 'Short drama'
  const poster = (
    <span className="drama-history__poster">
      {entry.poster ? <img src={entry.poster} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="drama-history__initial">{title.charAt(0)}</span>}
      <span className="drama-history__app">{app}</span>
    </span>
  )
  return (
    <article className="drama-history">
      {page ? (
        <a className="drama-history__open" href={page} aria-label={`${title}, ${app}${progress ? `, ${progress}` : ''}`}>
          {poster}
        </a>
      ) : (
        poster
      )}
      <div className="drama-history__info">
        <h3 className="drama-history__title">{title}</h3>
        {progress ? <p className="drama-history__episode">{progress}</p> : null}
        <a className="drama-history__continue" href={officialDramaUrl(entry)} target="_blank" rel="noopener noreferrer">
          Continue on {app}
        </a>
      </div>
      <button
        type="button"
        className="drama-history__remove"
        aria-label={`Remove ${title} from Your short dramas`}
        onClick={() => removeDramaEntry(entry.id)}
        {...{ [QUIET_ADS_ATTR]: '' }}
      >
        <X aria-hidden="true" />
      </button>
    </article>
  )
}
