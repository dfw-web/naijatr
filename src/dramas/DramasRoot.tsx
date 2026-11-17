import { lazy, Suspense, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { AdsBackNotice } from '../ads/AdsBackNotice'
import { AdUpsell } from '../ads/AdUpsell'
import { rememberNoAdsFlag } from '../ads/directLink'
import { useMultitag } from '../ads/monetag'
import { analyticsBeforeSend } from '../analytics'
import { TvAdBreakHost } from '../tv/TvAdBreak'
import { TelegramGateHost } from '../gate/TelegramGate'
import { InstallAppHost } from '../components/InstallApp'
import { UpdateBar } from '../components/UpdateBar'
import { FeedbackHost } from '../feedback/Feedback'
import { WelcomePopupHost } from '../promo/WelcomePopup'

// Loaded on demand, so the movie pages never download the Short Dramas section.
const DramasApp = lazy(() => import('./DramasApp'))

export function DramasRoot() {
  // Before DramasApp rewrites the URL to its route.
  useState(() => rememberNoAdsFlag())
  // The Monetag Multitag, once (after the ?noads= check above).
  useMultitag()
  return (
    <>
      <Suspense fallback={null}>
        <DramasApp />
      </Suspense>
      {/* Vercel Web Analytics for the Short Dramas section (a separate root from App). */}
      <TvAdBreakHost />
      <TelegramGateHost />
      <AdsBackNotice />
      <AdUpsell />
      <InstallAppHost />
      <UpdateBar />
      <FeedbackHost />
      <WelcomePopupHost />
      <Analytics beforeSend={analyticsBeforeSend} />
    </>
  )
}
