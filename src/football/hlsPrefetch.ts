import type Hls from 'hls.js'
import type { FetchLoader, FragmentLoaderContext, HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js'

/**
 * The stream provider's servers take 0.5-4 s to start answering each segment
 * request but then send it in ~0.1 s. hls.js asks for one segment at a time,
 * so those waits add up and playback stalls. This prefetches the next few
 * segments, two at a time so the waits overlap, and hands them to hls.js
 * through its fragment loader. Anything not prefetched (or that failed) loads
 * normally.
 *
 * Segments are ~0.75 MB (about 3 Mbit/s of video), so on a slow connection a
 * download takes a while: only a server that doesn't start answering is given
 * up on. Cancelling slow downloads (or splitting the connection between many)
 * threw the data away and stalled playback for good on mobile data.
 *
 * The source servers also refuse requests that carry another site's Referer
 * (hotlink protection), so every request here is sent without one.
 */

const NO_REFERRER: RequestInit = { referrerPolicy: 'no-referrer' }

/** hls.js's fetch loader setup: the same request, without a Referer. */
export const fetchSetup = (context: LoaderContext, initParams: RequestInit) =>
  new Request(context.url, { ...initParams, ...NO_REFERRER })

const AHEAD = 6
const KEEP = 16
/** Downloads at once: enough to overlap the slow first byte, without splitting a slow connection. */
export const MAX_PARALLEL = 2
/** A server that hasn't started answering by then is given up on (a download in progress never is). */
const FIRST_BYTE_TIMEOUT_MS = 8000

type HlsClass = typeof Hls
type FragmentLoader = Loader<FragmentLoaderContext>

export function attachPrefetcher(HlsCtor: HlsClass, FetchLoaderCtor: typeof FetchLoader) {
  const cache = new Map<string, Promise<ArrayBuffer | null>>()
  const controllers = new Set<AbortController>()
  let fragments: { sn: number; url: string }[] = []
  let current = -1
  let inFlight = 0

  const prefetch = (url: string) => {
    const controller = new AbortController()
    controllers.add(controller)
    inFlight += 1
    // A hung server must not hold up playback: give up and let hls.js load it.
    const hung = window.setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)
    cache.set(
      url,
      fetch(url, { ...NO_REFERRER, signal: controller.signal })
        .then((response) => {
          window.clearTimeout(hung)
          return response.ok ? response.arrayBuffer() : null
        })
        .catch(() => null)
        .finally(() => {
          window.clearTimeout(hung)
          controllers.delete(controller)
          inFlight -= 1
          schedule()
        }),
    )
    // Oldest first: drop segments that are long behind playback.
    while (cache.size > KEEP) cache.delete(cache.keys().next().value as string)
  }

  /** Prefetches the segments after the one being loaded (or, at start, near live), a couple at a time. */
  function schedule() {
    if (!fragments.length) return
    const next = current >= 0 ? fragments.filter((f) => f.sn > current) : fragments
    for (const f of next.slice(0, AHEAD)) {
      if (inFlight >= MAX_PARALLEL) return
      if (!cache.has(f.url)) prefetch(f.url)
    }
  }

  const Base = FetchLoaderCtor as unknown as new (config: HlsConfig) => FragmentLoader

  class PrefetchLoader extends Base {
    load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>) {
      const hit = cache.get(context.url)
      if (!hit) return super.load(context, config, callbacks)
      this.context = context
      const stats = this.stats
      stats.loading.start = performance.now()
      void hit.then((data) => {
        if (stats.aborted) return
        if (!data) {
          cache.delete(context.url)
          // The base loader refuses to start once its stats show a start time.
          stats.loading.start = 0
          return super.load(context, config, callbacks)
        }
        const now = performance.now()
        stats.loading.first = now
        stats.loading.end = now
        stats.loaded = data.byteLength
        stats.total = data.byteLength
        callbacks.onSuccess({ url: context.url, data }, stats, context, null)
      })
    }
  }

  return {
    config: {
      loader: FetchLoaderCtor as unknown as HlsConfig['loader'],
      fLoader: PrefetchLoader as unknown as HlsConfig['fLoader'],
      fetchSetup,
    },
    /** Call after creating the player, to follow its playlist and progress. */
    follow(player: Hls) {
      player.on(HlsCtor.Events.LEVEL_LOADED, (_event, data) => {
        fragments = data.details.fragments.map((f) => ({ sn: Number(f.sn), url: f.url }))
        schedule()
      })
      player.on(HlsCtor.Events.FRAG_LOADING, (_event, data) => {
        if (typeof data.frag.sn === 'number') current = data.frag.sn
        schedule()
      })
    },
    destroy() {
      fragments = []
      controllers.forEach((c) => c.abort())
      controllers.clear()
      cache.clear()
    },
  }
}
