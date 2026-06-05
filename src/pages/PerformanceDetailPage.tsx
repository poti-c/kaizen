import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link, Navigate } from 'react-router-dom'
import { ArrowLeft, User, Mail, FolderOpen, Clock, CheckCircle2, AlertTriangle, TrendingUp, CalendarDays } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { StatusBadge, PriorityBadge } from '@/components/StatusBadge'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { getInitials, formatDateTime, isSLABreached } from '@/lib/utils'
import { DEPARTMENT_LABELS } from '@/types'
import type { KaizenProfile, KaizenCase, KaizenCaseTimeline } from '@/types'
import { differenceInHours, format } from 'date-fns'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function PerformanceDetailPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const { profile: myProfile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()

  // Staff: no access at all
  if (myProfile && myProfile.role === 'staff') return <Navigate to="/cases" replace />

  const [user, setUser] = useState<KaizenProfile | null>(null)
  const [cases, setCases] = useState<KaizenCase[]>([])
  const [activity, setActivity] = useState<(KaizenCaseTimeline & { case_number?: string; case_title?: string })[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (userId) load()
  }, [userId])

  async function load() {
    setLoading(true)
    const [profileRes, casesRes, activityRes] = await Promise.all([
      supabase.from('kaizen_profiles').select('*').eq('id', userId!).single(),
      supabase.from('kaizen_cases').select('*').eq('created_by', userId!).eq('company_id', activeCompany?.id ?? '').order('created_at', { ascending: false }),
      supabase.from('kaizen_case_timeline')
        .select('*, case:kaizen_cases(case_number, title)')
        .eq('performed_by', userId!)
        .order('created_at', { ascending: false })
        .limit(30),
    ])
    if (profileRes.data) setUser(profileRes.data as KaizenProfile)
    if (casesRes.data) setCases(casesRes.data as KaizenCase[])
    if (activityRes.data) setActivity(
      activityRes.data.map((a: any) => ({ ...a, case_number: a.case?.case_number, case_title: a.case?.title }))
    )
    setLoading(false)
  }

  // ── KPIs ──
  const totalCases = cases.length
  const closedCases = cases.filter((c) => c.status === 'closed')
  const resolutionRate = totalCases > 0 ? Math.round((closedCases.length / totalCases) * 100) : 0
  const overdueCases = cases.filter((c) => isSLABreached(c))
  const avgResolutionHours = closedCases.length > 0
    ? closedCases.reduce((sum, c) => sum + differenceInHours(new Date(c.closed_at!), new Date(c.created_at)), 0) / closedCases.length
    : null

  function formatRes(h: number | null) {
    if (h === null) return '—'
    if (h < 24) return `${Math.round(h)}h`
    return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`
  }

  const now = new Date()
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const casesThisMonth = cases.filter((c) => new Date(c.created_at) >= thisMonthStart).length

  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)
    return { label: MONTH_SHORT[d.getMonth()] }
  })
  const monthMap: Record<string, number> = {}
  months.forEach(({ label }) => { monthMap[label] = 0 })
  cases.forEach((c) => {
    const key = MONTH_SHORT[new Date(c.created_at).getMonth()]
    if (key in monthMap) monthMap[key]++
  })
  const monthlyData = months.map(({ label }) => ({ month: label, count: monthMap[label] }))

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!user) return <div className="p-6 text-center text-gray-400">{t.caseDetail.notFound}</div>

  // Access control (after user loaded)
  if (myProfile?.role === 'super_admin' && user.role === 'super_admin') {
    return <Navigate to="/performance" replace />
  }
  if (myProfile?.role === 'manager') {
    const isHR = myProfile.department === 'human_resource'
    const canView = userId === myProfile.id ||
      (isHR ? user.role === 'manager' || user.role === 'staff'
            : user.role === 'staff' && user.department === myProfile.department)
    if (!canView) return <Navigate to="/performance" replace />
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto animate-fade-in space-y-5">
      {/* Back */}
      <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" />
      </Button>

      {/* Profile card */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-center gap-4">
          <Avatar className="h-14 w-14 flex-shrink-0">
            {user.avatar_url && <AvatarImage src={user.avatar_url} alt={user.full_name} className="object-cover" />}
            <AvatarFallback className="text-lg font-semibold">{getInitials(user.full_name)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-gray-900">{user.full_name}</h1>
            {user.position && <p className="text-sm font-medium text-gray-700">{user.position}</p>}
            <p className="text-sm text-gray-500">{t.roles[user.role]} · {DEPARTMENT_LABELS[user.department]}</p>
            {!user.is_active && <span className="text-xs text-red-500 font-medium">{t.users.inactive}</span>}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-gray-600">
          {user.email && (
            <span className="flex items-center gap-2"><Mail className="h-4 w-4 text-gray-400 flex-shrink-0" />{user.email}</span>
          )}
          {user.username && (
            <span className="flex items-center gap-2"><User className="h-4 w-4 text-gray-400 flex-shrink-0" />@{user.username}</span>
          )}
          <span className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-gray-400 flex-shrink-0" />
            {lang === 'th' ? 'เริ่มงาน' : 'Joined'}: {format(new Date(user.created_at), 'dd MMM yyyy')}
          </span>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center"><FolderOpen className="h-3.5 w-3.5 text-blue-600" /></div>
            <p className="text-xs font-medium text-gray-500">{lang === 'th' ? 'เคสที่รายงาน' : 'Cases Reported'}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{totalCases}</p>
          <p className="text-xs text-gray-400 mt-0.5">{lang === 'th' ? `${casesThisMonth} เดือนนี้` : `${casesThisMonth} this month`}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-green-50 flex items-center justify-center"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /></div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.resolutionRate}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{resolutionRate}%</p>
          <p className="text-xs text-gray-400 mt-0.5">{closedCases.length} {lang === 'th' ? 'ปิดแล้ว' : 'closed'}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-purple-50 flex items-center justify-center"><Clock className="h-3.5 w-3.5 text-purple-600" /></div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.avgResolution}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatRes(avgResolutionHours)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{lang === 'th' ? 'เวลาเฉลี่ย' : 'avg. time'}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-red-50 flex items-center justify-center"><AlertTriangle className="h-3.5 w-3.5 text-red-600" /></div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.overdueSLA}</p>
          </div>
          <p className={`text-2xl font-bold ${overdueCases.length > 0 ? 'text-red-600' : 'text-gray-900'}`}>{overdueCases.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">{lang === 'th' ? 'เกินกำหนด' : 'overdue now'}</p>
        </div>
      </div>

      {/* Performance Score */}
      {totalCases > 0 && (() => {
        const onTimeScore = Math.round(((totalCases - overdueCases.length) / totalCases) * 100)
        const activityScore = Math.min(100, Math.round((activity.length / Math.max(totalCases * 5, 1)) * 100))
        const weighted = Math.round(resolutionRate * 0.4 + onTimeScore * 0.4 + activityScore * 0.2)
        const tier = weighted >= 80
          ? { label: lang === 'th' ? 'ดีเยี่ยม' : 'Excellent', color: '#22c55e', bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' }
          : weighted >= 60
          ? { label: lang === 'th' ? 'ดี' : 'Good', color: '#3b82f6', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' }
          : weighted >= 40
          ? { label: lang === 'th' ? 'ปานกลาง' : 'Fair', color: '#f59e0b', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' }
          : { label: lang === 'th' ? 'ต้องปรับปรุง' : 'Needs Attention', color: '#ef4444', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' }
        const criteria = [
          { label: lang === 'th' ? 'อัตราการแก้ไข' : 'Resolution Rate', value: resolutionRate, color: '#22c55e', note: `${closedCases.length} / ${totalCases} ${lang === 'th' ? 'เคส' : 'cases'}` },
          { label: lang === 'th' ? 'ตรงตามกำหนดเวลา' : 'On-Time Delivery', value: onTimeScore, color: '#3b82f6', note: `${totalCases - overdueCases.length} / ${totalCases} ${lang === 'th' ? 'ตรงเวลา' : 'on time'}` },
          { label: lang === 'th' ? 'ความมีส่วนร่วม' : 'Engagement', value: activityScore, color: '#8b5cf6', note: `${activity.length} ${lang === 'th' ? 'กิจกรรม' : 'actions'}` },
        ]
        return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex items-center gap-2 flex-1">
                <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" />
                <h3 className="font-semibold text-sm text-gray-900">{lang === 'th' ? 'คะแนนประสิทธิภาพโดยรวม' : 'Overall Performance Score'}</h3>
              </div>
              <span className={`px-3 py-1 rounded-full text-sm font-bold border ${tier.bg} ${tier.text} ${tier.border}`}>{tier.label}</span>
            </div>
            <div className="flex items-center gap-4 mb-5">
              <div className="relative flex-shrink-0 w-16 h-16">
                <svg className="w-16 h-16 -rotate-90" viewBox="0 0 56 56">
                  <circle cx="28" cy="28" r="22" fill="none" stroke="#f3f4f6" strokeWidth="6" />
                  <circle cx="28" cy="28" r="22" fill="none" stroke={tier.color} strokeWidth="6" strokeDasharray={`${(weighted / 100) * 138.2} 138.2`} strokeLinecap="round" />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center"><span className="text-lg font-bold text-gray-900">{weighted}</span></div>
              </div>
              <div className="flex-1">
                <p className="text-xs text-gray-400 mb-1">{lang === 'th' ? 'คะแนนเต็ม 100' : 'Score out of 100'}</p>
                <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${weighted}%`, backgroundColor: tier.color }} />
                </div>
              </div>
            </div>
            <div className="space-y-3 border-t border-gray-100 pt-4">
              {criteria.map(({ label, value, color, note }) => (
                <div key={label}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-xs font-medium text-gray-700">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-400">{note}</span>
                      <span className="text-xs font-bold" style={{ color }}>{value}%</span>
                    </div>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, backgroundColor: color }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Monthly trend */}
      {totalCases > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <h3 className="font-semibold text-sm text-gray-900 mb-3">{lang === 'th' ? 'เคสรายเดือน (6 เดือนล่าสุด)' : 'Monthly Cases (last 6 months)'}</h3>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={monthlyData} margin={{ top: 0, right: 0, left: -28, bottom: 0 }}>
              <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v: number) => [v, lang === 'th' ? 'เคส' : 'Cases']} />
              <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={32}>
                {monthlyData.map((_, i) => <Cell key={i} fill="var(--brand-primary)" fillOpacity={i === 5 ? 1 : 0.45} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Cases reported */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-900">{lang === 'th' ? 'เคสที่รายงาน' : 'Cases Reported'}</h3>
          <span className="text-xs text-gray-400">{totalCases}</span>
        </div>
        {cases.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-400 text-center">{lang === 'th' ? 'ยังไม่มีเคส' : 'No cases yet'}</p>
        ) : (
          <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
            {cases.map((c) => (
              <Link key={c.id} to={`/cases/${c.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-xs font-mono text-gray-400 whitespace-nowrap">{c.case_number}</span>
                    <StatusBadge status={c.status} />
                    <PriorityBadge priority={c.priority} />
                  </div>
                  <p className="text-sm font-medium text-gray-900 truncate">{c.title}</p>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">{format(new Date(c.created_at), 'dd MMM')}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Recent activity */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-900">{lang === 'th' ? 'กิจกรรมล่าสุด' : 'Recent Activity'}</h3>
          <span className="text-xs text-gray-400">{activity.length}</span>
        </div>
        {activity.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-400 text-center">{t.caseDetail.noActivity}</p>
        ) : (
          <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
            {activity.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-5 py-3">
                <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)] mt-1.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{a.action.replace(/_/g, ' ')}</p>
                  {a.case_number && (
                    <Link to={`/cases/${a.case_id}`} className="text-xs text-[var(--brand-primary)] hover:underline">{a.case_number} · {a.case_title}</Link>
                  )}
                  {a.description && <p className="text-xs text-gray-500 mt-0.5">{a.description}</p>}
                  <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(a.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
