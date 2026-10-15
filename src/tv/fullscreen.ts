/** Fullscreen with the webkit-prefixed fallback older TV browsers (Chromium < 71) need. */

type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void }
type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => void
  webkitFullscreenEnabled?: boolean
}

export const fullscreenElement = (): Element | null =>
  document.fullscreenElement ?? (document as WebkitDocument).webkitFullscreenElement ?? null

/** False where only videos can go fullscreen (iPhone Safari). */
export const fullscreenSupported = (): boolean =>
  Boolean(document.fullscreenEnabled ?? (document as WebkitDocument).webkitFullscreenEnabled)

/** Calls `onChange` whenever something enters or leaves fullscreen. Returns the unsubscribe. */
export function onFullscreenChange(onChange: () => void): () => void {
  document.addEventListener('fullscreenchange', onChange)
  document.addEventListener('webkitfullscreenchange', onChange)
  return () => {
    document.removeEventListener('fullscreenchange', onChange)
    document.removeEventListener('webkitfullscreenchange', onChange)
  }
}

/** Must run inside a key press or click. Failure (not allowed, unsupported) is ignored. */
export function enterFullscreen(el: HTMLElement | null) {
  if (!el || fullscreenElement()) return
  try {
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => undefined)
    else (el as WebkitElement).webkitRequestFullscreen?.()
  } catch {
    // Stays in the page; everything still works.
  }
}

export function exitFullscreen() {
  try {
    if (document.exitFullscreen) void document.exitFullscreen().catch(() => undefined)
    else (document as WebkitDocument).webkitExitFullscreen?.()
  } catch {
    // Nothing to exit.
  }
}
