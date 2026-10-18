import { useSyncExternalStore } from 'react'
import { pageview } from '@vercel/analytics'
import { promptInstall, type InstallOffer } from './pwa'

/** State for the "Download app" button and bar (components/InstallApp.tsx). */

const DISMISSED_KEY = 'naijatr.installBar.dismissedAt'
/** The bar's ✕ hides it for this long; the header button stays. */
export const BAR_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000

/** Which steps are open (iPhone or Android), if any. */
let stepsOpen: 'ios' | 'android' | null = null
let barDismissed = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function dismissedRecently(): boolean {
  if (barDismissed) return true
  try {
    const at = Number(window.localStorage.getItem(DISMISSED_KEY))
    return Number.isFinite(at) && at > 0 && Date.now() - at < BAR_SNOOZE_MS
  } catch {
    return false
  }
}

/** Shows in Vercel Analytics as a page view of `path`. */
export const trackInstall = (path: string) => pageview({ route: path, path })

/** The Download app button's click, wherever it is: the browser's dialog, or the steps for this phone. */
export function startInstall(offer: InstallOffer, from: 'header' | 'bar') {
  trackInstall(`/go/app-download?from=${from}`)
  if (offer === 'prompt') return void promptInstall()
  stepsOpen = offer
  emit()
}

export function closeInstallSteps() {
  stepsOpen = null
  emit()
}

export function dismissInstallBar() {
  barDismissed = true
  try {
    window.localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // Hidden for this visit only.
  }
  emit()
}

export const useInstallStepsOpen = () => useSyncExternalStore(subscribe, () => stepsOpen, () => null)
export const useInstallBarDismissed = () => useSyncExternalStore(subscribe, dismissedRecently, () => true)

/** Test helper. */
export function resetInstallApp() {
  stepsOpen = null
  barDismissed = false
}
