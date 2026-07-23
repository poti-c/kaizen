import { useState } from 'react'
import { Bell, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { toast } from 'sonner'

/**
 * Passive, dismissible nudge to enable device push — the one path that still needs
 * a user gesture (browsers only show the permission dialog on a click, and only to
 * people who were never asked). Deliberately NOT a modal: it's a slim banner a user
 * can ignore forever with no consequence (in-app notifications keep working).
 *
 * Shown only when the OS permission is 'default' (never asked) on a device that can
 * receive push, or 'needs-install' on iOS (points them to the Settings install
 * guide). Never shown once granted/denied. Dismissal is per-session (sessionStorage)
 * so it may reappear next sign-in — present, never nagging — matching TrialBanner.
 */
export function PushPrompt() {
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const navigate = useNavigate()
  const { status, subscribe } = usePushNotifications(profile?.id)

  const dismissKey = `push-prompt-dismissed:${profile?.id ?? ''}`
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(dismissKey) === '1' } catch { return false }
  })
  const [working, setWorking] = useState(false)

  if (!profile || dismissed) return null
  if (status !== 'default' && status !== 'needs-install') return null

  function dismiss() {
    try { sessionStorage.setItem(dismissKey, '1') } catch { /* ignore */ }
    setDismissed(true)
  }

  const needsInstall = status === 'needs-install'

  async function onEnable() {
    if (needsInstall) { navigate('/settings'); return }
    setWorking(true)
    try {
      const ok = await subscribe()
      if (ok) toast.success(lang === 'th' ? 'เปิดการแจ้งเตือนบนอุปกรณ์แล้ว!' : 'Device notifications on!')
      else toast.error(lang === 'th' ? 'ไม่สามารถเปิดได้ — ลองอีกครั้งในการตั้งค่า' : "Couldn't enable — try again from Settings.")
    } finally { setWorking(false) }
  }

  const msg = needsInstall
    ? (lang === 'th'
        ? 'ติดตั้ง Kaizen ไปยังหน้าจอหลักเพื่อรับการแจ้งเตือนบนอุปกรณ์นี้'
        : 'Install Kaizen to your Home Screen to get notifications on this device.')
    : (lang === 'th'
        ? 'เปิดการแจ้งเตือนบนอุปกรณ์ เพื่อไม่พลาดเคสที่มอบหมายให้คุณ'
        : "Turn on device notifications so you don't miss cases assigned to you.")
  const cta = needsInstall
    ? (lang === 'th' ? 'ดูวิธีติดตั้ง' : 'How to install')
    : (lang === 'th' ? 'เปิด' : 'Turn on')

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium border-b bg-sky-50 border-sky-200 text-sky-900">
      <Bell className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1">{msg}</span>
      <button
        onClick={onEnable}
        disabled={working}
        className="underline font-semibold whitespace-nowrap disabled:opacity-50"
      >
        {working ? (lang === 'th' ? 'กำลังเปิด...' : 'Enabling…') : cta}
      </button>
      <button onClick={dismiss} aria-label={lang === 'th' ? 'ปิด' : 'Dismiss'} className="p-0.5 rounded hover:bg-sky-100 flex-shrink-0">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
