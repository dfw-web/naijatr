import { useSyncExternalStore } from 'react'

/** Chrome/Edge/Android event that lets the page show its own "Install" button. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

/** Keeps the browser's install prompt so the Install button can show it later. */
export function listenForInstallPrompt(target: Window = window) {
  const onPrompt = (event: Event) => {
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    notify()
  }
  const onInstalled = () => {
    deferred = null
    notify()
  }
  target.addEventListener('beforeinstallprompt', onPrompt)
  target.addEventListener('appinstalled', onInstalled)
  return () => {
    target.removeEventListener('beforeinstallprompt', onPrompt)
    target.removeEventListener('appinstalled', onInstalled)
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Shows the browser's install dialog; the button hides once it has been used. */
export async function promptInstall() {
  const event = deferred
  if (!event) return
  deferred = null
  notify()
  await event.prompt()
  await event.userChoice
}

/** True while the browser allows installing the app (never inside the installed app). */
export const useCanInstall = () =>
  useSyncExternalStore(
    subscribe,
    () => deferred !== null,
    () => false,
  )

/** Registers the offline service worker in production builds. */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // The site still works without it, just not offline or installable.
    })
  })
}

/** Running as the installed app (from the home screen), not in a browser tab. */
export function isInstalledApp(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch {
    // Old browsers: fall through.
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** iPhone and iPad (iPadOS asks for the desktop site: a Mac with a touch screen). Safari can't prompt; the app is added from the Share menu. */
export function isIos(userAgent = navigator.userAgent, touchPoints = navigator.maxTouchPoints || 0): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)
}

export type InstallOffer = 'prompt' | 'ios' | 'android'

/**
 * How this visitor can get the app: "prompt" (the browser's install dialog,
 * Chrome/Edge), "ios" (Share › Add to Home Screen), "android" (the browser
 * menu's Install app, e.g. inside Telegram's browser, which has no dialog),
 * or null (already installed, or a desktop browser that can't).
 */
export function useInstallOffer(): InstallOffer | null {
  const canInstall = useCanInstall()
  if (isInstalledApp()) return null
  if (canInstall) return 'prompt'
  if (isIos()) return 'ios'
  return /Android/i.test(navigator.userAgent) ? 'android' : null
}
