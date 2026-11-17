import { X } from 'lucide-react'
import { QUIET_ADS_ATTR } from '../ads/adManager'
import { isProvider, pathForDrama, providerLabel, resumePath } from '../dramas/format'
import { continueLabel, episodeProgress, removeDramaEntry, useDramaHistory, type DramaHistoryEntry } from '../dramas/history'
import { MediaRow } from './MediaRow'
import './DramaHistoryRow.css'

const noSelect = () => {}

const NO_BREAK = String.fromCharCode(160)

/** "Continue Ep 12 · 3:45" with no-break spaces, so "Ep 12" and "· 3:45" never split across lines. */
const keepTogether = (label: string) => label.replace(/Ep (\d+)/, `Ep${NO_BREAK}$1`).replace(' · ', ` ·${NO_BREAK}`)

/**
 * "Your short dramas" on the home page: the short dramas opened on this
 * device (or, signed in, on any), newest first. "Continue Ep 12 · 3:45" opens
 * our own player at the episode and time they stopped at. Hidden while empty.
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
  const { provider } = entry
  const page = isProvider(provider) ? pathForDrama(provider, entry.dramaId) : null
  const resume = isProvider(provider) ? resumePath(provider, entry.dramaId) : null
  const title = entry.title || 'Short drama'
  const label = continueLabel(entry)
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
        {resume ? (
          <a className="drama-history__continue" href={resume} aria-label={`${label}, ${title}`}>
            <span aria-hidden="true">▶ {keepTogether(label)}</span>
          </a>
        ) : null}
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
