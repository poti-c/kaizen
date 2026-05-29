import { Outlet, Navigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { BottomNav } from './BottomNav'
import { useAuth } from '@/contexts/AuthContext'
import { useViewMode } from '@/contexts/ViewModeContext'

export function Layout() {
  const { user, profile, loading } = useAuth()
  const { showSidebar, showBottomNav } = useViewMode()

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user || !profile) {
    return <Navigate to="/login" replace />
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Sidebar — conditionally shown based on view mode */}
      {showSidebar && (
        <div className="flex">
          <Sidebar />
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className={`flex-1 overflow-y-auto ${showBottomNav ? 'pb-16' : ''}`}>
          <Outlet />
        </main>
      </div>

      {/* Bottom nav — only shown in auto/mobile mode */}
      {showBottomNav && <BottomNav />}
    </div>
  )
}
