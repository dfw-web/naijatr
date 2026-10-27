import { useSyncExternalStore } from 'react'
import { holdAdsThisTap } from '../ads/adManager'

/** The invite guide's open/closed state, shared by the header button, the popup and the banner. */

export const SHARE_TEXT = 'I watch movies, series & live football on NAIJA TR 🍿⚽ Join with my link 👉'

let guideOpen = false
const guideListeners = new Set<() => void>()
export function openInviteGuide() {
  // No ad on the tap that opens the guide.
  holdAdsThisTap()
  guideOpen = true
  guideListeners.forEach((l) => l())
}
export function closeInviteGuide() {
  guideOpen = false
  guideListeners.forEach((l) => l())
}
export const useGuideOpen = () =>
  useSyncExternalStore(
    (l) => {
      guideListeners.add(l)
      return () => {
        guideListeners.delete(l)
      }
    },
    () => guideOpen,
    () => false,
  )


/** Set by the /challenge pages' "Get my invite link": the home page opens the guide. */
export const OPEN_GUIDE_KEY = 'naijatr.invite.open'

/** The challenge pages: a separate root, like Football. */
export const isChallengePath = (path: string) => /^\/challenge(\/(rules|claim))?\/?$/.test(path)
