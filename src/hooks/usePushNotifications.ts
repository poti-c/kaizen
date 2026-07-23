import { useState, useEffect, useRef } from 'react'
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

export function usePushNotifications(
  userId: string | undefined,
  opts?: { autoSubscribe?: boolean },
) {
  const [status, setStatus] = useState<PushStatus>('loading')
  const autoSubscribe = opts?.autoSubscribe ?? false

  const hasPushAPI = typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    !!VAPID_PUBLIC_KEY

  // iOS requires app to be installed (standalone) before PushManager works
  const supported = hasPushAPI && (!isIOS() || isStandalone())

  useEffect(() => {
    let mounted = true
    // iOS only exposes the Push API inside an installed (Home Screen) PWA — a plain
    // Safari tab has no PushManager, so hasPushAPI is false there. Check the iOS
    // needs-install case FIRST: otherwise every iPhone-in-Safari user falls into
    // 'unsupported' (a dead-end "browser not supported" message) and never sees the
    // "Add to Home Screen" guide that would actually let them enable notifications.
    if (isIOS() && !isStandalone()) { if (mounted) setStatus('needs-install'); return () => { mounted = false } }
    if (!hasPushAPI) { if (mounted) setStatus('unsupported'); return () => { mounted = false } }
    if (!supported) { if (mounted) setStatus('unsupported'); return () => { mounted = false } }
    const perm = Notification.permission
    if (mounted) {
      if (perm === 'granted') setStatus('granted')
      else if (perm === 'denied') setStatus('denied')
      else setStatus('default')
    }
    return () => { mounted = false }
  }, [supported, hasPushAPI])

  async function subscribe(): Promise<boolean> {
    if (!supported || !userId) return false
    setStatus('loading')
    try {
      const reg = await navigator.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      let sub: PushSubscription
      if (existing) {
        const expectedKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        const existingKey = existing.options?.applicationServerKey
        const keysMatch = existingKey && existingKey.byteLength === expectedKey.length &&
          new Uint8Array(existingKey as ArrayBuffer).every((b, i) => b === expectedKey[i])
        if (!keysMatch) {
          await existing.unsubscribe()
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedKey as BufferSource })
        } else {
          sub = existing
        }
      } else {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource })
      }
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

  // ── Silent auto-subscribe (opt-in via `autoSubscribe`) ──────────────────────
  // The root cause of "not everyone gets push": a subscription is only ever
  // created by the manual toggle in Settings, and lapsed/rotated subscriptions
  // are never repaired — so most staff who once granted permission silently stop
  // receiving pushes. When mounted globally with { autoSubscribe: true }, this
  // re-registers the current browser subscription on every app open for anyone
  // whose OS permission is already 'granted'. subscribe() is an idempotent upsert
  // (and re-creates the subscription if the browser invalidated it), so this both
  // covers the never-re-subscribed majority and heals endpoint rotation. It never
  // prompts: permission is only ever requested by the explicit Settings toggle.
  const autoSubDone = useRef<string | null>(null)
  useEffect(() => {
    if (!autoSubscribe) return
    if (!supported || !userId) return
    if (status !== 'granted') return
    if (autoSubDone.current === userId) return
    autoSubDone.current = userId
    void subscribe()
    // subscribe is a stable in-scope function; deps intentionally limited to the
    // gate values so this fires once per (user, mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubscribe, supported, userId, status])

  // The service worker re-subscribes on `pushsubscriptionchange` (endpoint
  // rotation) but cannot write to the DB — RLS on kaizen_push_subscriptions
  // requires auth.uid(), which the worker has no session for. It posts a message
  // so an open app tab persists the fresh endpoint under the user's session.
  useEffect(() => {
    if (!autoSubscribe || !supported || !userId) return
    if (!('serviceWorker' in navigator)) return
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'PUSH_SUBSCRIPTION_CHANGED') void subscribe()
    }
    navigator.serviceWorker.addEventListener('message', onMsg)
    return () => navigator.serviceWorker.removeEventListener('message', onMsg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubscribe, supported, userId])

  return { status, supported, isIOS: isIOS(), isStandalone: isStandalone(), subscribe, unsubscribe }
}
