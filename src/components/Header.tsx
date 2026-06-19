import { useState, useEffect } from 'react'
import { Bell, X, LayoutDashboard, FolderOpen, PlusCircle, Users, Settings, LogOut, CalendarDays, ChevronDown, Building2, Wrench, ClipboardList, TrendingUp } from 'lucide-react'
import { useNavigate, Link, NavLink } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { useViewMode } from '@/contexts/ViewModeContext'
import { supabase } from '@/lib/supabase'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials, formatRelativeTime, companyHasAddon, companyHasFeature } from '@/lib/utils'
import type { FeatureKey } from '@/lib/utils'
import { localizeNotif } from '@/lib/i18nDynamic'
import { useRrFoAccess } from '@/hooks/useRrFoAccess'
import { deptLabel } from '@/types'
import { cn } from '@/lib/utils'
import type { KaizenNotification } from '@/types'

export function Header() {
  const { profile, signOut } = useAuth()
  const { activeCompany, companies, setActiveCompany } = useCompany()
  const { t, lang } = useLanguage()
  const { showSidebar } = useViewMode()
  const navigate = useNavigate()
  const [notifications, setNotifications] = useState<KaizenNotification[]>([])
  const [showNotifs, setShowNotifs] = useState(false)
  const [showMobileNav, setShowMobileNav] = useState(false)
  const [showCompanySwitcher, setShowCompanySwitcher] = useState(false)
  // True unread count from a dedicated count query (not the limit(10) preview list).
  const [unreadCount, setUnreadCount] = useState(0)
  const showSwitcher = profile?.role === 'super_admin' && companies.length > 1

  // Today's date — e.g. "Sat. 13 - June 2026" (shown on mobile, where the sidebar is hidden)
  const _now = new Date()
  const _loc = lang === 'th' ? 'th-TH' : 'en-GB'
  const _fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(_loc, { timeZone: 'Asia/Bangkok', ...opts }).format(_now)
  const todayLabel = `${_fmt({ weekday: 'short' })}. ${_fmt({ day: 'numeric' })} - ${_fmt({ month: 'long' })} ${_fmt({ year: 'numeric' })}`

  const NAV_ITEMS = [
    { to: '/dashboard',      icon: LayoutDashboard, label: t.nav.dashboard,      roles: ['super_admin', 'manager'] },
    { to: '/cases',          icon: FolderOpen,      label: t.nav.cases,           roles: ['super_admin', 'manager', 'staff'] },
    { to: '/cases/calendar', icon: CalendarDays,    label: t.nav.calendar,        roles: ['super_admin', 'manager', 'staff'] },
    { to: '/maintenance',    icon: Wrench,          label: t.nav.maintenance,     roles: ['super_admin', 'manager', 'staff'], addon: 'pms' as const },
    { to: '/routine-roster', icon: ClipboardList,   label: t.nav.routineRoster,   roles: ['super_admin', 'manager', 'staff'], addon: 'routine_roster' as const },
    { to: '/cases/new',      icon: PlusCircle,      label: t.nav.newCase,         roles: ['staff', 'manager', 'super_admin'] },
    { to: '/notifications',  icon: Bell,            label: t.nav.notifications,   roles: ['super_admin', 'manager', 'staff'] },
    { to: '/performance',    icon: TrendingUp,      label: t.nav.performance,     roles: ['super_admin', 'manager'], feature: 'performance_analytics' as const },
    { to: '/users',          icon: Users,           label: t.nav.users,           roles: ['super_admin', 'manager'] },
    { to: '/settings',       icon: Settings,        label: t.nav.settings,        roles: ['super_admin', 'manager', 'staff'] },
  ]

  const rrFo = useRrFoAccess()
  const visibleNavItems = NAV_ITEMS.filter(item =>
    (profile ? item.roles.includes(profile.role) : false) &&
    (item.addon === undefined || companyHasAddon(activeCompany, item.addon)) &&
    (!('feature' in item) || !item.feature || companyHasFeature(activeCompany, item.feature as FeatureKey)) &&
    (item.to !== '/routine-roster' || rrFo.allowed)
  )

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  useEffect(() => {
    if (!profile) return
    fetchNotifications()

    const channel = supabase
      .channel(`kaizen_notifications_header_${profile.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'kaizen_notifications',
        filter: `user_id=eq.${profile.id}`,
      }, () => fetchNotifications())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile])

  function syncBadge(unread: number) {
    if (unread > 0 && 'setAppBadge' in navigator) (navigator as any).setAppBadge(unread).catch(() => {})
    else if ('clearAppBadge' in navigator) (navigator as any).clearAppBadge().catch(() => {})
  }

  async function fetchNotifications() {
    if (!profile) return
    const [listRes, countRes] = await Promise.all([
      supabase.from('kaizen_notifications').select('*').eq('user_id', profile.id).order('created_at', { ascending: false }).limit(10),
      supabase.from('kaizen_notifications').select('id', { count: 'exact', head: true }).eq('user_id', profile.id).eq('is_read', false),
    ])
    if (listRes.data) setNotifications(listRes.data as KaizenNotification[])
    const unread = countRes.count ?? 0
    setUnreadCount(unread)
    syncBadge(unread) // app icon badge (more reliable on iOS than SW)
  }

  async function markRead(id: string) {
    const wasUnread = notifications.some((n) => n.id === id && !n.is_read)
    const { error } = await supabase.from('kaizen_notifications').update({ is_read: true }).eq('id', id)
    if (error) return
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, is_read: true } : n))
    if (wasUnread) setUnreadCount((c) => { const next = Math.max(0, c - 1); syncBadge(next); return next })
  }

  async function markAllRead() {
    if (!profile) return
    const { error } = await supabase.from('kaizen_notifications').update({ is_read: true }).eq('user_id', profile.id).eq('is_read', false)
    if (error) return
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })))
    setUnreadCount(0)
    syncBadge(0)
  }

  // Shared notification panel body — used by both mobile (fixed) and desktop (absolute)
  const notifPanelContent = (
    <>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="font-semibold text-sm text-gray-900">{t.notifications.title}</h3>
        {unreadCount > 0 && (
          <button onClick={markAllRead} className="text-xs text-[var(--brand-primary)] hover:underline">
            {t.notifications.markAllRead}
          </button>
        )}
      </div>
      <div className="max-h-[60vh] overflow-y-auto divide-y divide-gray-50">
        {notifications.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-400 text-center">{t.notifications.noNotifications}</p>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              className={`px-4 py-3 cursor-pointer hover:bg-gray-50 active:bg-gray-100 transition-colors ${!n.is_read ? 'bg-blue-50/50' : ''}`}
              onClick={() => {
                markRead(n.id)
                if (n.case_id) navigate(`/cases/${n.case_id}`)
                else if (n.notification_type === 'pm') navigate('/maintenance')
                else if (n.notification_type === 'rr') navigate('/routine-roster')
                else navigate('/notifications')
                setShowNotifs(false)
              }}
            >
              <div className="flex items-start gap-3">
                {!n.is_read && <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />}
                <div className={`flex-1 min-w-0 ${n.is_read ? 'pl-5' : ''}`}>
                  {(() => { const loc = localizeNotif(n, lang); return (<>
                    <p className={`text-sm font-semibold leading-snug ${!n.is_read ? 'text-gray-900' : 'text-gray-600'}`}>{loc.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{loc.message}</p>
                  </>) })()}
                  <p className="text-xs text-gray-400 mt-1">{formatRelativeTime(n.created_at)}</p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="border-t border-gray-100 px-4 py-2.5">
        <Link to="/notifications" className="text-xs text-[var(--brand-primary)] hover:underline" onClick={() => setShowNotifs(false)}>
          {t.notifications.viewAll}
        </Link>
      </div>
    </>
  )

  return (
    <header className="h-14 md:h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 md:px-6 flex-shrink-0 gap-3">

      {/* Mobile: logo mark | Desktop: search bar */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* Mobile logo — tap to open nav drawer */}
        <button
          className="flex items-center gap-2 md:hidden active:opacity-70 transition-opacity min-w-0"
          onClick={() => setShowMobileNav(true)}
        >
          <img src="/kaizen-icon.svg" alt="Kaizen" className="w-8 h-8 object-contain flex-shrink-0" />
          {/* Client business name (prominent) over the product label */}
          <span className="text-left leading-tight min-w-0">
            <span className="block text-[13px] font-bold text-gray-900 truncate">{activeCompany?.org_title || activeCompany?.name || 'Kaizen System'}</span>
            <span className="block text-[11px] font-medium text-gray-500 truncate">Kaizen System</span>
          </span>
        </button>

      </div>

      <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
        {/* Company Switcher — super admin with 2+ companies only */}
        {showSwitcher && (
          <div className="relative">
            <button
              onClick={() => setShowCompanySwitcher(!showCompanySwitcher)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors text-sm font-medium text-gray-700 w-[140px]"
            >
              <Building2 className="h-4 w-4 text-gray-500 flex-shrink-0" />
              <span className="truncate flex-1 text-left">{activeCompany?.org_title || activeCompany?.name}</span>
              <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
            </button>
            {showCompanySwitcher && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowCompanySwitcher(false)} />
                <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-xl border border-gray-200 z-30 overflow-hidden py-1">
                  <p className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">{lang === 'th' ? 'สลับบริษัท' : 'Switch Company'}</p>
                  {companies.map(c => (
                    <button
                      key={c.id}
                      onClick={() => { setActiveCompany(c); setShowCompanySwitcher(false); navigate('/dashboard') }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors ${
                        c.id === activeCompany?.id
                          ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] font-medium'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <Building2 className="h-4 w-4 flex-shrink-0" />
                      {c.org_title || c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Notification Bell */}
        <div className="relative">
          <button
            onClick={() => setShowNotifs(!showNotifs)}
            className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <Bell className="h-5 w-5 text-gray-600" />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 h-4 w-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-medium">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {showNotifs && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowNotifs(false)} />

              {showSidebar ? (
                /* ── Desktop: absolute dropdown below bell ── */
                <div className="absolute right-0 top-full mt-2 w-96 bg-white rounded-xl shadow-xl border border-gray-200 z-30 overflow-hidden">
                  {notifPanelContent}
                </div>
              ) : (
                /* ── Mobile: fixed to viewport, full-width with margin ── */
                <div
                  className="bg-white rounded-xl shadow-xl border border-gray-200 z-30 overflow-hidden"
                  style={{ position: 'fixed', left: 12, right: 12, top: 56 }}
                >
                  {notifPanelContent}
                </div>
              )}
            </>
          )}
        </div>

        {profile && (
          <Link to="/settings" className="flex items-center gap-2 hover:opacity-80 transition-opacity ml-1">
            <Avatar className="h-8 w-8">
              {profile.avatar_url && <AvatarImage src={profile.avatar_url} alt={profile.full_name} className="object-cover" />}
              <AvatarFallback className="text-xs">{getInitials(profile.full_name)}</AvatarFallback>
            </Avatar>
            <div className="hidden sm:block">
              <p className="text-sm font-medium text-gray-900 leading-tight">{profile.full_name}</p>
              <p className="text-xs text-gray-500 leading-tight">{t.roles[profile.role]}</p>
            </div>
          </Link>
        )}
      </div>

      {/* Mobile nav drawer */}
      {showMobileNav && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setShowMobileNav(false)}
          />
          {/* Drawer */}
          <div className="fixed inset-y-0 left-0 z-50 w-72 flex flex-col md:hidden animate-slide-in-left"
            style={{ background: 'var(--brand-sidebar)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <img src="/kaizen-icon.svg" alt="Kaizen" className="w-11 h-11 object-contain flex-shrink-0" />
                <div>
                  <p className="text-[#c8a882] font-bold text-base leading-snug">{activeCompany?.org_title || activeCompany?.name || 'Kaizen System'}</p>
                  <p className="text-white/90 font-semibold text-[13px] leading-snug tracking-wide">Kaizen System</p>
                  <p className="text-white/50 text-[11px] leading-snug mt-0.5">{todayLabel}</p>
                </div>
              </div>
              <button
                onClick={() => setShowMobileNav(false)}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors"
              >
                <X className="h-5 w-5 text-white/70" />
              </button>
            </div>

            {/* Nav items */}
            <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
              {visibleNavItems.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/cases'}
                  onClick={() => setShowMobileNav(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-all',
                      isActive
                        ? 'bg-white/20 text-white'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    )
                  }
                >
                  <Icon className="h-5 w-5 flex-shrink-0" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </nav>

            {/* User + sign out */}
            <div className="border-t border-white/10 p-4 space-y-3">
              {profile && (
                <div className="flex items-center gap-3">
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    {profile.avatar_url && <AvatarImage src={profile.avatar_url} alt={profile.full_name} className="object-cover" />}
                    <AvatarFallback className="text-xs">{getInitials(profile.full_name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-sm font-medium truncate">{profile.full_name}</p>
                    <p className="text-white/50 text-xs truncate">{deptLabel(profile.department, lang)}</p>
                  </div>
                </div>
              )}
              <button
                onClick={handleSignOut}
                className="flex items-center gap-2 text-white/60 hover:text-white text-sm transition-colors w-full rounded-lg px-3 py-2.5 hover:bg-white/10"
              >
                <LogOut className="h-4 w-4 flex-shrink-0" />
                {t.nav.signOut}
              </button>
              <p className="text-white/20 text-[10px] text-center tracking-wide">Kaizen System V.1.1 by NNR-Solutions</p>
            </div>
          </div>
        </>
      )}

    </header>
  )
}
