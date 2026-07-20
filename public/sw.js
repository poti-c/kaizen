// Na Nirand Kaizen — Service Worker
// Handles push notifications. (No fetch handler: nothing is cached here.)

// Sole purpose: give this file different bytes on every release. A browser only
// installs a new worker when the fetched sw.js differs from the installed one,
// and that install is what drives the auto-update in index.html
// (skipWaiting → clients.claim → controllerchange → reload). If sw.js is
// byte-identical, installed PWAs stay on the old build indefinitely.
//
// The deploy workflow rewrites this line with the commit SHA — do NOT rely on
// editing it by hand. It sat at 'kaizen-v3' for 184 commits and silently
// disabled the update path for every release in between.
const BUILD_ID = 'kaizen-dev'

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
  event.waitUntil(clients.claim())
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
