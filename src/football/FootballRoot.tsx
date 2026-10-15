import { lazy, Suspense } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { hashRouteAsPath } from '../analytics'

// Loaded on demand, so the movie pages never download the Football section.
const FootballApp = lazy(() => import('./FootballApp'))

export function FootballRoot() {
  return (
    <>
      <Suspense fallback={null}>
        <FootballApp />
      </Suspense>
      {/* Vercel Web Analytics for the Football section (a separate root from App). */}
      <Analytics beforeSend={hashRouteAsPath} />
    </>
  )
}
