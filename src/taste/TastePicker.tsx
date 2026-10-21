import { useState } from 'react'
import { PICKS, savePicks, type TastePick } from './profile'
import './taste.css'

/**
 * First visit only: "What do you like?" chips. Each pick seeds the taste
 * profile, so the home screen is personal straight away. Skippable; either
 * way it isn't asked again.
 */
export function TastePicker() {
  const [picked, setPicked] = useState<TastePick[]>([])
  const toggle = (pick: TastePick) => setPicked((p) => (p.includes(pick) ? p.filter((x) => x !== pick) : [...p, pick]))
  return (
    <section className="taste-picker" aria-labelledby="taste-picker-title">
      <h2 id="taste-picker-title" className="taste-picker__title">
        What do you like?
      </h2>
      <p className="taste-picker__note">Pick a few and we'll fill your home screen with them.</p>
      <div className="taste-picker__chips">
        {(Object.keys(PICKS) as TastePick[]).map((pick) => (
          <button
            key={pick}
            type="button"
            className="taste-picker__chip"
            aria-pressed={picked.includes(pick)}
            onClick={() => toggle(pick)}
          >
            {pick}
          </button>
        ))}
      </div>
      <div className="taste-picker__actions">
        <button type="button" className="btn btn--primary" disabled={!picked.length} onClick={() => savePicks(picked)}>
          Show my picks
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => savePicks([])}>
          Skip
        </button>
      </div>
    </section>
  )
}
