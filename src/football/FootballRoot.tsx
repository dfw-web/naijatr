import { lazy, Suspense, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { AdsBackNotice } from '../ads/AdsBackNotice'
import { rememberNoAdsFlag } from '../ads/directLink'
import { useMultitag } from '../ads/monetag'
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
  // The Monetag Multitag, once (after the ?noads= check above).
  useMultitag()
  return (
    <>
      <Suspense fallback={null}>
        <FootballApp />
      </Suspense>
      {/* Vercel Web Analytics for the Football section (a separate root from App). */}
      <TvAdBreakHost />
      <TelegramGateHost />
      <AdsBackNotice />
      <InstallAppHost />
      <FeedbackHost />
      <Analytics beforeSend={analyticsBeforeSend} />
    </>
  )
}
