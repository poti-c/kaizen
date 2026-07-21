import { useEffect, Suspense } from 'react'
import { Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { BottomNav } from './BottomNav'
import { TrialBanner, PmsTrialBanner } from './TrialBanner'
import { FeedbackProvider } from './FeedbackWidget'
import { useAuth } from '@/contexts/AuthContext'
import { useViewMode } from '@/contexts/ViewModeContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'

export function Layout() {
  const { user, profile, loading, profileError, signOut, refreshProfile } = useAuth()
  const { showSidebar, showBottomNav } = useViewMode()
  const { lang } = useLanguage()
  const location = useLocation()
  const navigate = useNavigate()

  // Handle messages the service worker posts on notification click: deep-link via the
  // router (no full reload) and apply the app-icon badge fallback.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string; count?: number } | null
      if (d?.type === 'NAVIGATE' && typeof d.url === 'string') navigate(d.url)
      else if (d?.type === 'SET_BADGE' && 'setAppBadge' in navigator) {
        const n = Number(d.count) || 0
        if (n > 0) (navigator as unknown as { setAppBadge: (n: number) => Promise<void> }).setAppBadge(n).catch(() => {})
        else (navigator as unknown as { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {})
      }
    }
    navigator.serviceWorker.addEventListener('message', onMsg)
    return () => navigator.serviceWorker.removeEventListener('message', onMsg)
  }, [navigate])

  if (loading) {
    return (
      <div className="flex items-center justify-center bg-gray-50" style={{ height: '100dvh' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">{lang === 'th' ? 'กำลังโหลด...' : 'Loading...'}</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  // The profile fetch failed even after AuthContext's built-in retry (flaky network,
  // brief Supabase hiccup) — show a retry screen instead of redirecting to /login,
  // which would just bounce straight back here since `user` is still set, looping
  // forever and leaving the page blank.
  if (!profile) {
    if (profileError) {
      return (
        <div className="flex items-center justify-center bg-gray-50" style={{ height: '100dvh' }}>
          <div className="flex flex-col items-center gap-4 text-center px-6 max-w-xs">
            <p className="text-sm text-gray-600">
              {lang === 'th'
                ? 'โหลดโปรไฟล์ไม่สำเร็จ — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง'
                : "Couldn't load your profile. Check your connection and try again."}
            </p>
            <div className="flex gap-2">
              <Button onClick={() => refreshProfile()}>{lang === 'th' ? 'ลองอีกครั้ง' : 'Retry'}</Button>
              <Button variant="outline" onClick={() => signOut()}>{lang === 'th' ? 'ออกจากระบบ' : 'Sign out'}</Button>
            </div>
          </div>
        </div>
      )
    }
    return null
  }

  // Force a password change before allowing access to any app route
  if (profile.must_change_password && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }

  // Mobile: natural document flow (min-height) so content can never be clipped
  // by a viewport the device reports slightly wrong (Android display-size /
  // gesture-bar). Desktop (md+): fixed app-shell with an internally scrolling
  // <main> so the sidebar stays put.
  return (
    <FeedbackProvider>
      <div className="flex min-h-[100dvh] bg-gray-50 md:h-[100dvh] md:overflow-hidden">
        {/* Sidebar — conditionally shown based on view mode. Hosts the feedback trigger in its footer. */}
        {showSidebar && (
          <div className="flex flex-shrink-0">
            <Sidebar />
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0 md:overflow-hidden">
          <Header />
          <TrialBanner />
          <PmsTrialBanner />
          <main
            className="flex-1 overflow-x-hidden md:overflow-y-auto"
            style={{ background: 'var(--brand-background, #f9fafb)', paddingBottom: showBottomNav ? 'calc(4rem + env(safe-area-inset-bottom, 0px))' : undefined }}
          >
            {/* Route components are lazy-loaded (see App.tsx) so a phone only downloads the
                page it's on, not the whole app — smaller bundle, lower memory, faster reload
                after an Android tab-kill. This boundary keeps the header/nav on screen while
                the next route's chunk loads. */}
            <Suspense fallback={
              <div className="flex items-center justify-center py-20">
                <div className="w-8 h-8 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
              </div>
            }>
              <Outlet />
            </Suspense>
          </main>
        </div>

        {/* Bottom nav — only shown in auto/mobile mode */}
        {showBottomNav && <BottomNav />}
      </div>
    </FeedbackProvider>
  )
}
