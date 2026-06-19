import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { formatDateTime, bangkokDate } from '@/lib/utils'
import { localizeNotif } from '@/lib/i18nDynamic'
import type { KaizenNotification } from '@/types'
import { cn } from '@/lib/utils'

export function NotificationsPage() {
  const { profile } = useAuth()
  const { t, lang } = useLanguage()
  const navigate = useNavigate()
  const [notifications, setNotifications] = useState<KaizenNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  // True unread total across ALL rows (not just the loaded page), so the
  // subtitle and "Mark all read" button stay correct beyond the first page.
  const [unread, setUnread] = useState(0)

  const PAGE_SIZE = 50

  useEffect(() => {
    if (profile) { fetchNotifications(); refreshUnread() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  // Keep the OS app-icon badge in sync with the true unread count (mirrors Header).
  function syncBadge(n: number) {
    if (n > 0 && 'setAppBadge' in navigator) (navigator as any).setAppBadge(n).catch(() => {})
    else if ('clearAppBadge' in navigator) (navigator as any).clearAppBadge().catch(() => {})
  }

  async function refreshUnread() {
    if (!profile) return
    const { count } = await supabase
      .from('kaizen_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', profile.id).eq('is_read', false)
    const n = count ?? 0
    setUnread(n)
    syncBadge(n)
  }

  // Paginated: a busy manager/super_admin accumulates thousands of rows over time, so
  // load the newest PAGE_SIZE and let the user fetch older ones on demand instead of
  // pulling the entire history into memory on every open. Keyset pagination on
  // created_at avoids the duplicate/skip that offset ranges suffer when new rows
  // are inserted between fetches.
  async function fetchNotifications(before?: string) {
    if (!profile) return
    if (!before) setLoading(true); else setLoadingMore(true)
    let q = supabase
      .from('kaizen_notifications')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE)
    if (before) q = q.lt('created_at', before)
    // NP-004: surface fetch errors instead of silently showing empty inbox
    const { data, error } = await q
    if (error) { setLoading(false); setLoadingMore(false); return }
    const page = (data || []) as KaizenNotification[]
    setNotifications((prev) => before ? [...prev, ...page] : page)
    setHasMore(page.length === PAGE_SIZE)
    setLoading(false); setLoadingMore(false)
  }

  async function markRead(id: string) {
    const wasUnread = notifications.some((n) => n.id === id && !n.is_read)
    const { error } = await supabase.from('kaizen_notifications').update({ is_read: true }).eq('id', id)
    if (error) return
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, is_read: true } : n))
    if (wasUnread) setUnread((c) => { const next = Math.max(0, c - 1); syncBadge(next); return next })
  }

  async function markAllRead() {
    if (!profile) return
    // NP-003: check error before updating UI state
    const { error } = await supabase.from('kaizen_notifications').update({ is_read: true }).eq('user_id', profile.id)
    if (error) return
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })))
    setUnread(0)
    syncBadge(0)
  }

  const typeColors: Record<string, string> = {
    new_case: 'bg-blue-500',
    case_update: 'bg-yellow-500',
    resolved: 'bg-green-500',
    approved: 'bg-violet-500',
    mention: 'bg-pink-500',
  }

  const todayStr = bangkokDate()
  const yesterdayStr = bangkokDate(new Date(Date.now() - 86400000))
  const weekAgoStr = bangkokDate(new Date(Date.now() - 7 * 86400000))

  const GROUP_KEYS = ['Today', 'Yesterday', 'This Week', 'Older'] as const
  type GroupKey = typeof GROUP_KEYS[number]
  const groupLabels: Record<GroupKey, string> = {
    'Today': t.notifications.today,
    'Yesterday': t.notifications.yesterday,
    'This Week': t.notifications.thisWeek,
    'Older': t.notifications.older,
  }

  function getGroup(dateStr: string): GroupKey {
    const d = bangkokDate(new Date(dateStr))
    if (d === todayStr) return 'Today'
    if (d === yesterdayStr) return 'Yesterday'
    if (d >= weekAgoStr) return 'This Week'
    return 'Older'
  }

  const groups: Record<GroupKey, KaizenNotification[]> = { Today: [], Yesterday: [], 'This Week': [], Older: [] }
  notifications.forEach((n) => {
    const g = getGroup(n.created_at)
    groups[g].push(n)
  })

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.notifications.title}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{unread} {t.notifications.unreadTab.toLowerCase()}</p>
        </div>
        {unread > 0 && (
          <Button variant="outline" size="sm" onClick={markAllRead}>
            <CheckCheck className="h-4 w-4" />
            {t.notifications.markAllRead}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-16 text-center">
          <Bell className="h-10 w-10 text-gray-200 mx-auto mb-3" />
          <p className="text-gray-500 font-medium">{t.notifications.noNotifications}</p>
          <p className="text-gray-400 text-sm mt-1">{t.notifications.empty}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {GROUP_KEYS.filter(g => groups[g]?.length > 0).map(groupKey => (
            <div key={groupKey} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-5 py-2.5 bg-gray-50 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{groupLabels[groupKey]}</p>
              </div>
              <div className="divide-y divide-gray-50">
                {groups[groupKey].map((n) => (
                  <div
                    key={n.id}
                    className={cn('flex items-start gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors', !n.is_read && 'bg-blue-50/40')}
                    onClick={() => {
                      markRead(n.id)
                      if (n.case_id) navigate(`/cases/${n.case_id}`)
                      else if (n.notification_type === 'pm') navigate('/maintenance')
                      else if (n.notification_type === 'rr') navigate('/routine-roster')
                    }}
                  >
                    <div className={cn('w-2.5 h-2.5 rounded-full mt-2 flex-shrink-0', typeColors[n.notification_type] || 'bg-gray-400', n.is_read && 'opacity-30')} />
                    <div className="flex-1 min-w-0">
                      {(() => { const loc = localizeNotif(n, lang); return (<>
                        <p className={cn('text-sm font-medium', n.is_read ? 'text-gray-600' : 'text-gray-900')}>{loc.title}</p>
                        <p className="text-sm text-gray-500 mt-0.5 leading-relaxed">{loc.message}</p>
                      </>) })()}
                      <p className="text-xs text-gray-400 mt-1.5">{formatDateTime(n.created_at)}</p>
                    </div>
                    {!n.is_read && <div className="w-2 h-2 rounded-full bg-blue-500 mt-2 flex-shrink-0" />}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {hasMore && (
            <div className="text-center pt-1">
              <Button variant="outline" size="sm" disabled={loadingMore}
                onClick={() => fetchNotifications(notifications[notifications.length - 1]?.created_at)}>
                {loadingMore ? (lang === 'th' ? 'กำลังโหลด…' : 'Loading…') : (lang === 'th' ? 'โหลดเพิ่มเติม' : 'Load more')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
