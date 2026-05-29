import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen, Clock, AlertTriangle, PlusCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { StatusBadge, PriorityBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { formatRelativeTime, formatDuration, isSLABreached, CATEGORIES } from '@/lib/utils'
import { DEPARTMENT_LABELS } from '@/types'
import type { KaizenCase, Department } from '@/types'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts'
import { differenceInHours } from 'date-fns'


interface Stats {
  total: number
  open: number
  reopened: number
  inProgress: number
  pending: number
  closed: number
  critical: number
}

export function DashboardPage() {
  const { profile } = useAuth()
  const { t, lang } = useLanguage()
  const [stats, setStats] = useState<Stats>({ total: 0, open: 0, reopened: 0, inProgress: 0, pending: 0, closed: 0, critical: 0 })
  const [recentCases, setRecentCases] = useState<KaizenCase[]>([])
  const [monthlyData, setMonthlyData] = useState<{ month: string; count: number }[]>([])
  const [categoryData, setCategoryData] = useState<{ cat: string; count: number }[]>([])
  const [loading, setLoading] = useState(true)

  // KPI state
  const [avgResolutionHours, setAvgResolutionHours] = useState<number | null>(null)
  const [resolutionRate, setResolutionRate] = useState<number>(0)
  const [casesThisMonth, setCasesThisMonth] = useState(0)
  const [overdueCount, setOverdueCount] = useState(0)
  const [overdueCases, setOverdueCases] = useState<{ id: string; case_number: string; title: string }[]>([])
  const [criticalCases, setCriticalCases] = useState<{ id: string; case_number: string; title: string }[]>([])
  const [recurringCount, setRecurringCount] = useState(0)

  // Dept performance
  const [deptPerf, setDeptPerf] = useState<{
    dept: string
    total: number
    open: number
    resolutionRate: number
    avgDays: number | null
    overdue: number
  }[]>([])

  useEffect(() => {
    if (!profile) return
    fetchDashboardData()
  }, [profile])

  async function fetchDashboardData() {
    if (!profile) return
    setLoading(true)

    let query = supabase.from('kaizen_cases').select('*, creator:kaizen_profiles!kaizen_cases_created_by_fkey(full_name, department)')

    if (profile.role === 'staff') {
      query = query.eq('department', profile.department)
    }

    const { data } = await query.order('created_at', { ascending: false })
    const cases = (data || []) as KaizenCase[]

    setStats({
      total: cases.length,
      open: cases.filter((c) => c.status === 'open').length,
      reopened: cases.filter((c) => c.status === 'reopened').length,
      inProgress: cases.filter((c) => ['assigned', 'in_progress'].includes(c.status)).length,
      pending: cases.filter((c) => ['pending_manager_approval', 'pending_admin_approval'].includes(c.status)).length,
      closed: cases.filter((c) => c.status === 'closed').length,
      critical: cases.filter((c) => c.priority === 'critical' && c.status !== 'closed').length,
    })
    setCriticalCases(cases.filter(c => c.priority === 'critical' && c.status !== 'closed').map(c => ({ id: c.id, case_number: c.case_number, title: c.title })))

    setRecentCases(cases.slice(0, 5))

    // Monthly data
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const now = new Date()
    const months = Array.from({ length: 9 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 4 + i, 1)
      return { year: d.getFullYear(), month: d.getMonth(), label: `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}` }
    })
    const monthMap: Record<string, number> = {}
    months.forEach(({ label }) => { monthMap[label] = 0 })
    cases.forEach((c) => {
      const d = new Date(c.created_at)
      const key = `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`
      if (key in monthMap) monthMap[key]++
    })
    setMonthlyData(months.map(({ label }) => ({ month: label, count: monthMap[label] })))

    // Category data
    const catMap: Record<string, number> = {}
    CATEGORIES.forEach(c => { catMap[c] = 0 })
    cases.forEach((c) => {
      if (c.category && catMap[c.category] !== undefined) catMap[c.category]++
    })
    const catArr = Object.entries(catMap)
      .filter(([, count]) => count > 0)
      .map(([cat, count]) => ({ cat, count }))
    setCategoryData(catArr)

    // KPI: this month
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const thisMonthCases = cases.filter(c => new Date(c.created_at) >= thisMonthStart)
    setCasesThisMonth(thisMonthCases.length)

    // KPI: avg resolution this month
    const closedThisMonth = thisMonthCases.filter(c => c.status === 'closed' && c.closed_at)
    if (closedThisMonth.length > 0) {
      const totalHours = closedThisMonth.reduce((sum, c) => {
        return sum + differenceInHours(new Date(c.closed_at!), new Date(c.created_at))
      }, 0)
      setAvgResolutionHours(totalHours / closedThisMonth.length)
    } else {
      setAvgResolutionHours(null)
    }

    // KPI: resolution rate
    setResolutionRate(cases.length > 0 ? Math.round((cases.filter(c => c.status === 'closed').length / cases.length) * 100) : 0)

    // KPI: overdue
    const overdue = cases.filter(c => isSLABreached(c))
    setOverdueCount(overdue.length)
    setOverdueCases(overdue.map(c => ({ id: c.id, case_number: c.case_number, title: c.title })))

    // KPI: recurring
    setRecurringCount(cases.filter(c => c.is_recurring).length)

    // Dept performance
    const deptSet = new Set(cases.map(c => c.department))
    const perfArr: typeof deptPerf = []
    deptSet.forEach((dept) => {
      const deptCases = cases.filter(c => c.department === dept)
      const openCases = deptCases.filter(c => c.status !== 'closed')
      const closedCases = deptCases.filter(c => c.status === 'closed' && c.closed_at)
      const avgDays = closedCases.length > 0
        ? Math.round(closedCases.reduce((sum, c) => sum + differenceInHours(new Date(c.closed_at!), new Date(c.created_at)), 0) / closedCases.length / 24 * 10) / 10
        : null
      const overdueDept = openCases.filter(c => isSLABreached(c)).length
      const resolutionRate = deptCases.length > 0
        ? Math.round((closedCases.length / deptCases.length) * 100)
        : 0
      perfArr.push({
        dept: DEPARTMENT_LABELS[dept as Department] || dept,
        total: deptCases.length,
        open: openCases.length,
        resolutionRate,
        avgDays,
        overdue: overdueDept,
      })
    })
    perfArr.sort((a, b) => b.open - a.open)
    setDeptPerf(perfArr.filter(d => d.open > 0 || d.avgDays !== null))

    setLoading(false)
  }

  function getCaseProgress(status: string): { pct: number; color: string } {
    switch (status) {
      case 'open':                      return { pct: 10,  color: '#3b82f6' }
      case 'reopened':                  return { pct: 15,  color: '#ef4444' }
      case 'assigned':                  return { pct: 35,  color: '#a855f7' }
      case 'in_progress':               return { pct: 55,  color: '#eab308' }
      case 'pending_manager_approval':  return { pct: 75,  color: '#f97316' }
      case 'pending_admin_approval':    return { pct: 90,  color: '#f59e0b' }
      case 'closed':                    return { pct: 100, color: '#22c55e' }
      default:                          return { pct: 0,   color: '#d1d5db' }
    }
  }

  function formatResolution(hours: number | null): string {
    if (hours === null) return '—'
    if (hours < 24) return `${Math.round(hours)}h`
    const days = Math.floor(hours / 24)
    const remainHours = Math.round(hours % 24)
    return `${days}d ${remainHours}h`
  }

  const PIE_COLORS = {
    open:       '#f97316',
    reopened:   '#ef4444',
    inProgress: '#3b82f6',
    pending:    '#f59e0b',
    resolved:   '#22c55e',
  }

  const CATEGORY_PIE_COLORS: Record<string, string> = {
    maintenance:     '#3b82f6',
    cleanliness:     '#14b8a6',
    safety:          '#ef4444',
    guest_complaint: '#a855f7',
    equipment:       '#f97316',
    other:           '#6b7280',
  }

  const CATEGORY_LABELS_DISPLAY: Record<string, string> = {
    maintenance:     'Maintenance',
    cleanliness:     'Cleanliness',
    safety:          'Safety',
    guest_complaint: 'Guest Complaint',
    equipment:       'Equipment',
    other:           'Other',
  }

  const pieData = [
    { name: t.dashboard.open,                                     value: stats.open,       color: PIE_COLORS.open,       group: 'open' },
    { name: t.dashboard.inProgress,                               value: stats.inProgress, color: PIE_COLORS.inProgress, group: 'in_progress' },
    { name: lang === 'th' ? 'รอการอนุมัติ' : 'Waiting Approval', value: stats.pending,    color: PIE_COLORS.pending,    group: 'pending' },
    { name: t.dashboard.resolved,                                 value: stats.closed,     color: PIE_COLORS.resolved,   group: 'resolved' },
    { name: lang === 'th' ? 'เปิดใหม่อีกครั้ง' : 'Reopened',    value: stats.reopened,   color: PIE_COLORS.reopened,   group: 'reopened' },
  ].filter(d => d.value > 0)

  // Category pie — use all 6 categories, show 0-count ones dimmed
  const catPieData = CATEGORIES.map(cat => ({
    name:     CATEGORY_LABELS_DISPLAY[cat] || cat,
    value:    categoryData.find(d => d.cat === cat)?.count ?? 0,
    color:    CATEGORY_PIE_COLORS[cat] || '#9ca3af',
    category: cat,
  }))
  const catTotal = catPieData.reduce((s, d) => s + d.value, 0)
  const catPieSlices = catPieData.filter(d => d.value > 0)

  const emptyPie = stats.total === 0

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between mb-4 md:mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t.dashboard.title}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t.dashboard.welcome}, {profile?.full_name} · {profile ? DEPARTMENT_LABELS[profile.department] : ''}
          </p>
        </div>
        {(profile?.role === 'staff' || profile?.role === 'manager' || profile?.role === 'super_admin') && (
          <Link to="/cases/new">
            <Button>
              <PlusCircle className="h-4 w-4" />
              {t.dashboard.newCase}
            </Button>
          </Link>
        )}
      </div>

      {/* Two pie charts side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">

        {/* ── Case Overview ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="font-semibold text-gray-900 mb-4">{lang === 'th' ? 'ภาพรวมเคส' : 'Case Overview'}</h2>
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {/* Donut */}
            <div className="relative flex-shrink-0" style={{ width: 160, height: 160 }}>
              {emptyPie ? (
                <div className="w-full h-full rounded-full border-[16px] border-gray-100 flex items-center justify-center">
                  <span className="text-gray-400 text-xs text-center">{lang === 'th' ? 'ไม่มีข้อมูล' : 'No data'}</span>
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={72} paddingAngle={pieData.length > 1 ? 3 : 0} dataKey="value" startAngle={90} endAngle={-270}>
                        {pieData.map((entry, i) => <Cell key={i} fill={entry.color} stroke="none" />)}
                      </Pie>
                      <Tooltip formatter={(v: number) => [v, lang === 'th' ? 'เคส' : 'Cases']} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-2xl font-bold text-gray-900 leading-none">{stats.total}</span>
                    <span className="text-xs text-gray-500 mt-1">{lang === 'th' ? 'ทั้งหมด' : 'Total'}</span>
                  </div>
                </>
              )}
            </div>
            {/* Legend */}
            <div className="flex-1 w-full space-y-0.5">
              {[
                { label: t.dashboard.totalCases,                              count: stats.total,      color: '#9ca3af', to: '/cases',               hover: 'hover:bg-gray-50' },
                { label: t.dashboard.open,                                    count: stats.open,       color: PIE_COLORS.open,       to: '/cases?status=open',       hover: 'hover:bg-orange-50' },
                { label: t.dashboard.inProgress,                              count: stats.inProgress, color: PIE_COLORS.inProgress, to: '/cases?group=in_progress', hover: 'hover:bg-blue-50' },
                { label: lang === 'th' ? 'รอการอนุมัติ' : 'Waiting Approval', count: stats.pending,    color: PIE_COLORS.pending,    to: '/cases?group=pending',     hover: 'hover:bg-amber-50' },
                { label: t.dashboard.resolved,                                count: stats.closed,     color: PIE_COLORS.resolved,   to: '/cases?group=resolved',    hover: 'hover:bg-green-50' },
                { label: lang === 'th' ? 'เปิดใหม่อีกครั้ง' : 'Reopened',   count: stats.reopened,   color: PIE_COLORS.reopened,   to: '/cases?status=reopened',   hover: 'hover:bg-red-50' },
              ].map(({ label, count, color, to, hover }) => (
                <Link key={to} to={to} className={`flex items-center justify-between px-3 py-2 rounded-lg ${hover} transition-colors group`}>
                  <div className="flex items-center gap-2.5">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color, opacity: count === 0 && label !== t.dashboard.totalCases ? 0.3 : 1 }} />
                    <span className={`text-sm ${count === 0 && label !== t.dashboard.totalCases ? 'text-gray-400' : 'text-gray-700'}`}>{label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-base font-bold ${count === 0 && label !== t.dashboard.totalCases ? 'text-gray-300' : 'text-gray-900'}`} style={{ color: count > 0 ? color : undefined }}>{count}</span>
                    {count > 0 && <svg className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* ── Case by Category ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h2 className="font-semibold text-gray-900 mb-4">{lang === 'th' ? 'หมวดหมู่เคส' : 'Case by Category'}</h2>
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {/* Donut (left) */}
            <div className="relative flex-shrink-0" style={{ width: 160, height: 160 }}>
              {catTotal === 0 ? (
                <div className="w-full h-full rounded-full border-[16px] border-gray-100 flex items-center justify-center">
                  <span className="text-gray-400 text-xs text-center">{lang === 'th' ? 'ไม่มีข้อมูล' : 'No data'}</span>
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={catPieSlices} cx="50%" cy="50%" innerRadius={50} outerRadius={72} paddingAngle={catPieSlices.length > 1 ? 3 : 0} dataKey="value" startAngle={90} endAngle={-270}>
                        {catPieSlices.map((entry, i) => <Cell key={i} fill={entry.color} stroke="none" />)}
                      </Pie>
                      <Tooltip formatter={(v: number, name: string) => [v, name]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-2xl font-bold text-gray-900 leading-none">{catTotal}</span>
                    <span className="text-xs text-gray-500 mt-1">{lang === 'th' ? 'เคส' : 'Cases'}</span>
                  </div>
                </>
              )}
            </div>
            {/* Legend (right) */}
            <div className="flex-1 w-full space-y-0.5">
              {catPieData.map((d) => (
                <Link
                  key={d.category}
                  to={`/cases?category=${d.category}`}
                  className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors group"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: d.color, opacity: d.value === 0 ? 0.3 : 1 }} />
                    <span className={`text-sm ${d.value === 0 ? 'text-gray-400' : 'text-gray-700'}`}>{d.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-base font-bold`} style={{ color: d.value > 0 ? d.color : undefined }}>{d.value === 0 ? <span className="text-gray-300">0</span> : d.value}</span>
                    {d.value > 0 && (
                      <svg className="h-3.5 w-3.5 text-gray-300 group-hover:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>

      </div>

      {/* KPI stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center">
              <Clock className="h-4 w-4 text-purple-600" />
            </div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.avgResolution}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatResolution(avgResolutionHours)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            </div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.resolutionRate}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{resolutionRate}%</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <FolderOpen className="h-4 w-4 text-blue-600" />
            </div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.casesThisMonth}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{casesThisMonth}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-red-600" />
            </div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.overdueSLA}</p>
          </div>
          <p className={`text-2xl font-bold ${overdueCount > 0 ? 'text-red-600' : 'text-gray-900'}`}>{overdueCount}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center">
              <RefreshCw className="h-4 w-4 text-orange-600" />
            </div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.recurringIssues}</p>
          </div>
          <p className={`text-2xl font-bold ${recurringCount > 0 ? 'text-orange-600' : 'text-gray-900'}`}>{recurringCount}</p>
        </div>
      </div>

      {/* Banners */}
      {stats.critical > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <div className="flex items-center gap-3 mb-2">
            <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-800 font-medium">{t.dashboard.criticalBanner(stats.critical)}</p>
          </div>
          <div className="flex flex-wrap gap-2 pl-8">
            {criticalCases.map(c => (
              <Link
                key={c.id}
                to={`/cases/${c.id}`}
                className="inline-flex items-center gap-1.5 text-xs bg-red-100 hover:bg-red-200 text-red-800 font-medium px-2.5 py-1 rounded-full transition-colors"
              >
                <span className="font-bold">{c.case_number}</span>
                <span className="text-red-400">·</span>
                <span className="truncate max-w-[160px]">{c.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {overdueCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-3 mb-2">
            <Clock className="h-5 w-5 text-amber-600 flex-shrink-0" />
            <p className="text-sm text-amber-800 font-medium">{t.dashboard.slaBanner(overdueCount)}</p>
          </div>
          <div className="flex flex-wrap gap-2 pl-8">
            {overdueCases.map(c => (
              <Link
                key={c.id}
                to={`/cases/${c.id}`}
                className="inline-flex items-center gap-1.5 text-xs bg-amber-100 hover:bg-amber-200 text-amber-800 font-medium px-2.5 py-1 rounded-full transition-colors"
              >
                <span className="font-bold">{c.case_number}</span>
                <span className="text-amber-600">·</span>
                <span className="truncate max-w-[160px]">{c.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-6">

        {/* Monthly Cases Trend */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">{lang === 'th' ? 'เคสรายเดือน' : 'Monthly Cases'}</h2>
          </div>
          <div className="p-4 pt-5">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={monthlyData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                  formatter={(v: number) => [v, lang === 'th' ? 'เคส' : 'Cases']}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {monthlyData.map((entry, i) => {
                    const isCurrentMonth = i === 4
                    return <Cell key={i} fill="var(--brand-primary)" fillOpacity={isCurrentMonth ? 1 : 0.45} />
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent Cases */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">{t.dashboard.recentCases}</h2>
            <Link to="/cases" className="text-sm text-[var(--brand-primary)] hover:underline">{t.dashboard.viewAll}</Link>
          </div>
          <div className="divide-y divide-gray-50">
            {recentCases.length === 0 ? (
              <div className="px-5 py-8 text-center text-gray-400 text-sm">{t.dashboard.noCases}</div>
            ) : (
              recentCases.map((c) => (
                <Link
                  key={c.id}
                  to={`/cases/${c.id}`}
                  className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors"
                >
                  {/* Date */}
                  <div className="flex-shrink-0 w-10 text-center">
                    <p className="text-sm font-semibold text-gray-800 leading-none">
                      {new Date(c.created_at).getDate()}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {new Date(c.created_at).toLocaleString('en-GB', { month: 'short' })}
                    </p>
                  </div>

                  {/* Divider */}
                  <div className="w-px h-10 bg-gray-100 flex-shrink-0" />

                  {/* Case info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="text-xs text-gray-400 font-mono">{c.case_number}</span>
                      <StatusBadge status={c.status} />
                      <PriorityBadge priority={c.priority} />
                    </div>
                    <p className="text-sm font-medium text-gray-900 truncate">{c.title}</p>
                  </div>

                  {/* Progress bar */}
                  {(() => {
                    const { pct, color } = getCaseProgress(c.status)
                    return (
                      <div className="flex-shrink-0 w-56 flex flex-col items-end gap-1">
                        <span className="text-xs font-medium text-gray-500">{pct}%</span>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                          <div
                            className="h-1.5 rounded-full transition-all"
                            style={{ width: `${pct}%`, backgroundColor: color }}
                          />
                        </div>
                      </div>
                    )
                  })()}
                </Link>
              ))
            )}
          </div>
        </div>


        {/* Department Performance Table */}
        {deptPerf.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">{t.dashboard.deptPerformance}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.cases.dept}</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.dashboard.openCases}</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.dashboard.avgDays}</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.dashboard.overdue}</th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{lang === 'th' ? 'อัตราการแก้ไข' : 'Resolution Rate'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {deptPerf.map((d) => (
                    <tr key={d.dept} className="hover:bg-gray-50">
                      <td className="px-5 py-3 font-medium text-gray-900 text-sm">{d.dept}</td>
                      <td className="px-5 py-3 text-gray-700">{d.open}<span className="text-gray-400 text-xs ml-1">/ {d.total}</span></td>
                      <td className="px-5 py-3 text-gray-500">{d.avgDays !== null ? `${d.avgDays}d` : '—'}</td>
                      <td className="px-5 py-3">
                        {d.overdue > 0 ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">{d.overdue}</span>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <div className="flex-1 bg-gray-100 rounded-full h-2">
                            <div
                              className="h-2 rounded-full transition-all"
                              style={{
                                width: `${d.resolutionRate}%`,
                                backgroundColor: d.resolutionRate === 100 ? '#22c55e' : d.resolutionRate >= 50 ? '#3b82f6' : '#f97316',
                              }}
                            />
                          </div>
                          <span className={`text-xs font-semibold w-9 text-right ${d.resolutionRate === 100 ? 'text-green-600' : d.resolutionRate >= 50 ? 'text-blue-600' : 'text-orange-600'}`}>
                            {d.resolutionRate}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
