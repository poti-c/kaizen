import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { LanguageProvider } from '@/contexts/LanguageContext'
import { ViewModeProvider } from '@/contexts/ViewModeContext'
import { Layout } from '@/components/Layout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { CasesPage } from '@/pages/CasesPage'
import { CaseDetailPage } from '@/pages/CaseDetailPage'
import { CreateCasePage } from '@/pages/CreateCasePage'
import { UsersPage } from '@/pages/UsersPage'
import { NotificationsPage } from '@/pages/NotificationsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { CasesCalendarPage } from '@/pages/CasesCalendarPage'

// Redirects to /cases for staff, /dashboard for managers and admins
function RoleRedirect() {
  const { profile } = useAuth()
  if (!profile) return null
  return <Navigate to={profile.role === 'staff' ? '/cases' : '/dashboard'} replace />
}

// Blocks access to a route if the user's role is not in the allowed list
function ProtectedRoute({ roles, children }: { roles: string[]; children: React.ReactNode }) {
  const { profile } = useAuth()
  if (!profile) return null
  if (!roles.includes(profile.role)) return <Navigate to="/cases" replace />
  return <>{children}</>
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 1000 * 60 },
  },
})

export default function App() {
  return (
    <LanguageProvider>
      <ViewModeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ThemeProvider>
              <BrowserRouter>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/" element={<Layout />}>
                    <Route index element={<RoleRedirect />} />
                    <Route path="dashboard" element={<ProtectedRoute roles={['super_admin', 'manager']}><DashboardPage /></ProtectedRoute>} />
                    <Route path="cases" element={<CasesPage />} />
                    <Route path="cases/calendar" element={<CasesCalendarPage />} />
                    <Route path="cases/new" element={<CreateCasePage />} />
                    <Route path="cases/:id" element={<CaseDetailPage />} />
                    <Route path="users" element={<UsersPage />} />
                    <Route path="notifications" element={<NotificationsPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </BrowserRouter>
              <Toaster position="top-right" richColors />
            </ThemeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ViewModeProvider>
    </LanguageProvider>
  )
}
