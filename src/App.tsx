import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import React, { Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { PresenceProvider } from '@/contexts/PresenceContext'
import { CompanyProvider, useCompany } from '@/contexts/CompanyContext'
import { companyHasFeature, companyHasAddon, type FeatureKey, type AddonKey } from '@/lib/utils'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { LanguageProvider } from '@/contexts/LanguageContext'
import { ViewModeProvider } from '@/contexts/ViewModeContext'
import { Layout } from '@/components/Layout'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { installGlobalErrorReporter, setErrorContext } from '@/lib/errorReporter'

// Eager: the entry/critical-path screens. LoginPage is the first paint for a signed-out
// user, ChangePasswordPage is on the forced first-login path — lazy-loading these would
// only add a spinner flash to the very first thing the user sees.
import { LoginPage } from '@/pages/LoginPage'
import { ChangePasswordPage } from '@/pages/ChangePasswordPage'

// Everything else is split into its own chunk (lever B): a phone on /cases/new downloads
// only that route's code, not the Console/PM/Roster/Performance pages it never opens. This
// shrinks the 2.1 MB monolith, lowers baseline memory (a smaller Android kill target), and
// speeds every cold reload — including the OS-forced one after a tab-kill during capture.
//
// lazyPage retries the dynamic import a few times before giving up: on the weak hotel Wi-Fi
// this app runs on, a chunk fetch can fail transiently, and without a retry that surfaces as
// a blank ErrorBoundary screen instead of the page. Named-export friendly.
function lazyPage<T extends React.ComponentType<Record<string, never>>>(
  load: () => Promise<Record<string, unknown>>,
  name: string,
): React.LazyExoticComponent<T> {
  return React.lazy(async () => {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const mod = await load()
        return { default: mod[name] as T }
      } catch (e) {
        lastErr = e
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      }
    }
    throw lastErr
  })
}

const ConsolePage = lazyPage(() => import('@/pages/ConsolePage'), 'ConsolePage')
const DashboardPage = lazyPage(() => import('@/pages/DashboardPage'), 'DashboardPage')
const CasesPage = lazyPage(() => import('@/pages/CasesPage'), 'CasesPage')
const CaseDetailPage = lazyPage(() => import('@/pages/CaseDetailPage'), 'CaseDetailPage')
const CreateCasePage = lazyPage(() => import('@/pages/CreateCasePage'), 'CreateCasePage')
const UsersPage = lazyPage(() => import('@/pages/UsersPage'), 'UsersPage')
const NotificationsPage = lazyPage(() => import('@/pages/NotificationsPage'), 'NotificationsPage')
const SettingsPage = lazyPage(() => import('@/pages/SettingsPage'), 'SettingsPage')
const CasesCalendarPage = lazyPage(() => import('@/pages/CasesCalendarPage'), 'CasesCalendarPage')
const PreventiveMaintenancePage = lazyPage(() => import('@/pages/PreventiveMaintenancePage'), 'PreventiveMaintenancePage')
const RoutineRosterPage = lazyPage(() => import('@/pages/RoutineRosterPage'), 'RoutineRosterPage')
const PackagesExpansions = lazyPage(() => import('@/components/PackagesExpansions'), 'PackagesExpansions')
const PerformancePage = lazyPage(() => import('@/pages/PerformancePage'), 'PerformancePage')
const PerformanceDetailPage = lazyPage(() => import('@/pages/PerformanceDetailPage'), 'PerformanceDetailPage')

// Keeps the error reporter aware of the active company and installs global handlers.
function ErrorReporterBridge() {
  const { activeCompany } = useCompany()
  React.useEffect(() => { installGlobalErrorReporter() }, [])
  React.useEffect(() => { setErrorContext(activeCompany?.id ?? null) }, [activeCompany])
  return null
}

// Console has no CompanyProvider — just install the global window/promise handlers.
function ConsoleErrorReporter() {
  React.useEffect(() => { installGlobalErrorReporter() }, [])
  return null
}

// Staff have no Dashboard nav link, so their home is the cases list; managers/admins get the dashboard.
function homeFor(role: string) { return role === 'staff' ? '/cases' : '/dashboard' }

// Each role lands on its home; users with must_change_password go to /change-password first.
function RoleRedirect() {
  const { profile } = useAuth()
  if (!profile) return null
  if (profile.must_change_password) return <Navigate to="/change-password" replace />
  return <Navigate to={homeFor(profile.role)} replace />
}

// Blocks access to a route if the user's role is not in the allowed list, or
// if the company's package doesn't include the required feature.
function ProtectedRoute({ roles, feature, addon, children }: { roles: string[]; feature?: FeatureKey; addon?: AddonKey; children: React.ReactNode }) {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  if (!profile) return null
  if (!roles.includes(profile.role)) return <Navigate to={homeFor(profile.role)} replace />
  if (feature && !companyHasFeature(activeCompany, feature)) return <Navigate to={homeFor(profile.role)} replace />
  if (addon && !companyHasAddon(activeCompany, addon)) return <Navigate to={homeFor(profile.role)} replace />
  return <>{children}</>
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 1000 * 60 },
  },
})

export default function App() {
  // ── System Console: fully isolated from app auth (own route tree) ──
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')) {
    return (
      <LanguageProvider>
        <ErrorBoundary>
          <ConsoleErrorReporter />
          <div className="h-[100dvh] overflow-y-auto bg-slate-950">
            <Suspense fallback={
              <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-slate-600 border-t-transparent rounded-full animate-spin" />
              </div>
            }>
              <ConsolePage />
            </Suspense>
            <Toaster position="top-right" richColors />
          </div>
        </ErrorBoundary>
      </LanguageProvider>
    )
  }

  return (
    <LanguageProvider>
      <ViewModeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <PresenceProvider>
            <CompanyProvider>
            <ThemeProvider>
              <ErrorReporterBridge />
              <ErrorBoundary>
              <BrowserRouter>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/change-password" element={<ChangePasswordPage />} />
                  <Route path="/" element={<Layout />}>
                    <Route index element={<RoleRedirect />} />
                    <Route path="dashboard" element={<DashboardPage />} />
                    <Route path="performance" element={<ProtectedRoute roles={['super_admin', 'manager']} feature="performance_analytics"><PerformancePage /></ProtectedRoute>} />
                    <Route path="performance/:userId" element={<ProtectedRoute roles={['super_admin', 'manager']} feature="performance_analytics"><PerformanceDetailPage /></ProtectedRoute>} />
                    <Route path="cases" element={<CasesPage />} />
                    <Route path="cases/calendar" element={<CasesCalendarPage />} />
                    <Route path="maintenance" element={<ProtectedRoute roles={['super_admin', 'manager', 'staff']} addon="pms"><PreventiveMaintenancePage /></ProtectedRoute>} />
                    <Route path="routine-roster" element={<ProtectedRoute roles={['super_admin', 'manager', 'staff']} addon="routine_roster"><RoutineRosterPage /></ProtectedRoute>} />
                    <Route path="cases/new" element={<CreateCasePage />} />
                    <Route path="cases/:id" element={<CaseDetailPage />} />
                    <Route path="users" element={<UsersPage />} />
                    <Route path="notifications" element={<NotificationsPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                    <Route path="packages" element={<ProtectedRoute roles={['super_admin', 'manager']}><PackagesExpansions /></ProtectedRoute>} />
                  </Route>
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </BrowserRouter>
              </ErrorBoundary>
              <Toaster position="top-right" richColors />
            </ThemeProvider>
            </CompanyProvider>
            </PresenceProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ViewModeProvider>
    </LanguageProvider>
  )
}
