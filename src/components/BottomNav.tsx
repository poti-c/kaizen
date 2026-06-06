import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { LayoutDashboard, FolderOpen, PlusCircle, Bell, Users, TrendingUp, CalendarDays, Wrench } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { supabase } from '@/lib/supabase'
import { cn, companyHasAddon } from '@/lib/utils'

export function BottomNav() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t } = useLanguage()
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!profile) return
    fetchUnread()

    const channel = supabase
      .channel('bottom_nav_notifs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kaizen_notifications', filter: `user_id=eq.${profile.id}` }, fetchUnread)
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile])

  async function fetchUnread() {
    if (!profile) return
    const { count } = await supabase
      .from('kaizen_notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', profile.id)
      .eq('is_read', false)
    setUnread(count ?? 0)
  }

  const isStaff = profile?.role === 'staff'
  const pms = companyHasAddon(activeCompany, 'pms')

  type NavItem = { to: string; icon: typeof FolderOpen; label: string; accent: boolean; badge?: number }

  const items: NavItem[] = (isStaff
    ? [
        { to: '/dashboard',      icon: LayoutDashboard, label: t.nav.home,     accent: false },
        { to: '/cases',          icon: FolderOpen,      label: t.nav.cases,    accent: false },
        { to: '/cases/new',      icon: PlusCircle,      label: t.nav.newCase,  accent: true  },
        pms ? { to: '/maintenance', icon: Wrench,       label: t.nav.maintenance, accent: false } : null,
        { to: '/cases/calendar', icon: CalendarDays,    label: t.nav.calendar, accent: false },
        { to: '/notifications',  icon: Bell,            label: t.nav.alerts,   accent: false, badge: unread },
      ]
    : [
        { to: '/dashboard',    icon: LayoutDashboard, label: t.nav.home,        accent: false },
        { to: '/cases',        icon: FolderOpen,      label: t.nav.cases,       accent: false },
        { to: '/cases/new',    icon: PlusCircle,      label: t.nav.newCase,     accent: true  },
        pms ? { to: '/maintenance', icon: Wrench,     label: t.nav.maintenance, accent: false } : null,
        { to: '/performance',  icon: TrendingUp,      label: t.nav.performance, accent: false },
        { to: '/users',        icon: Users,           label: t.nav.users,       accent: false },
      ]
  ).filter(Boolean) as NavItem[]

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)', paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' }}
    >
      <div className="flex items-center justify-around h-16">
        {items.map(({ to, icon: Icon, label, accent, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/cases'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-0.5 flex-1 py-2 transition-colors',
                accent
                  ? 'text-white'
                  : isActive
                  ? 'text-[var(--brand-primary)]'
                  : 'text-gray-400'
              )
            }
          >
            {({ isActive }) => (
              <>
                <div
                  className={cn(
                    'relative flex items-center justify-center w-10 h-8 rounded-xl transition-all',
                    accent
                      ? 'bg-[var(--brand-primary)] w-12 h-9 shadow-md'
                      : isActive
                      ? 'bg-[var(--brand-primary)]/10'
                      : ''
                  )}
                >
                  <Icon className={cn('h-5 w-5', accent ? 'text-white' : '')} />
                  {(badge ?? 0) > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-0.5">
                      {(badge ?? 0) > 9 ? '9+' : badge}
                    </span>
                  )}
                </div>
                <span className={cn('text-[10px] font-medium', accent ? 'text-[var(--brand-primary)]' : '')}>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
