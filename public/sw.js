/**
 * Service worker for the installable app. It keeps the app shell (page,
 * scripts, styles, icons, fonts) available offline. /api, /_vercel (analytics),
 * TMDB data, ads and video players always go to the network and are never cached.
 *
 * Updates: the build (vite.config.ts, swBuildId) writes a new BUILD into
 * dist/sw.js on every deploy, so the browser sees a changed worker, installs
 * it, and it takes over at once (skipWaiting + clients.claim). Old caches are
 * deleted, and the open app shows "New update available, tap to refresh"
 * (src/pwa.ts, src/components/UpdateBar.tsx).
 */
const BUILD = '__BUILD_ID__'
const CACHE = `naija-tr-v2-${BUILD}`
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png']
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']

/** The /assets/ files (hashed JS and CSS) a page loads, so the new version also works offline. */
const assetsIn = (html) => [...new Set(html.match(/\/assets\/[^"'\s)]+/g) ?? [])]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // cache: 'reload' skips the browser's HTTP cache, so this is the version just deployed.
      await cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' })))
      try {
        const page = await cache.match('/')
        if (page) await cache.addAll(assetsIn(await page.text()))
      } catch {
        // Fetched again as the page loads them.
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

const put = async (request, response) => {
  if (response.ok || response.type === 'opaque') {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  }
  return response
}

/** Pages (index.html): always the network first, so a new version shows at once; offline, the cached shell. */
const page = async (request) => {
  try {
    // Vercel sends index.html with max-age=0, must-revalidate: this always checks the server.
    return await put('/', await fetch(request))
  } catch {
    return (await caches.match('/')) ?? Response.error()
  }
}

/**
 * Hashed build files (/assets/index-AbC123.js) never change: a new version has
 * new names, so the cached copy is always right. A file that no longer exists
 * comes back as the index.html page (vercel.json's catch-all), which is never
 * stored as a script.
 */
const asset = async (request) => {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if ((response.headers.get('content-type') ?? '').includes('text/html')) return response
  return put(request, response)
}

/** Fonts and icons: serve the cached copy, refresh it in the background. */
const staleWhileRevalidate = async (request, event) => {
  const cached = await caches.match(request)
  const fresh = fetch(request).then((response) => put(request, response))
  if (cached) {
    event.waitUntil(fresh.catch(() => undefined))
    return cached
  }
  return fresh
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin

  if (sameOrigin && url.pathname.startsWith('/api/')) return
  // Vercel Web Analytics and Speed Insights (/_vercel/insights, /_vercel/speed-insights).
  if (sameOrigin && url.pathname.startsWith('/_vercel/')) return
  // Private pages (/admin/live) must never become the offline app shell.
  if (sameOrigin && url.pathname.startsWith('/admin/')) return
  // Plain files (embedmaster_verify.txt and other site verification files) go straight to the network.
  if (sameOrigin && url.pathname.endsWith('.txt')) return
  if (request.mode === 'navigate' && sameOrigin) return event.respondWith(page(request))
  if (sameOrigin && url.pathname.startsWith('/assets/')) return event.respondWith(asset(request))
  if ((sameOrigin && SHELL.includes(url.pathname)) || FONT_HOSTS.includes(url.hostname)) {
    return event.respondWith(staleWhileRevalidate(request, event))
  }
})
