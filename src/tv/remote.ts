/**
 * TV remote control: arrow keys move focus to the nearest item in that
 * direction (spatial navigation), OK/Enter activates it (native behaviour),
 * and Back closes the top layer (fullscreen player, ad break, dialog) or goes
 * back a page. Only installed in TV mode (see main.tsx).
 */

import { exitFullscreen, fullscreenElement } from './fullscreen'

export type Direction = 'up' | 'down' | 'left' | 'right'

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
}

/** Back on TV remotes: Samsung (10009), LG (461), Android TV / Fire TV (GoBack, BrowserBack). */
const BACK_KEYS = new Set(['GoBack', 'BrowserBack', 'XF86Back'])
const BACK_CODES = new Set([10009, 461])

/** Media keys, forwarded to the player as a `tv:media` event. */
const MEDIA: Record<string, 'toggle' | 'play' | 'pause'> = {
  MediaPlayPause: 'toggle',
  MediaPlay: 'play',
  MediaPause: 'pause',
}
const MEDIA_CODES: Record<number, 'toggle' | 'play' | 'pause'> = { 179: 'toggle', 10252: 'toggle', 415: 'play', 19: 'pause' }

export const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const rangeGap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, b1 - a2, a1 - b2)

/**
 * Index of the best candidate to move to from `from` in `direction`, or -1.
 * A candidate must lie further that way (by its centre and leading edge).
 * The closest one wins, strongly preferring items that line up with `from`
 * (so Down from a card goes to the card below it, not one off to the side).
 */
export function pickNext(from: Box, candidates: Box[], direction: Direction): number {
  const fx = (from.left + from.right) / 2
  const fy = (from.top + from.bottom) / 2
  let best = -1
  let bestScore = Infinity
  candidates.forEach((c, index) => {
    const cx = (c.left + c.right) / 2
    const cy = (c.top + c.bottom) / 2
    let gap: number
    let offAxis: number
    let drift: number
    if (direction === 'right' || direction === 'left') {
      const ahead = direction === 'right' ? cx > fx + 1 && c.left > from.left : cx < fx - 1 && c.right < from.right
      if (!ahead) return
      gap = Math.max(0, direction === 'right' ? c.left - from.right : from.left - c.right)
      offAxis = rangeGap(from.top, from.bottom, c.top, c.bottom)
      drift = Math.abs(cy - fy)
    } else {
      const ahead = direction === 'down' ? cy > fy + 1 && c.top > from.top : cy < fy - 1 && c.bottom < from.bottom
      if (!ahead) return
      gap = Math.max(0, direction === 'down' ? c.top - from.bottom : from.top - c.bottom)
      offAxis = rangeGap(from.left, from.right, c.left, c.right)
      drift = Math.abs(cx - fx)
    }
    const score = gap + offAxis * 3 + drift * 0.05
    if (score < bestScore) {
      bestScore = score
      best = index
    }
  })
  return best
}

const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(el.type))

function isVisible(el: HTMLElement) {
  if (el.closest('[inert]')) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return false
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

/** Where focus may go: the fullscreen element, else the top open dialog, else the page. */
export function focusScope(): ParentNode {
  const fullscreen = fullscreenElement()
  if (fullscreen) return fullscreen
  const dialogs = document.querySelectorAll('[aria-modal="true"]')
  return dialogs.length ? dialogs[dialogs.length - 1] : document
}

export const focusablesIn = (scope: ParentNode) =>
  [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible)

const toBox = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

/** True when `el` sits in a fixed or sticky layer (the navbar, a dialog). */
function isPinned(el: HTMLElement) {
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    const { position } = getComputedStyle(node)
    if (position === 'fixed' || position === 'sticky') return true
  }
  return false
}

export function focusItem(el: HTMLElement, direction?: Direction) {
  el.focus({ preventScroll: true })
  // Up/Down on the page: keep the focused row near the middle of the screen.
  // Left/Right, and inside fixed layers (navbar, dialogs): only scroll as far
  // as needed, so nothing jumps.
  const vertical = direction === 'up' || direction === 'down' || direction === undefined
  el.scrollIntoView({ block: vertical && !isPinned(el) ? 'center' : 'nearest', inline: 'nearest' })
}

const onScreen = (el: HTMLElement) => {
  const r = el.getBoundingClientRect()
  return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth
}

/**
 * The first item of the open dialog, or of the page's main content that's on
 * screen (the hero's button, not a row further down that loaded first).
 * With `onScreenOnly`, null until such an item exists.
 */
export function firstItem(onScreenOnly = false): HTMLElement | null {
  const scope = focusScope()
  if (scope !== document) return focusablesIn(scope)[0] ?? null
  const main = document.querySelector('main, [data-tv-start]')
  const items = main ? focusablesIn(main) : focusablesIn(document)
  const visible = items.find(onScreen)
  if (visible || onScreenOnly) return visible ?? null
  return items[0] ?? focusablesIn(document)[0] ?? null
}

