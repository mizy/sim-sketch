const cacheName = 'sim-sketch-shell-v3';
const shell = [
  './', './index.html', './style.css', './app.js', './board.js', './project.js', './vision.js', './gpu-board.js',
  './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './maskable.png'
].map(path => new URL(path, self.registration.scope).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('sim-sketch-shell-') && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate' && new URL(request.url).href.startsWith(self.registration.scope)) {
    event.respondWith(caches.match(shell[1]).then(cached => cached || fetch(request)));
  } else if (shell.includes(request.url)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});

self.addEventListener('message', event => {
  if (event.data === 'activate-update') event.waitUntil(self.skipWaiting());
});
