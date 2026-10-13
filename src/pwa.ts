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
