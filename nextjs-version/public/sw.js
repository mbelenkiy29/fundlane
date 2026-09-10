const SHELL_CACHE = "mca-shell-v1"
const SHELL_ASSETS = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)))
})

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))))
})

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting()
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // API responses, documents, and authenticated pages always go to the network.
  // Only the small public install shell is cacheable.
  if (!SHELL_ASSETS.includes(url.pathname)) return
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)))
})
