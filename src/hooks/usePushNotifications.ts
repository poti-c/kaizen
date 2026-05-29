import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export type PushStatus = 'unsupported' | 'needs-install' | 'default' | 'granted' | 'denied' | 'loading'

// true when running as installed PWA (standalone mode)
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true
  )
}

// true on iOS Safari (needs home screen install for push)
function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function usePushNotifications(userId: string | undefined) {
  const [status, setStatus] = useState<PushStatus>('loading')

  const hasPushAPI = typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    !!VAPID_PUBLIC_KEY

  // iOS requires app to be installed (standalone) before PushManager works
  const supported = hasPushAPI && (!isIOS() || isStandalone())

  useEffect(() => {
    if (!hasPushAPI) { setStatus('unsupported'); return }
    // iOS in browser (not installed) → show install prompt
    if (isIOS() && !isStandalone()) { setStatus('needs-install'); return }
    if (!supported) { setStatus('unsupported'); return }
    const perm = Notification.permission
    if (perm === 'granted') setStatus('granted')
    else if (perm === 'denied') setStatus('denied')
    else setStatus('default')
  }, [supported, hasPushAPI])

  async function subscribe(): Promise<boolean> {
    if (!supported || !userId) return false
    setStatus('loading')
    try {
      const reg = await navigator.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      const sub = existing ?? await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
      const json = sub.toJSON()
      const { error } = await supabase.from('kaizen_push_subscriptions').upsert({
        user_id: userId,
        endpoint: sub.endpoint,
        p256dh:   json.keys?.p256dh ?? '',
        auth:     json.keys?.auth   ?? '',
        user_agent: navigator.userAgent.slice(0, 200),
      }, { onConflict: 'user_id,endpoint' })
      setStatus(error ? 'default' : 'granted')
      return !error
    } catch {
      setStatus(Notification.permission === 'denied' ? 'denied' : 'default')
      return false
    }
  }

  async function unsubscribe(): Promise<void> {
    if (!supported) return
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await supabase.from('kaizen_push_subscriptions')
          .delete().eq('endpoint', sub.endpoint)
        await sub.unsubscribe()
      }
      setStatus('default')
    } catch {
      setStatus('default')
    }
  }

  return { status, supported, isIOS: isIOS(), isStandalone: isStandalone(), subscribe, unsubscribe }
}
