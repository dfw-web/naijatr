import { useState } from 'react'
import { resetTaste } from './profile'
import './taste.css'

/** Footer: the privacy note and "Reset recommendations". */
export function ResetRecommendations() {
  const [done, setDone] = useState(false)
  return (
    <div className="footer__taste">
      <p>Recommendations are based on what you watch on this device.</p>
      {done ? (
        <p role="status">Recommendations reset.</p>
      ) : (
        <button
          type="button"
          onClick={() => {
            resetTaste()
            setDone(true)
          }}
        >
          Reset recommendations
        </button>
      )}
    </div>
  )
}