export function moveFocus(direction: Direction, lastBox: Box | null): boolean {
  const scope = focusScope()
  const active = document.activeElement as HTMLElement | null
  const inScope = active && active !== document.body && (scope === document || (scope as Element).contains(active))
  const candidates = focusablesIn(scope).filter((el) => el !== active)
  if (!candidates.length) return false
  if (!inScope) {
    // Focus was lost (its element went away) or is outside the open layer:
    // pick up again next to where it was, else at the start.
    const target = lastBox
      ? candidates[pickNearest(lastBox, candidates.map((el) => toBox(el.getBoundingClientRect())))]
      : firstItem()
    if (target) focusItem(target)
    return Boolean(target)
  }
  const index = pickNext(toBox(active.getBoundingClientRect()), candidates.map((el) => toBox(el.getBoundingClientRect())), direction)
  if (index < 0) {
    // Nothing further up: show the top of the page (the navbar is always there).
    if (direction === 'up' && scope === document) window.scrollTo({ top: 0 })
    return false
  }
  focusItem(candidates[index], direction)
  return true
}

function pickNearest(from: Box, boxes: Box[]) {
  let best = 0
  let bestDistance = Infinity
  boxes.forEach((b, i) => {
    const d = Math.hypot((b.left + b.right) / 2 - (from.left + from.right) / 2, (b.top + b.bottom) / 2 - (from.top + from.bottom) / 2)
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  })
  return best
}

/** Sends Escape to whatever handles it (dialogs, the ad break, the search box). */
const sendEscape = () =>
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
  )

/** Back: close the top layer, else go back a page. Returns false to leave it to the browser. */
export function goBack(): boolean {
  if (fullscreenElement()) {
    exitFullscreen()
    return true
  }
  if (document.querySelector('[aria-modal="true"]')) {
    sendEscape()
    return true
  }
  // A page's own Back link (e.g. Football's "All football").
  const backLink = document.querySelector<HTMLElement>('[data-tv-back]')
  if (backLink) {
    backLink.click()
    return true
  }
  const atHome = window.location.pathname === '/' && !window.location.hash && !window.location.search
  if (!atHome && window.history.length > 1) {
    window.history.back()
    return true
  }
  return false
}

let installed = false

/** Installs the remote handlers once. Returns an uninstall function (for tests). */
export function installRemote() {
  if (installed) return () => undefined
  installed = true
  let lastBox: Box | null = null

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target as HTMLElement
    if (target instanceof HTMLElement && target.getBoundingClientRect) lastBox = toBox(target.getBoundingClientRect())
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const active = document.activeElement

    const media = MEDIA[event.key] ?? MEDIA_CODES[event.keyCode]
    if (media) {
      window.dispatchEvent(new CustomEvent('tv:media', { detail: media }))
      event.preventDefault()
      return
    }

    const isBack =
      BACK_KEYS.has(event.key) ||
      BACK_CODES.has(event.keyCode) ||
      (event.key === 'Backspace' && !isTextField(active))
    // A real Escape key is already handled by dialogs, the ad break and the
    // search box; only act on it when nothing else will.
    const isUnclaimedEscape =
      event.key === 'Escape' && !document.querySelector('[aria-modal="true"]') && !fullscreenElement() && !isTextField(active)
    if (isBack || isUnclaimedEscape) {
      if (goBack()) event.preventDefault()
      return
    }

    const direction = ARROWS[event.key]
    if (!direction) {
      // OK on a <select>: open its list where the browser can.
      if (event.key === 'Enter' && active instanceof HTMLSelectElement && 'showPicker' in active) {
        try {
          active.showPicker()
          event.preventDefault()
        } catch {
          // Not allowed here; the TV's own handling applies.
        }
      }
      return
    }
    // In a text box, Left/Right move the caret until it reaches the end.
    if (isTextField(active) && !active.readOnly && (direction === 'left' || direction === 'right')) {
      const atStart = active.selectionStart === 0 && active.selectionEnd === 0
      const atEnd = active.selectionStart === active.value.length
      if ((direction === 'left' && !atStart) || (direction === 'right' && !atEnd)) return
    }
    if (moveFocus(direction, lastBox)) event.preventDefault()
    else if (direction !== 'up') event.preventDefault() // never scroll focus off-screen
  }

  // Focus must never be lost: at the start, after a page change, or when the
  // focused item disappears (a list reloads), put it back, on the new page's
  // first item on screen, else next to where it was.
  let focusedHref = window.location.href
  const timer = window.setInterval(() => {
    const active = document.activeElement
    if ((active && active !== document.body) || fullscreenElement()) {
      focusedHref = window.location.href
      return
    }
    const pageChanged = window.location.href !== focusedHref || !lastBox
    let target = firstItem(true)
    if (!pageChanged && lastBox) {
      const nearby = focusablesIn(focusScope()).filter(onScreen)
      if (nearby.length) target = nearby[pickNearest(lastBox, nearby.map((el) => toBox(el.getBoundingClientRect())))]
    }
    if (target) {
      target.focus({ preventScroll: true })
      focusedHref = window.location.href
    }
  }, 400)

  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('focusin', onFocusIn)
  return () => {
    installed = false
    window.clearInterval(timer)
    window.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('focusin', onFocusIn)
  }
}
