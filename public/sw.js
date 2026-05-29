// Na Nirand Kaizen — Service Worker
// Handles push notifications and offline caching

const CACHE_NAME = 'kaizen-v1'

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
  } catch {
    payload = { title: 'Kaizen', body: event.data.text(), url: '/' }
  }

  const { title = 'Kaizen Notification', body = '', url = '/', caseId } = payload
  const notifUrl = caseId ? `/cases/${caseId}` : url

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/kaizen-icon.svg',
      badge: '/kaizen-icon.svg',
      tag: caseId || 'kaizen',          // collapses duplicate alerts for same case
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: notifUrl },
      actions: [
        { action: 'open',    title: 'View Case' },
        { action: 'dismiss', title: 'Dismiss'   },
      ],
    })
  )
})

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  if (event.action === 'dismiss') return

  const targetUrl = event.notification.data?.url || '/'

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
