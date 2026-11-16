/*
 * PasaBot service worker. W0c: makes the app installable. W23: an offline shell and web push.
 * - Offline shell: the app's own static files (the page, its hashed assets, icons, manifest) are cached as they load
 *   and served from the cache only when the network fails, so the installed app opens offline and says so. API,
 *   socket, MCP and hook traffic is never touched or cached (no chat data is kept on the device).
 * - Push: shows the server's notification (title, body, tag) unless a PasaBot window is already in front, and opens
 *   or focuses the app at the notification's `#/...` link when tapped. Links are app-relative only.
 */
const SHELL = 'pasabot-shell-v1';
const SKIP = /^\/(api|ws|mcp|hooks)(\/|$)/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(['/', '/manifest.webmanifest']))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('pasabot-') && k !== SHELL).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (SKIP.test(url.pathname)) return;
  const isPage = e.request.mode === 'navigate';
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          void caches.open(SHELL).then((c) => c.put(isPage ? '/' : e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(isPage ? '/' : e.request);
        return hit ?? Response.error();
      }),
  );
});

/** only `#/...` app links or `/` paths on this origin; anything else opens the app home */
const appLink = (href) => {
  if (typeof href !== 'string') return '/';
  if (href.startsWith('#/')) return `/${href}`;
  if (href.startsWith('/') && !href.startsWith('//')) return `/#${href}`;
  return '/';
};

self.addEventListener('push', (e) => {
  let n = {};
  try {
    n = e.data ? e.data.json() : {};
  } catch {
    n = {};
  }
  const title = typeof n.title === 'string' && n.title ? n.title.slice(0, 120) : 'PasaBot';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // the person is looking at PasaBot already: the in-app notice is enough
      if (n.category !== 'approval' && wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
      return self.registration.showNotification(title, {
        body: typeof n.body === 'string' ? n.body.slice(0, 300) : '',
        tag: typeof n.tag === 'string' ? n.tag : undefined,
        renotify: n.category !== 'progress' && typeof n.tag === 'string',
        silent: n.category === 'progress',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { href: appLink(n.href) },
      });
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(appLink(e.notification.data?.href), self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const w = wins.find((x) => new URL(x.url).origin === self.location.origin);
      if (w) return w.navigate(target).then((x) => (x ?? w).focus());
      return self.clients.openWindow(target);
    }),
  );
});
