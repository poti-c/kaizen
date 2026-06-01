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

  const { title = 'Kaizen', body = '', url = '/', caseId } = payload
  const notifUrl = caseId ? `/cases/${caseId}` : url

  // Keep options minimal for maximum iOS compatibility
  // iOS does not support: actions, vibrate, badge (SVG), renotify
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/kaizen-icon.svg',
      tag:  caseId ? `case-${caseId}` : 'kaizen',
      data: { url: notifUrl },
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
