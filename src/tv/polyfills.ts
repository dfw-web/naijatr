/**
 * Small polyfills for the older Chromium builds in smart TVs (2019-2022
 * Samsung/LG sets run Chromium 64-94). Only fills what's missing.
 */

type AbortSignalStatics = typeof AbortSignal & {
  timeout?: (ms: number) => AbortSignal
  any?: (signals: AbortSignal[]) => AbortSignal
}

const Signal = (typeof AbortSignal !== 'undefined' ? AbortSignal : undefined) as AbortSignalStatics | undefined

if (Signal && !Signal.timeout) {
  Signal.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
    return controller.signal
  }
}

if (Signal && !Signal.any) {
  Signal.any = (signals: AbortSignal[]) => {
    const controller = new AbortController()
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason)
        break
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    }
    return controller.signal
  }
}

// Chromium 64-70: globalThis (a property on window is enough in a browser).
if (typeof globalThis === 'undefined') {
  ;(window as unknown as { globalThis: Window }).globalThis = window
}

// Chromium 64-68: Array.prototype.flat / flatMap.
if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true,
    writable: true,
    value: function flat(this: unknown[], depth = 1): unknown[] {
      return depth < 1
        ? this.slice()
        : this.reduce<unknown[]>((out, value) => out.concat(Array.isArray(value) ? (value as unknown[]).flat(depth - 1) : [value]), [])
    },
  })
}
if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true,
    writable: true,
    value: function flatMap(this: unknown[], fn: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      return this.map(fn, thisArg).flat()
    },
  })
}

// Chromium 64-75: Promise.allSettled.
if (!Promise.allSettled) {
  Promise.allSettled = (<T,>(values: Iterable<T>) =>
    Promise.all(
      [...values].map((value) =>
        Promise.resolve(value).then(
          (result) => ({ status: 'fulfilled' as const, value: result }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
      ),
    )) as typeof Promise.allSettled
}

export {}
