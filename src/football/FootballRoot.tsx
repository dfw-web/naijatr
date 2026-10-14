import { lazy, Suspense } from 'react'

// Loaded on demand, so the movie pages never download the Football section.
const FootballApp = lazy(() => import('./FootballApp'))

export function FootballRoot() {
  return (
    <Suspense fallback={null}>
      <FootballApp />
    </Suspense>
  )
}
