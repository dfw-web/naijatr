import { lazy, Suspense, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { rememberNoAdsFlag } from '../ads/directLink'
import { analyticsBeforeSend } from '../analytics'
import { TvAdBreakHost } from '../tv/TvAdBreak'
import { TelegramGateHost } from '../gate/TelegramGate'
import { InstallAppHost } from '../components/InstallApp'
import { FeedbackHost } from '../feedback/Feedback'

// Loaded on demand, so the movie pages never download the Football section.
const FootballApp = lazy(() => import('./FootballApp'))

export function FootballRoot() {
  // Before FootballApp rewrites the URL to its route.
  useState(() => rememberNoAdsFlag())
  return (
    <>
      <Suspense fallback={null}>
        <FootballApp />
      </Suspense>
      {/* Vercel Web Analytics for the Football section (a separate root from App). */}
      <TvAdBreakHost />
      <TelegramGateHost />
      <InstallAppHost />
      <FeedbackHost />
      <Analytics beforeSend={analyticsBeforeSend} />
    </>
  )
}
