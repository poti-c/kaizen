import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen, Clock, AlertTriangle, PlusCircle, CheckCircle2, ChevronDown, ChevronUp, CalendarDays, ChevronRight, Wrench, ClipboardList, Building2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { StatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatRelativeTime, formatDuration, isSLABreached, CATEGORIES, companyHasAddon } from '@/lib/utils'
import { PMSummaryCard } from '@/components/PMSummaryCard'
import { DEPARTMENT_LABELS } from '@/types'
import type { KaizenCase, Department } from '@/types'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts'
import { cn } from '@/lib/utils'

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const PRI_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function monthKey(year: number, month: number) { return `${year}-${month}` }


export function DashboardPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const [allCases, setAllCases] = useState<KaizenCase[]>([])
  const [loading, setLoading] = useState(true)

  // ── Date filter ────────────────────────────────────────────────────────────
  const now = new Date()
  const defaultKey = monthKey(now.getFullYear(), now.getMonth())
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set([defaultKey]))
  const [pickerOpen, setPickerOpen] = useState(false)

  // Build month list from actual case data (created_at + due_date), always include current month
  const monthList = useMemo(() => {
    const keys = new Set<string>()
    const now = new Date()
    keys.add(monthKey(now.getFullYear(), now.getMonth()))
    allCases.forEach(c => {
      const d = new Date(c.created_at)
      keys.add(monthKey(d.getFullYear(), d.getMonth()))
      if (c.due_date) {
        const dd = new Date(c.due_date)
        keys.add(monthKey(dd.getFullYear(), dd.getMonth()))
      }
    })
    return Array.from(keys)
      .map(k => {
        const [y, m] = k.split('-').map(Number)
        return { year: y, month: m, label: MONTH_SHORT[m], key: k }
      })
      .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
  }, [allCases])

  const byYear = useMemo(() => {
    const map: Record<number, typeof monthList> = {}
    monthList.forEach(m => { if (!map[m.year]) map[m.year] = []; map[m.year].push(m) })
    return Object.entries(map).map(([y, ms]) => ({ year: Number(y), months: ms })).reverse()
  }, [monthList])

  function toggleMonth(key: string) {
    setSelectedMonths(prev => {
      const next = new Set(prev)
      if (next.has(key)) { if (next.size > 1) next.delete(key) } // keep at least 1
      else next.add(key)
      return next
    })
  }
  function toggleYear(year: number) {
    const yearMonths = monthList.filter(m => m.year === year).map(m => m.key)
    setSelectedMonths(prev => {
      const allSelected = yearMonths.every(k => prev.has(k))
      const next = new Set(prev)
      if (allSelected) { yearMonths.forEach(k => { if (next.size > 1) next.delete(k) }) }
      else { yearMonths.forEach(k => next.add(k)) }
      return next
    })
  }
  const selectedLabel = useMemo(() => {
    if (selectedMonths.size === 1) {
      const [key] = selectedMonths
      const m = monthList.find(x => x.key === key)
      return m ? `${m.label} ${m.year}` : ''
    }
    return `${selectedMonths.size} months selected`
  }, [selectedMonths, monthList])

  // ── Category status filter ─────────────────────────────────────────────────
  const [catStatus, setCatStatus] = useState<'all' | 'open' | 'in_progress' | 'pending' | 'closed' | 'reopened'>('all')

  // ── Filtered cases ────────────────────────────────────────────────────────
  const filteredCases = useMemo(() =>
    allCases.filter(c => {
      const d = new Date(c.created_at)
      return selectedMonths.has(monthKey(d.getFullYear(), d.getMonth()))
    }),
  [allCases, selectedMonths])

  const catFilteredCases = useMemo(() => {
    if (catStatus === 'all') return filteredCases
    if (catStatus === 'in_progress') return filteredCases.filter(c => ['assigned', 'in_progress'].includes(c.status))
    if (catStatus === 'pending') return filteredCases.filter(c => ['pending_manager_approval', 'pending_admin_approval'].includes(c.status))
    return filteredCases.filter(c => c.status === catStatus)
  }, [filteredCases, catStatus])

  // ── Stats (from filteredCases) ─────────────────────────────────────────────
  const stats = useMemo(() => ({
    total:    filteredCases.length,
    open:     filteredCases.filter(c => c.status === 'open').length,
    reopened: filteredCases.filter(c => c.status === 'reopened').length,
    inProgress: filteredCases.filter(c => ['assigned', 'in_progress'].includes(c.status)).length,
    pending:  filteredCases.filter(c => ['pending_manager_approval', 'pending_admin_approval'].includes(c.status)).length,
    closed:   filteredCases.filter(c => c.status === 'closed').length,
    critical: filteredCases.filter(c => c.priority === 'critical' && c.status !== 'closed').length,
  }), [filteredCases])

  const resolutionRate = useMemo(() =>
    filteredCases.length > 0 ? Math.round((stats.closed / filteredCases.length) * 100) : 0,
  [filteredCases, stats])

  const overdueCases = useMemo(() =>
    allCases.filter(c => isSLABreached(c)).map(c => ({ id: c.id, case_number: c.case_number, title: c.title })),
  [allCases])

  const criticalCases = useMemo(() =>
    allCases.filter(c => c.priority === 'critical' && c.status !== 'closed').map(c => ({ id: c.id, case_number: c.case_number, title: c.title })),
  [allCases])

  // ── Monthly bar data (always last 9 months of allCases) ───────────────────
  const monthlyData = useMemo(() => {
    const months = Array.from({ length: 9 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 4 + i, 1)
      return { year: d.getFullYear(), month: d.getMonth(), label: `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}` }
    })
    const monthMap: Record<string, number> = {}
    months.forEach(({ label }) => { monthMap[label] = 0 })
    allCases.forEach(c => {
      const d = new Date(c.created_at)
      const key = `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`
      if (key in monthMap) monthMap[key]++
    })
    return months.map(({ label }) => ({ month: label, count: monthMap[label] }))
  }, [allCases])

  // ── Category data (from catFilteredCases) ─────────────────────────────────
  const categoryData = useMemo(() => {
    const catMap: Record<string, number> = {}
    CATEGORIES.forEach(c => { catMap[c] = 0 })
    catFilteredCases.forEach(c => {
      const slug = (c.category || '').toLowerCase().replace(/ /g, '_')
      if (slug in catMap) catMap[slug]++
    })
    return catMap
  }, [catFilteredCases])

  useEffect(() => {
    if (!profile || !activeCompany) return
    fetchAll()
  }, [profile, activeCompany])

  async function fetchAll() {
    if (!profile) return
    setLoading(true)
    let query = supabase.from('kaizen_cases').select('*, creator:kaizen_profiles!kaizen_cases_created_by_fkey(full_name, department)')
    if (activeCompany) query = query.eq('company_id', activeCompany.id)
    if (profile.role === 'staff') query = query.eq('department', profile.department)
    const { data } = await query.order('created_at', { ascending: false })
    setAllCases((data || []) as KaizenCase[])
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

  const PIE_COLORS = { open: '#f97316', reopened: '#ef4444', inProgress: '#3b82f6', pending: '#f59e0b', resolved: '#22c55e' }
  const CATEGORY_PIE_COLORS: Record<string, string> = {
    maintenance: '#3b82f6', cleanliness: '#14b8a6', safety: '#ef4444',
    guest_complaint: '#a855f7', equipment: '#f97316', other: '#6b7280',
  }

  const pieData = [
    { name: t.dashboard.open,             value: stats.open,       color: PIE_COLORS.open,       group: 'open' },
    { name: t.dashboard.inProgress,       value: stats.inProgress, color: PIE_COLORS.inProgress, group: 'in_progress' },
    { name: t.dashboard.waitingApproval,  value: stats.pending,    color: PIE_COLORS.pending,     group: 'pending' },
    { name: t.dashboard.resolved,         value: stats.closed,     color: PIE_COLORS.resolved,    group: 'resolved' },
    { name: t.status.reopened,            value: stats.reopened,   color: PIE_COLORS.reopened,    group: 'reopened' },
  ].filter(d => d.value > 0)

  const catPieData = CATEGORIES.map(cat => ({
    name:     t.categories[cat as keyof typeof t.categories] || cat,
    value:    categoryData[cat] ?? 0,
    color:    CATEGORY_PIE_COLORS[cat] || '#9ca3af',
    category: cat,
  }))
  const catTotal = catPieData.reduce((s, d) => s + d.value, 0)
  const catPieSlices = catPieData.filter(d => d.value > 0)
  const emptyPie = stats.total === 0

  const catStatusOptions = [
    { value: 'all',         label: t.dashboard.totalCases },
    { value: 'open',        label: t.dashboard.open },
    { value: 'in_progress', label: t.dashboard.inProgress },
    { value: 'pending',     label: t.dashboard.waitingApproval },
    { value: 'closed',      label: t.dashboard.resolved },
    { value: 'reopened',    label: t.status.reopened },
  ]

  // ── Operations-style derived data (mockup layout) ──────────────────────────
  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0)
  const isToday = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() === todayMidnight.getTime() }

  const activeCases = useMemo(() => allCases.filter(c => c.status !== 'closed'), [allCases])
  const dueTodayCount = useMemo(
    () => activeCases.filter(c => c.due_date && isToday(new Date(c.due_date))).length,
    [activeCases],
  )
  const upcoming = useMemo(() =>
    [...activeCases].sort((a, b) => {
      const ad = a.due_date ? new Date(a.due_date).getTime() : Infinity
      const bd = b.due_date ? new Date(b.due_date).getTime() : Infinity
      if (ad !== bd) return ad - bd
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    }).slice(0, 6),
  [activeCases])

  const focusCases = useMemo(() =>
    [...activeCases].sort((a, b) =>
      (PRI_RANK[a.priority] ?? 9) - (PRI_RANK[b.priority] ?? 9) ||
      getCaseProgress(b.status).pct - getCaseProgress(a.status).pct,
    ).slice(0, 6),
  [activeCases])

  const attentionCount = useMemo(() => {
    const s = new Set<string>()
    overdueCases.forEach(c => s.add(c.id))
    criticalCases.forEach(c => s.add(c.id))
    allCases.filter(c => ['pending_manager_approval', 'pending_admin_approval'].includes(c.status)).forEach(c => s.add(c.id))
    return s.size
  }, [overdueCases, criticalCases, allCases])

  const deptCards = useMemo(() => {
    const map: Record<string, KaizenCase[]> = {}
    activeCases.forEach(c => { const d = c.department || 'other'; (map[d] ||= []).push(c) })
    return Object.entries(map).sort((a, b) => b[1].length - a[1].length).slice(0, 3)
  }, [activeCases])
  const DEPT_ICONS = [Wrench, ClipboardList, Building2]

  function dateChip(c: KaizenCase) {
    const d = new Date(c.due_date || c.created_at)
    return { day: d.getDate(), mon: d.toLocaleString('en-GB', { month: 'short' }).toUpperCase() }
  }

  if (loading) return (
    <div className="p-8 flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto animate-fade-in">
      {/* Page header */}
      <div className="flex items-end justify-between mb-5 md:mb-6">
        <div>
          <p className="text-[11px] font-semibold tracking-widest text-gray-400 uppercase">{t.dashboard.tagline}</p>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900 mt-0.5">{t.dashboard.title}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t.dashboard.welcome}, {profile?.full_name} · {profile ? DEPARTMENT_LABELS[profile.department] : ''}
          </p>
        </div>
        {(profile?.role === 'staff' || profile?.role === 'manager' || profile?.role === 'super_admin') && (
          <Link to="/cases/new" className="hidden md:block">
            <Button><PlusCircle className="h-4 w-4" />{t.dashboard.newCase}</Button>
          </Link>
        )}
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-6">
        {[
          { icon: CalendarDays, tint: 'bg-blue-50 text-blue-600', label: t.dashboard.dueToday, value: dueTodayCount, sub: `${stats.open} ${t.dashboard.rightNow}`, to: '/cases?status=open', danger: false },
          { icon: CheckCircle2, tint: 'bg-green-50 text-green-600', label: t.dashboard.resolvedThisMonth, value: stats.closed, sub: `${resolutionRate}% ${t.dashboard.resolutionRate}`, to: '/cases?group=resolved', danger: false },
          { icon: Clock, tint: 'bg-amber-50 text-amber-600', label: t.dashboard.inProgress, value: stats.inProgress, sub: `${stats.pending} ${t.dashboard.waitingApproval}`, to: '/cases?group=in_progress', danger: false },
          { icon: AlertTriangle, tint: 'bg-red-50 text-red-600', label: t.dashboard.needsAttention, value: attentionCount, sub: `${overdueCases.length} ${t.dashboard.overdueSLA}`, to: '/cases?status=open', danger: attentionCount > 0 },
        ].map(({ icon: Icon, tint, label, value, sub, to, danger }) => (
          <Link key={label} to={to} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 hover:shadow-md hover:border-gray-300 transition-all">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${tint}`}><Icon className="h-5 w-5" /></div>
            <p className="text-xs font-medium text-gray-500">{label}</p>
            <p className={`text-2xl md:text-[28px] font-bold leading-tight mt-0.5 ${danger ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
            <p className="text-[11px] text-gray-400 mt-0.5 truncate">{sub}</p>
          </Link>
        ))}
      </div>

      {/* Operations + focus */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-5 mb-6">
        {/* Today & upcoming cases */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">{t.dashboard.upcomingTitle}</h2>
            <Link to="/cases" className="text-sm text-[var(--brand-primary)] font-medium hover:underline flex items-center gap-1">{t.dashboard.viewAll}<ChevronRight className="h-4 w-4" /></Link>
          </div>
          <div className="divide-y divide-gray-50">
            {upcoming.length === 0 ? (
              <div className="px-5 py-10 text-center text-gray-400 text-sm">{t.dashboard.noUpcoming}</div>
            ) : upcoming.map((c) => {
              const { day, mon } = dateChip(c)
              return (
                <Link key={c.id} to={`/cases/${c.id}`} className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50 transition-colors group">
                  <div className="flex-shrink-0 w-10 text-center">
                    <p className="text-lg font-bold text-gray-800 leading-none">{day}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5 tracking-wide">{mon}</p>
                  </div>
                  <div className="w-px h-9 bg-gray-100 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{c.title}</p>
                    <p className="text-xs text-gray-400 truncate mt-0.5">
                      <span className="font-mono">{c.case_number}</span>
                      {c.category ? <> · {t.categories[c.category.toLowerCase().replace(/ /g, '_') as keyof typeof t.categories] || c.category}</> : null}
                    </p>
                  </div>
                  <StatusBadge status={c.status} />
                  <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 flex-shrink-0" />
                </Link>
              )
            })}
          </div>
        </div>

        {/* Active case progress */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">{t.dashboard.focusTitle}</h2>
          </div>
          <div className="p-4 space-y-3">
            <div className="rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-5 text-center">
              <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center mx-auto mb-2"><FolderOpen className="h-5 w-5" /></div>
              <p className="text-2xl font-bold text-gray-900">{activeCases.length}</p>
              <p className="text-xs text-gray-500 mt-0.5">{t.dashboard.activeCases}</p>
            </div>
            {focusCases.length === 0 ? (
              <p className="text-center text-sm text-gray-400 py-4">{t.dashboard.noOpenCases}</p>
            ) : focusCases.map((c) => {
              const { pct, color } = getCaseProgress(c.status)
              return (
                <Link key={c.id} to={`/cases/${c.id}`} className="block rounded-lg border border-gray-100 px-3 py-2.5 hover:border-gray-300 hover:bg-gray-50 transition-all">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-900 truncate">{c.title}</p>
                    <span className="text-xs font-semibold flex-shrink-0" style={{ color }}>{pct}%</span>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-0.5 truncate">{t.status[c.status as keyof typeof t.status] || c.status}</p>
                  <div className="w-full bg-gray-100 rounded-full h-1 mt-1.5">
                    <div className="h-1 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      </div>

      {/* Department cards */}
      {deptCards.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {deptCards.map(([dept, cases], i) => {
            const Icon = DEPT_ICONS[i % DEPT_ICONS.length]
            return (
              <div key={dept} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Icon className="h-4 w-4 text-gray-500" />
                  <h3 className="font-semibold text-gray-900 text-sm flex-1 truncate">{DEPARTMENT_LABELS[dept as Department] || dept}</h3>
                  <span className="text-xs font-semibold text-gray-400">{cases.length}</span>
                </div>
                <ul className="space-y-1.5">
                  {cases.slice(0, 3).map((c) => (
                    <li key={c.id}>
                      <Link to={`/cases/${c.id}`} className="flex items-start gap-2 text-sm text-gray-600 hover:text-[var(--brand-primary)] transition-colors">
                        <span className="text-gray-300 mt-1.5 leading-none">·</span>
                        <span className="truncate">{c.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}

      {/* Preventive Maintenance summary (PMS add-on only) */}
      {companyHasAddon(activeCompany, 'pms') && <div className="mb-6"><PMSummaryCard /></div>}

      {/* ── Analytics ──────────────────────────────────────────────────────── */}
      <h2 className="text-sm font-semibold tracking-wide text-gray-400 uppercase mb-3">{t.dashboard.analytics}</h2>

      {/* Two charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">

        {/* ── Case Overview ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          {/* Header + date filter toggle */}
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-gray-900">{t.dashboard.caseOverview}</h2>
            <button
              onClick={() => setPickerOpen(v => !v)}
              className="flex items-center gap-1.5 text-xs text-[var(--brand-primary)] font-medium hover:opacity-75 transition-opacity"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              <span>{selectedLabel}</span>
              {pickerOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
          </div>

          {/* Month picker */}
          {pickerOpen && (
            <div className="mb-3 border border-gray-100 rounded-lg p-3 bg-gray-50 space-y-3 max-h-56 overflow-y-auto">
              {byYear.map(({ year, months }) => {
                const yearKeys = months.map(m => m.key)
                const allSel = yearKeys.every(k => selectedMonths.has(k))
                return (
                  <div key={year}>
                    <button
                      onClick={() => toggleYear(year)}
                      className="text-xs font-semibold text-gray-500 mb-1.5 flex items-center gap-1.5 hover:text-gray-800 transition-colors"
                    >
                      <span className={cn('w-3 h-3 rounded border flex-shrink-0 flex items-center justify-center',
                        allSel ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)]' : 'border-gray-300 bg-white'
                      )}>
                        {allSel && <svg viewBox="0 0 10 10" className="w-2 h-2 fill-white"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </span>
                      {year}
                    </button>
                    <div className="flex flex-wrap gap-1.5">
                      {months.map(m => {
                        const sel = selectedMonths.has(m.key)
                        return (
                          <button
                            key={m.key}
                            onClick={() => toggleMonth(m.key)}
                            className={cn(
                              'px-2.5 py-1 rounded-md text-xs font-medium border transition-all',
                              sel
                                ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                                : 'bg-white text-gray-600 border-gray-200 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]'
                            )}
                          >
                            {m.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="flex flex-row items-center gap-3">
            <div className="relative flex-shrink-0" style={{ width: 120, height: 120 }}>
              {emptyPie ? (
                <div className="w-full h-full rounded-full border-[12px] border-gray-100 flex items-center justify-center">
                  <span className="text-gray-400 text-[10px] text-center">{t.dashboard.noData}</span>
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={36} outerRadius={54} paddingAngle={pieData.length > 1 ? 3 : 0} dataKey="value" startAngle={90} endAngle={-270}>
                        {pieData.map((entry, i) => <Cell key={i} fill={entry.color} stroke="none" />)}
                      </Pie>
                      <Tooltip formatter={(v: number) => [v, t.dashboard.casesShort]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-xl font-bold text-gray-900 leading-none">{stats.total}</span>
                    <span className="text-[10px] text-gray-500 mt-0.5">{t.dashboard.totalShort}</span>
                  </div>
                </>
              )}
            </div>
            <div className="flex-1 min-w-0">
              {[
                { label: t.dashboard.totalCases,      count: stats.total,      color: '#9ca3af', to: '/cases',               hover: 'hover:bg-gray-50' },
                { label: t.dashboard.open,            count: stats.open,       color: PIE_COLORS.open,       to: '/cases?status=open',       hover: 'hover:bg-orange-50' },
                { label: t.dashboard.inProgress,      count: stats.inProgress, color: PIE_COLORS.inProgress, to: '/cases?group=in_progress', hover: 'hover:bg-blue-50' },
                { label: t.dashboard.waitingApproval, count: stats.pending,    color: PIE_COLORS.pending,    to: '/cases?group=pending',     hover: 'hover:bg-amber-50' },
                { label: t.dashboard.resolved,        count: stats.closed,     color: PIE_COLORS.resolved,   to: '/cases?group=resolved',    hover: 'hover:bg-green-50' },
                { label: t.status.reopened,           count: stats.reopened,   color: PIE_COLORS.reopened,   to: '/cases?status=reopened',   hover: 'hover:bg-red-50' },
              ].map(({ label, count, color, to, hover }) => (
                <Link key={to} to={to} className={`flex items-center justify-between px-2 py-1 rounded-lg ${hover} transition-colors group`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color, opacity: count === 0 && label !== t.dashboard.totalCases ? 0.3 : 1 }} />
                    <span className={`text-xs truncate ${count === 0 && label !== t.dashboard.totalCases ? 'text-gray-400' : 'text-gray-700'}`}>{label}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-1">
                    <span className="text-sm font-bold" style={{ color: count > 0 ? color : undefined }}>{count > 0 ? count : <span className="text-gray-300">0</span>}</span>
                    {count > 0 && <svg className="h-3 w-3 text-gray-300 group-hover:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* ── Case by Category ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">{t.dashboard.casesByCategory}</h2>
            <Select value={catStatus} onValueChange={(v) => setCatStatus(v as typeof catStatus)}>
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {catStatusOptions.map(o => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-row items-center gap-3">
            <div className="relative flex-shrink-0" style={{ width: 120, height: 120 }}>
              {catTotal === 0 ? (
                <div className="w-full h-full rounded-full border-[12px] border-gray-100 flex items-center justify-center">
                  <span className="text-gray-400 text-[10px] text-center">{t.dashboard.noData}</span>
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={catPieSlices} cx="50%" cy="50%" innerRadius={36} outerRadius={54} paddingAngle={catPieSlices.length > 1 ? 3 : 0} dataKey="value" startAngle={90} endAngle={-270}>
                        {catPieSlices.map((entry, i) => <Cell key={i} fill={entry.color} stroke="none" />)}
                      </Pie>
                      <Tooltip formatter={(v: number, name: string) => [v, name]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-xl font-bold text-gray-900 leading-none">{catTotal}</span>
                    <span className="text-[10px] text-gray-500 mt-0.5">{t.dashboard.casesShort}</span>
                  </div>
                </>
              )}
            </div>
            <div className="flex-1 min-w-0">
              {catPieData.map((d) => (
                <Link
                  key={d.category}
                  to={`/cases?category=${d.category}`}
                  className="flex items-center justify-between px-2 py-1 rounded-lg hover:bg-gray-50 transition-colors group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color, opacity: d.value === 0 ? 0.3 : 1 }} />
                    <span className={`text-xs truncate ${d.value === 0 ? 'text-gray-400' : 'text-gray-700'}`}>{d.name}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-1">
                    <span className="text-sm font-bold" style={{ color: d.value > 0 ? d.color : undefined }}>{d.value === 0 ? <span className="text-gray-300">0</span> : d.value}</span>
                    {d.value > 0 && <svg className="h-3 w-3 text-gray-300 group-hover:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>

      </div>

      <div className="flex flex-col gap-6">
        {/* Monthly Cases Trend */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">{t.dashboard.monthlyCases}</h2>
          </div>
          <div className="p-4 pt-5">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={monthlyData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} formatter={(v: number) => [v, t.dashboard.casesShort]} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {monthlyData.map((entry, i) => (
                    <Cell key={i} fill="var(--brand-primary)" fillOpacity={i === 4 ? 1 : 0.45} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}
