import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export type PushStatus = 'unsupported' | 'default' | 'granted' | 'denied' | 'loading'

export function usePushNotifications(userId: string | undefined) {
  const [status, setStatus] = useState<PushStatus>('loading')

  const supported = typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    !!VAPID_PUBLIC_KEY

  useEffect(() => {
    if (!supported) { setStatus('unsupported'); return }
    const perm = Notification.permission
    if (perm === 'granted') setStatus('granted')
    else if (perm === 'denied') setStatus('denied')
    else setStatus('default')
  }, [supported])

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

  return { status, supported, subscribe, unsubscribe }
}
