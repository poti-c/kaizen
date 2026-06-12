import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, FolderOpen, PlusCircle, Bell, Users,
  Settings, LogOut, ChevronLeft, ChevronRight, CalendarDays, TrendingUp, Wrench,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials, companyHasFeature, companyHasAddon, type FeatureKey, type AddonKey } from '@/lib/utils'
import { DEPARTMENT_LABELS } from '@/types'
import { useState } from 'react'
import { cn } from '@/lib/utils'

export function Sidebar() {
  const { profile, signOut } = useAuth()
  const { activeCompany } = useCompany()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)

  const NAV_ITEMS: { to: string; icon: typeof LayoutDashboard; label: string; roles: string[]; feature?: FeatureKey; addon?: AddonKey }[] = [
    { to: '/dashboard', icon: LayoutDashboard, label: t.nav.dashboard, roles: ['super_admin', 'manager'] },
    { to: '/performance', icon: TrendingUp, label: t.nav.performance, roles: ['super_admin', 'manager'], feature: 'performance_analytics' },
    { to: '/cases', icon: FolderOpen, label: t.nav.cases, roles: ['super_admin', 'manager', 'staff'] },
    { to: '/cases/calendar', icon: CalendarDays, label: t.nav.calendar, roles: ['super_admin', 'manager', 'staff'] },
    { to: '/maintenance', icon: Wrench, label: t.nav.maintenance, roles: ['super_admin', 'manager', 'staff'], addon: 'pms' },
    { to: '/cases/new', icon: PlusCircle, label: t.nav.newCase, roles: ['staff', 'manager', 'super_admin'] },
    { to: '/notifications', icon: Bell, label: t.nav.notifications, roles: ['super_admin', 'manager', 'staff'] },
    { to: '/users', icon: Users, label: t.nav.users, roles: ['super_admin', 'manager'] },
    { to: '/settings', icon: Settings, label: t.nav.settings, roles: ['super_admin', 'manager', 'staff'] },
  ]

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (!profile || !item.roles.includes(profile.role)) return false
    if (item.feature && !companyHasFeature(activeCompany, item.feature)) return false
    if (item.addon && !companyHasAddon(activeCompany, item.addon)) return false
    return true
  })

  return (
    <aside
      className={cn(
        'h-screen flex flex-col transition-all duration-300 relative',
        collapsed ? 'w-16' : 'w-64'
      )}
      style={{ background: 'var(--brand-sidebar)' }}
    >
      {/* Logo / Brand */}
      <div className={cn('flex items-center gap-3 border-b border-white/10', collapsed ? 'justify-center px-0 py-5' : 'px-4 py-4')}>
        <img src="/kaizen-icon.svg" alt="Kaizen" className="w-10 h-10 object-contain flex-shrink-0" />
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-[#c8a882] font-bold text-base leading-snug truncate">{activeCompany?.org_title || activeCompany?.name || 'Kaizen System'}</p>
            <p className="text-white/90 font-semibold text-sm leading-snug tracking-wide truncate">Kaizen System</p>
          </div>
        )}
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-16 bg-white border border-gray-200 rounded-full p-0.5 shadow-sm z-10 hover:bg-gray-50 transition-colors"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-gray-600" /> : <ChevronLeft className="h-3.5 w-3.5 text-gray-600" />}
      </button>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
        {visibleItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/cases'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all',
                collapsed ? 'justify-center' : '',
                isActive
                  ? 'bg-white/20 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              )
            }
            title={collapsed ? label : undefined}
          >
            <Icon className="h-5 w-5 flex-shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* User section */}
      <div className={cn('border-t border-white/10 p-3', collapsed && 'px-0 flex flex-col items-center')}>
        {profile && (
          <div className={cn('flex items-center gap-3 mb-2', collapsed && 'justify-center')}>
            <Avatar className="h-8 w-8 flex-shrink-0">
              {profile.avatar_url && <AvatarImage src={profile.avatar_url} alt={profile.full_name} className="object-cover" />}
              <AvatarFallback className="text-xs">{getInitials(profile.full_name)}</AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <p className="text-white text-xs font-medium truncate">{profile.full_name}</p>
                <p className="text-white/50 text-xs truncate">{DEPARTMENT_LABELS[profile.department]}</p>
              </div>
            )}
          </div>
        )}
        <button
          onClick={handleSignOut}
          className={cn(
            'flex items-center gap-2 text-white/60 hover:text-white text-xs transition-colors w-full rounded-lg px-3 py-2 hover:bg-white/10',
            collapsed && 'justify-center px-0'
          )}
          title={collapsed ? t.nav.signOut : undefined}
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          {!collapsed && t.nav.signOut}
        </button>
        {!collapsed && (
          <p className="text-white/20 text-[10px] text-center mt-2 tracking-wide">Kaizen System V.1 by NNR-Solutions</p>
        )}
      </div>
    </aside>
  )
}
