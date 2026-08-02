// Na Nirand Kaizen — Service Worker
// Handles push notifications AND runtime caching of the app shell (see the fetch handler).

// Sole purpose: give this file different bytes on every release. A browser only
// installs a new worker when the fetched sw.js differs from the installed one,
// and that install is what drives the auto-update in index.html
// (skipWaiting → clients.claim → controllerchange → reload). If sw.js is
// byte-identical, installed PWAs stay on the old build indefinitely.
//
// The deploy workflow rewrites this line with the commit SHA — do NOT rely on
// editing it by hand. It sat at 'kaizen-v3' for 184 commits and silently
// disabled the update path for every release in between.
const BUILD_ID = 'kaizen-e3b4cc268401cc5ad84f525bae94688516f2dcb5'

// Runtime cache for the app shell, keyed on BUILD_ID so each release starts a fresh cache
// and old ones are pruned on activate. See the fetch handler for the caching strategy.
const CACHE_NAME = `kaizen-shell-${BUILD_ID}`

// Set the home-screen app badge. On iOS the Badging API may be exposed on the
// worker's `self.navigator` (newer) or not at all (older). Try every surface
// and log the outcome so we can confirm what the device supports.
function setBadge(count) {
  try {
    const nav = self.navigator
    if (nav && typeof nav.setAppBadge === 'function') {
      if (count > 0) return nav.setAppBadge(count).catch((e) => console.log('[sw] setAppBadge rejected', e))
      return nav.clearAppBadge().catch((e) => console.log('[sw] clearAppBadge rejected', e))
    }
    console.log('[sw] setAppBadge NOT available in worker scope')
  } catch (e) {
    console.log('[sw] setBadge threw', e)
  }
  return Promise.resolve()
}

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting()
})

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop shells cached by previous builds so a new release doesn't accrete stale caches.
    // Guard the cache work: if Cache Storage is unavailable (restricted/partitioned storage,
    // quota exhausted on a low-end phone), a throw here must NOT skip clients.claim() — that
    // claim is what lets the auto-update flow (skipWaiting → controllerchange → reload) take
    // control of the open page. Losing the cache cleanup is harmless; losing claim is not.
    try {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith('kaizen-shell-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      )
    } catch (e) {
      console.log('[sw] cache cleanup skipped', e)
    }
    await clients.claim()
  })())
})

// ── Fetch: app-shell runtime cache ─────────────────────────────────────────────
// Android kills the backgrounded tab while the native camera is open; the OS-forced reload
// that follows used to re-download the entire JS bundle over weak hotel Wi-Fi (slow blank
// screen — the visible symptom users report). We cache-first the immutable, content-hashed
// build assets so that reload serves them from disk instead.
//
// Scope is deliberately narrow and safe:
//   • ONLY same-origin GETs under /assets/ (Vite hashes these — the URL changes whenever the
//     bytes change, so a cached copy can never be stale).
//   • index.html is NOT cached — it stays on the network so it always references the current
//     chunk hashes (a stale shell pointing at evicted chunks would white-screen the app).
//   • Cross-origin requests (Supabase API / auth / storage) and everything dynamic are not
//     touched at all — they must always hit the network.
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try { url = new URL(req.url) } catch (e) { return }
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/assets/')) return

  event.respondWith((async () => {
    // Cache is a pure optimisation: if Cache Storage is unavailable (restricted/partitioned
    // storage, quota exhausted on a low-end phone — the target device), opening or reading it
    // can reject. That must fall back to a plain network fetch, NOT reject the response — a
    // rejected respondWith serves a network error for the chunk and white-screens the app,
    // where the old no-fetch-handler SW would have loaded it natively.
    let cache = null
    try {
      cache = await caches.open(CACHE_NAME)
      const hit = await cache.match(req)
      if (hit) return hit
    } catch (e) {
      return fetch(req)
    }
    const res = await fetch(req)
    // Only cache a genuine success (status 200, not an opaque/redirect/error response).
    if (res && res.status === 200 && res.type === 'basic') {
      // Not awaited — a put() failure (e.g. quota) must not fail the returned response.
      cache.put(req, res.clone()).catch(() => { /* cache write best-effort */ })
    }
    return res
  })())
})

// ── Push received ─────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch (e) {
    payload = { title: 'Kaizen', body: event.data.text(), url: '/' }
  }

  const { title = 'Kaizen', body = '', url = '/', caseId, unreadCount } = payload
  const notifUrl = caseId ? `/cases/${caseId}` : url

  console.log('[sw] push received, unreadCount =', unreadCount)

  event.waitUntil(
    Promise.all([
      // Show the notification
      self.registration.showNotification(title, {
        body,
        icon: '/kaizen-icon.svg',
        tag:  caseId ? `case-${caseId}` : 'kaizen',
        data: { url: notifUrl },
      }),
      // Set the app icon badge count (works while app is closed only if iOS
      // exposes the Badging API in the worker scope)
      setBadge(unreadCount != null ? unreadCount : 1),
      // Also ask any open window to set the badge from the page context as a
      // fallback (page scope supports the Badging API more widely on iOS)
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
        cs.forEach((c) => c.postMessage({ type: 'SET_BADGE', count: unreadCount != null ? unreadCount : 1 }))
      }),
    ])
  )
})

// ── Push subscription rotation ────────────────────────────────────────────────
// Browsers/push services periodically rotate the endpoint (or the browser
// invalidates it). Without handling this, the old endpoint 410s, gets pruned by
// kaizen-push, and the user silently stops receiving pushes until they manually
// re-enable in Settings. Here we re-subscribe immediately to keep the browser
// subscription alive, then ask any open app tab to persist the fresh endpoint —
// the worker itself can't write to kaizen_push_subscriptions (RLS needs the
// user's auth session, which lives in the page, not the worker). If no tab is
// open, the app's global auto-subscribe (usePushNotifications) reconciles the DB
// on next open.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      // Reuse the key from the old subscription when the browser provides it
      // (most reliable — no VAPID key is embedded in this static worker file).
      const appServerKey = event.oldSubscription && event.oldSubscription.options
        ? event.oldSubscription.options.applicationServerKey
        : undefined
      if (appServerKey) {
        await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey })
      }
    } catch (e) {
      // Re-subscribe may fail (no old key, transient error) — the page will
      // create a fresh subscription on next open regardless.
      console.error('[sw] pushsubscriptionchange re-subscribe failed', e)
    }
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    cs.forEach((c) => c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' }))
  })())
})

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  if (event.action === 'dismiss') return

  const targetUrl = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If app is already open, focus it and navigate
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus()
          client.postMessage({ type: 'NAVIGATE', url: targetUrl })
          return
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl)
      }
    })
  )
})
