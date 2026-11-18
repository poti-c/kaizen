// Single source of truth for navigation items — import this in both Header and Sidebar
// so adding/removing a route is a one-line change that propagates everywhere.
import { useLanguage } from '@/contexts/LanguageContext'
import { useAuth } from '@/contexts/AuthContext'
import {
  Bell, CalendarDays, ClipboardList, FileUp, FolderOpen, LayoutDashboard,
  PlusCircle, Settings, TrendingUp, Users, Wrench,
} from 'lucide-react'
import type { FeatureKey, AddonKey } from '@/lib/utils'

export interface NavItem {
  to: string
  icon: typeof LayoutDashboard
  label: string
  roles: string[]
  feature?: FeatureKey
  addon?: AddonKey
  // Extra per-user condition on top of `roles`; false hides the item.
  visible?: boolean
}

export function useNavItems(): NavItem[] {
  const { t } = useLanguage()
  const { profile } = useAuth()
  return [
    { to: '/dashboard',      icon: LayoutDashboard, label: t.nav.dashboard,     roles: ['super_admin', 'manager'] },
    { to: '/performance',    icon: TrendingUp,      label: t.nav.performance,   roles: ['super_admin', 'manager'],          feature: 'performance_analytics' },
    { to: '/cases',          icon: FolderOpen,      label: t.nav.cases,         roles: ['super_admin', 'manager', 'staff'] },
    { to: '/cases/calendar', icon: CalendarDays,    label: t.nav.calendar,      roles: ['super_admin', 'manager', 'staff'] },
    { to: '/maintenance',    icon: Wrench,          label: t.nav.maintenance,   roles: ['super_admin', 'manager', 'staff'], addon: 'pms' },
    { to: '/routine-roster', icon: ClipboardList,   label: t.nav.routineRoster, roles: ['super_admin', 'manager', 'staff'], addon: 'routine_roster' },
    { to: '/cases/new',      icon: PlusCircle,      label: t.nav.newCase,       roles: ['staff', 'manager', 'super_admin'] },
    // Front Office staff only — managers and super admins have this card on the Dashboard.
    { to: '/hotel-report',   icon: FileUp,          label: t.nav.uploadHotelReport, roles: ['staff'], visible: profile?.department === 'front_office' },
    { to: '/notifications',  icon: Bell,            label: t.nav.notifications, roles: ['super_admin', 'manager', 'staff'] },
    { to: '/users',          icon: Users,           label: t.nav.users,         roles: ['super_admin', 'manager'] },
    { to: '/settings',       icon: Settings,        label: t.nav.settings,      roles: ['super_admin', 'manager', 'staff'] },
  ]
}
