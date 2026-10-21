import { lazy, Suspense } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { analyticsBeforeSend } from '../analytics'

// Loaded on demand, so the movie pages never download the challenge pages.
const ChallengeApp = lazy(() => import('./ChallengeApp'))

/** /challenge, /challenge/rules and /challenge/claim: a separate root, like Football. */
export function ChallengeRoot() {
  return (
    <>
      <Suspense fallback={null}>
        <ChallengeApp />
      </Suspense>
      <Analytics beforeSend={analyticsBeforeSend} />
    </>
  )
}
