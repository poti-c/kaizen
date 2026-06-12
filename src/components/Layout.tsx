import { Outlet, Navigate, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { BottomNav } from './BottomNav'
import { TrialBanner, PmsTrialBanner } from './TrialBanner'
import { useAuth } from '@/contexts/AuthContext'
import { useViewMode } from '@/contexts/ViewModeContext'
import { useLanguage } from '@/contexts/LanguageContext'

export function Layout() {
  const { user, profile, loading } = useAuth()
  const { showSidebar, showBottomNav } = useViewMode()
  const { lang } = useLanguage()
  const location = useLocation()

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

  if (!user || !profile) {
    return <Navigate to="/login" replace />
  }

  // Force a password change before allowing access to any app route
  if (profile.must_change_password && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }

  return (
    <div className="flex overflow-hidden bg-gray-50" style={{ height: '100dvh' }}>
      {/* Sidebar — conditionally shown based on view mode */}
      {showSidebar && (
        <div className="flex flex-shrink-0">
          <Sidebar />
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header />
        <TrialBanner />
        <PmsTrialBanner />
        <main
          className="flex-1 overflow-y-auto overflow-x-hidden"
          style={{ background: 'var(--brand-background, #f9fafb)', paddingBottom: showBottomNav ? 'calc(4rem + env(safe-area-inset-bottom, 0px))' : undefined }}
        >
          <Outlet />
        </main>
      </div>

      {/* Bottom nav — only shown in auto/mobile mode */}
      {showBottomNav && <BottomNav />}
    </div>
  )
}
