import { useState, useEffect } from 'react'
import { Bell, Search, X, LayoutDashboard, FolderOpen, PlusCircle, Users, Settings, LogOut, CalendarDays, ChevronDown, Building2, Wrench } from 'lucide-react'
import { useNavigate, Link, NavLink } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { useViewMode } from '@/contexts/ViewModeContext'
import { supabase } from '@/lib/supabase'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials, formatRelativeTime, companyHasAddon } from '@/lib/utils'
import { DEPARTMENT_LABELS } from '@/types'
import { cn } from '@/lib/utils'
import type { KaizenNotification } from '@/types'

export function Header() {
  const { profile, signOut } = useAuth()
  const { activeCompany, companies, setActiveCompany } = useCompany()
  const { t } = useLanguage()
  const { showSidebar } = useViewMode()
  const navigate = useNavigate()
  const [notifications, setNotifications] = useState<KaizenNotification[]>([])
  const [showNotifs, setShowNotifs] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showMobileNav, setShowMobileNav] = useState(false)
  const [showCompanySwitcher, setShowCompanySwitcher] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [mobileSearchQuery, setMobileSearchQuery] = useState('')
  const unreadCount = notifications.filter((n) => !n.is_read).length
  const showSwitcher = profile?.role === 'super_admin' && companies.length > 1

  const NAV_ITEMS = [
    { to: '/dashboard',      icon: LayoutDashboard, label: t.nav.dashboard,      roles: ['super_admin', 'manager'] },
    { to: '/cases',          icon: FolderOpen,      label: t.nav.cases,           roles: ['super_admin', 'manager', 'staff'] },
    { to: '/cases/calendar', icon: CalendarDays,    label: t.nav.calendar,        roles: ['super_admin', 'manager', 'staff'] },
    { to: '/maintenance',    icon: Wrench,          label: t.nav.maintenance,     roles: ['super_admin', 'manager', 'staff'], addon: 'pms' as const },
    { to: '/cases/new',      icon: PlusCircle,      label: t.nav.newCase,         roles: ['staff', 'manager', 'super_admin'] },
    { to: '/notifications',  icon: Bell,            label: t.nav.notifications,   roles: ['super_admin', 'manager', 'staff'] },
    { to: '/users',          icon: Users,           label: t.nav.users,           roles: ['super_admin', 'manager'] },
    { to: '/settings',       icon: Settings,        label: t.nav.settings,        roles: ['super_admin', 'manager', 'staff'] },
  ]

  const visibleNavItems = NAV_ITEMS.filter(item =>
    (profile ? item.roles.includes(profile.role) : false) &&
    (!('addon' in item) || companyHasAddon(activeCompany, item.addon as 'pms'))
  )

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  useEffect(() => {
    if (!profile) return
    fetchNotifications()

    const channel = supabase
      .channel('kaizen_notifications_header')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'kaizen_notifications',
        filter: `user_id=eq.${profile.id}`,
      }, () => fetchNotifications())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile])

  async function fetchNotifications() {
    if (!profile) return
    const { data } = await supabase
      .from('kaizen_notifications')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(10)
    if (data) {
      setNotifications(data as KaizenNotification[])
      // Update app icon badge from main context (more reliable on iOS than SW)
      const unread = (data as KaizenNotification[]).filter(n => !n.is_read).length
      if ('setAppBadge' in navigator) {
        unread > 0
          ? (navigator as any).setAppBadge(unread).catch(() => {})
          : (navigator as any).clearAppBadge().catch(() => {})
      }
    }
  }

  async function markRead(id: string) {
    await supabase.from('kaizen_notifications').update({ is_read: true }).eq('id', id)
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, is_read: true } : n))
  }

  async function markAllRead() {
    if (!profile) return
    await supabase.from('kaizen_notifications').update({ is_read: true }).eq('user_id', profile.id)
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })))
    if ('clearAppBadge' in navigator) (navigator as any).clearAppBadge().catch(() => {})
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
              onClick={() => { markRead(n.id); if (n.case_id) navigate(`/cases/${n.case_id}`); setShowNotifs(false) }}
            >
              <div className="flex items-start gap-3">
                {!n.is_read && <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />}
                <div className={`flex-1 min-w-0 ${n.is_read ? 'pl-5' : ''}`}>
                  <p className={`text-sm font-semibold leading-snug ${!n.is_read ? 'text-gray-900' : 'text-gray-600'}`}>{n.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{n.message}</p>
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
          <span className="text-[11px] font-semibold text-gray-900 leading-tight text-left flex-shrink-0">Kaizen<br />System</span>
        </button>

        {/* Desktop search */}
        <div className="hidden md:flex relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.cases.search}
            className="w-full pl-9 pr-4 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] focus:border-transparent"
            onKeyDown={(e) => { if (e.key === 'Enter' && searchQuery.trim()) { navigate(`/cases?q=${encodeURIComponent(searchQuery.trim())}`); setSearchQuery('') } }}
          />
        </div>
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
              <span className="truncate flex-1 text-left">{activeCompany?.name}</span>
              <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
            </button>
            {showCompanySwitcher && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowCompanySwitcher(false)} />
                <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-xl border border-gray-200 z-30 overflow-hidden py-1">
                  <p className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Switch Company</p>
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
                      {c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Mobile search toggle */}
        <button
          className="md:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors"
          onClick={() => setShowSearch(true)}
        >
          <Search className="h-5 w-5 text-gray-500" />
        </button>

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
                <img src="/kaizen-icon.svg" alt="Kaizen" className="w-10 h-10 object-contain flex-shrink-0" />
                <div>
                  <p className="text-[#c8a882] font-bold text-base leading-snug">{activeCompany?.name ?? 'Kaizen System'}</p>
                  <p className="text-white/90 font-semibold text-sm leading-snug tracking-wide">Kaizen System</p>
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
                    <p className="text-white/50 text-xs truncate">{DEPARTMENT_LABELS[profile.department]}</p>
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
              <p className="text-white/20 text-[10px] text-center tracking-wide">Kaizen System V.1 by NNR-Solutions</p>
            </div>
          </div>
        </>
      )}

      {/* Mobile search overlay */}
      {showSearch && (
        <div className="absolute inset-x-0 top-0 z-50 h-14 bg-white border-b border-gray-200 flex items-center gap-2 px-4">
          <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            autoFocus
            type="text"
            value={mobileSearchQuery}
            onChange={(e) => setMobileSearchQuery(e.target.value)}
            placeholder={t.cases.search}
            className="flex-1 text-sm bg-transparent focus:outline-none"
            onKeyDown={(e) => { if (e.key === 'Enter') { if (mobileSearchQuery.trim()) { navigate(`/cases?q=${encodeURIComponent(mobileSearchQuery.trim())}`) } setMobileSearchQuery(''); setShowSearch(false) } if (e.key === 'Escape') setShowSearch(false) }}
          />
          <button onClick={() => setShowSearch(false)} className="p-1">
            <X className="h-5 w-5 text-gray-400" />
          </button>
        </div>
      )}
    </header>
  )
}
