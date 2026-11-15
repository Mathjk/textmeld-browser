const root = new URL('./', self.registration.scope)
const cacheName = 'textmeld-browser-shell-v1.4.1-' + root.pathname
const url = (file) => new URL(file, root).href

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName)
    const response = await fetch(root.href, { cache: 'reload' })
    if (!response.ok) throw new Error('Editor assets are unavailable')
    const html = await response.clone().text()
    const assets = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((match) => url(match[1]))
    await cache.addAll([...assets, 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable.png',
      'model-files.json', 'google-fonts-catalog.json'].map((item) => url(item)))
    await cache.put(root.href, response)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((name) => name.startsWith('textmeld-browser-shell-') &&
      name.endsWith('-' + root.pathname) && name !== cacheName).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(root.href)) return
  const relative = event.request.url.slice(root.href.length)
  if (relative.startsWith('models/')) return
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match(root.href)) || Response.error()))
    return
  }
  if (!/^(assets\/|runtime\/|icon-|manifest\.webmanifest|model-files\.json|google-fonts-catalog\.json)/.test(relative)) return
  event.respondWith((async () => {
    const cache = await caches.open(cacheName)
    const cached = await cache.match(event.request.url, { ignoreVary: true })
    if (cached) return cached
    const response = await fetch(event.request)
    if (response.ok) await cache.put(event.request, response.clone())
    return response
  })())
})
