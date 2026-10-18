/**
 * Service worker for the installable app. It keeps the app shell (page,
 * scripts, styles, icons, fonts) available offline. /api, TMDB data and video
 * players always go to the network and are never cached.
 */
const CACHE = 'naija-tr-v1'
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png']
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
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

/** Pages: always try the network first so updates show up, else the cached shell. */
const page = async (request) => {
  try {
    return await put('/', await fetch(request))
  } catch {
    return (await caches.match('/')) ?? Response.error()
  }
}

/** Hashed build files never change, so a cached copy is always right. */
const cacheFirst = async (request) =>
  (await caches.match(request)) ?? put(request, await fetch(request))

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
  // Private pages (/admin/live) must never become the offline app shell.
  if (sameOrigin && url.pathname.startsWith('/admin/')) return
  if (request.mode === 'navigate' && sameOrigin) return event.respondWith(page(request))
  if (sameOrigin && url.pathname.startsWith('/assets/')) return event.respondWith(cacheFirst(request))
  if ((sameOrigin && SHELL.includes(url.pathname)) || FONT_HOSTS.includes(url.hostname)) {
    return event.respondWith(staleWhileRevalidate(request, event))
  }
})
