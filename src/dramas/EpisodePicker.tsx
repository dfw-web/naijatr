import { useId, useState } from 'react'
import { QUIET_ADS_ATTR } from '../ads/adManager'
import { clampEpisode, MAX_EPISODE, setDramaEpisode, useDramaHistory } from './history'

/**
 * "I'm on episode __" on a drama's page: the episode the viewer is on (most
 * watch in the drama's own app), shown on the home page's "Your short dramas"
 * row. A quiet zone: its taps never open an ad.
 */
export function EpisodePicker({ entryId }: { entryId: string }) {
  const entry = useDramaHistory().find((e) => e.id === entryId) ?? null
  const episode = entry?.episode ?? null
  const max = entry?.episodeCount ?? MAX_EPISODE
  const shown = episode === null ? '' : String(episode)
  const [draft, setDraft] = useState(shown)
  const [lastShown, setLastShown] = useState(shown)
  const inputId = useId()

  // Changed elsewhere (the buttons, another tab, another phone): shown at once.
  if (shown !== lastShown) {
    setLastShown(shown)
    setDraft(shown)
  }

  if (!entry) return null

  const save = (value: number | null) => setDramaEpisode(entryId, value)
  const step = (by: number) => save(episode === null ? 1 : clampEpisode(episode + by, entry.episodeCount))

  return (
    <div className="dr-picker" {...{ [QUIET_ADS_ATTR]: '' }}>
      <label className="dr-picker__label" htmlFor={inputId}>
        I’m on episode
      </label>
      <div className="dr-picker__control">
        <button type="button" className="dr-picker__step" aria-label="Previous episode" disabled={episode === null || episode <= 1} onClick={() => step(-1)}>
          −
        </button>
        <input
          id={inputId}
          className="dr-picker__input"
          type="number"
          inputMode="numeric"
          min={1}
          max={max}
          step={1}
          placeholder="–"
          value={draft}
          onChange={(event) => {
            const text = event.target.value
            setDraft(text)
            const value = Number(text)
            if (text === '') save(null)
            else if (Number.isFinite(value) && value >= 1) save(value)
          }}
          // Typed past the end or a fraction: show what was kept.
          onBlur={() => setDraft(shown)}
        />
        <button type="button" className="dr-picker__step" aria-label="Next episode" disabled={episode !== null && episode >= max} onClick={() => step(1)}>
          +
        </button>
      </div>
      {entry.episodeCount ? <span className="dr-picker__of">of {entry.episodeCount}</span> : null}
    </div>
  )
}
