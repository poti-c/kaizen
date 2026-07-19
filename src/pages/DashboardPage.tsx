import { useEffect, useState, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Clock, AlertTriangle, PlusCircle, CheckCircle2, ChevronDown, ChevronUp, CalendarDays } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { StatusBadge, PriorityBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatRelativeTime, formatDuration, isSLABreached, CATEGORIES, companyHasAddon, bangkokDate } from '@/lib/utils'
import { PMSummaryCard } from '@/components/PMSummaryCard'
import { RRSummaryCard } from '@/components/RRSummaryCard'
import { deptLabel } from '@/types'
import type { KaizenCase, Department } from '@/types'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts'
import { differenceInHours } from 'date-fns'
import { cn } from '@/lib/utils'

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function monthKey(year: number, month: number) { return `${year}-${month}` }


export function DashboardPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const [allCases, setAllCases] = useState<KaizenCase[]>([])
  const [catList, setCatList] = useState<{ slug: string; label: string }[]>([]) // company's categories (custom)
  const [loading, setLoading] = useState(true)
  // DASH-001: sequence counter to discard stale responses from concurrent fetchAll calls
  const fetchSeq = useRef(0)

  // ── Date filter ────────────────────────────────────────────────────────────
  const now = new Date()
  const bkkNow = bangkokDate()
  const [bkkYear, bkkMM] = bkkNow.split('-').map(Number)
  const defaultKey = monthKey(bkkYear, bkkMM - 1)
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set([defaultKey]))
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => {
    const bkk = bangkokDate()
    const [y, mm] = bkk.split('-').map(Number)
    setSelectedMonths(new Set([monthKey(y, mm - 1)]))
  }, [activeCompany])

  // Build month list from actual case data (created_at only), always include current month
  const monthList = useMemo(() => {
    const keys = new Set<string>()
    const bkk = bangkokDate()
    const [y0, mm0] = bkk.split('-').map(Number)
    keys.add(monthKey(y0, mm0 - 1))
    allCases.forEach(c => {
      const bkkC = bangkokDate(new Date(c.created_at))
      const [y, mm] = bkkC.split('-').map(Number)
      keys.add(monthKey(y, mm - 1))
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
      if (allSelected) {
        const outsideCount = [...prev].filter(k => !yearMonths.includes(k)).length
        if (outsideCount > 0) {
          yearMonths.forEach(k => next.delete(k))
        } else {
          // Keep only the current Bangkok month so the invariant (≥1 selected) is preserved
          const bkk = bangkokDate(); const [bkkY, bkkMm] = bkk.split('-').map(Number)
          const defaultKey = monthKey(bkkY, bkkMm - 1)
          yearMonths.forEach(k => next.delete(k))
          next.add(defaultKey)
        }
      }
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
    return lang === 'th' ? `เลือกแล้ว ${selectedMonths.size} เดือน` : `${selectedMonths.size} months selected`
  }, [selectedMonths, monthList, lang])

  // ── Category status filter ─────────────────────────────────────────────────
  const [catStatus, setCatStatus] = useState<'all' | 'open' | 'in_progress' | 'pending' | 'closed' | 'reopened'>('all')

  // ── Filtered cases ────────────────────────────────────────────────────────
  const filteredCases = useMemo(() =>
    allCases.filter(c => {
      const bkk = bangkokDate(new Date(c.created_at))
      const [y, mm] = bkk.split('-').map(Number)
      return selectedMonths.has(monthKey(y, mm - 1))
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

  // KPIs — always from filteredCases
  const avgResolutionHours = useMemo(() => {
    const closed = filteredCases.filter(c => c.status === 'closed' && c.closed_at)
    if (!closed.length) return null
    return closed.reduce((s, c) => s + differenceInHours(new Date(c.closed_at!), new Date(c.created_at)), 0) / closed.length
  }, [filteredCases])

  const resolutionRate = useMemo(() =>
    filteredCases.length > 0 ? Math.round((stats.closed / filteredCases.length) * 100) : 0,
  [filteredCases, stats])

  // Scope to filteredCases (the selected months) so the Overdue count in the Case
  // Overview card matches the donut Total and the other rows — which all derive from
  // filteredCases. Using allCases let Overdue span all time and even exceed the Total.
  const overdueCases = useMemo(() =>
    filteredCases.filter(c => isSLABreached(c)).map(c => ({ id: c.id, case_number: c.case_number, title: c.title })),
  [filteredCases])

  const criticalCases = useMemo(() =>
    filteredCases.filter(c => c.priority === 'critical' && c.status !== 'closed').map(c => ({ id: c.id, case_number: c.case_number, title: c.title })),
  [filteredCases])

  // ── Monthly bar data (always last 9 months of allCases) ───────────────────
  const monthlyData = useMemo(() => {
    const bkk = bangkokDate()
    const [bY, bMM] = bkk.split('-').map(Number)
    // Trailing 9 months ending at the current month (i === 8), so the chart shows
    // real history rather than 4 always-empty future months.
    const months = Array.from({ length: 9 }, (_, i) => {
      let mY = bY; let mM = bMM - 8 + i
      while (mM < 1) { mM += 12; mY-- }
      while (mM > 12) { mM -= 12; mY++ }
      const bkkMonth = mM - 1  // 0-indexed
      return { year: mY, month: bkkMonth, label: `${MONTH_SHORT[bkkMonth]} ${mY}` }
    })
    const monthMap: Record<string, number> = {}
    months.forEach(({ label }) => { monthMap[label] = 0 })
    allCases.forEach(c => {
      // Bucket by Bangkok time so the bars match the bangkokDate-based labels
      // (and the donut/overview totals) for viewers in any timezone.
      const [yy, mm] = bangkokDate(new Date(c.created_at)).split('-').map(Number)
      const key = `${MONTH_SHORT[mm - 1]} ${yy}`
      if (key in monthMap) monthMap[key]++
    })
    return months.map(({ label }) => ({ month: label, count: monthMap[label] }))
  }, [allCases])

  // ── Category data (from catFilteredCases) ─────────────────────────────────
  // Use the company's own category list (falls back to the built-in defaults).
  const effectiveCats = useMemo(
    () => {
      const base = catList.length ? catList : CATEGORIES.map(c => ({ slug: c, label: t.categories[c as keyof typeof t.categories] || c }))
      // 'preventive_maintenance' is NOT a category anyone picks — it is written
      // only by kaizen_pm_sync when the PMS add-on auto-creates a PM case. It is
      // listed here purely so those cases are counted under their own name
      // instead of falling into "Other".
      //
      // Gate on cases actually existing rather than on the add-on being enabled:
      // with the add-on on and no PM cases yet, the old check left a permanent
      // empty "Preventive Maintenance" row in the legend, competing with the
      // company's own maintenance category.
      const hasPmCases = allCases.some(c => c.category === 'preventive_maintenance')
      if (hasPmCases && !base.some(c => c.slug === 'preventive_maintenance')) {
        return [...base, { slug: 'preventive_maintenance', label: t.categories?.preventive_maintenance ?? 'Preventive Maintenance' }]
      }
      return base
    },
    [catList, t, allCases],
  )
  const categoryData = useMemo(() => {
    const catMap: Record<string, number> = {}
    effectiveCats.forEach(c => { catMap[c.slug] = 0 })
    // Cases whose stored slug is not in the company's current category list
    // (e.g. built-in slugs left over after a company defined custom categories)
    // go into an explicit "Other" bucket so they are not silently dropped and
    // the donut total reconciles with the actual case count.
    let other = 0
    catFilteredCases.forEach(c => {
      const slug = (c.category || '').toLowerCase().replace(/ /g, '_')
      if (slug in catMap) catMap[slug]++
      else other++
    })
    catMap.__other__ = other
    return catMap
  }, [catFilteredCases, effectiveCats])

  useEffect(() => {
    if (!profile || !activeCompany) {
      // Without a profile/active company fetchAll never runs; resolve the
      // loading state so the page shows an empty state instead of spinning forever.
      setLoading(false)
      return
    }
    fetchAll()
  }, [profile, activeCompany])

  async function fetchAll() {
    if (!profile) return
    // DASH-001: stamp this call; discard response if a newer call fires before this resolves
    const seq = ++fetchSeq.current
    setLoading(true)
    let query = supabase.from('kaizen_cases').select('*, creator:kaizen_profiles!kaizen_cases_created_by_fkey(full_name, department)')
    if (activeCompany) query = query.eq('company_id', activeCompany.id)
    // DASH-002: surface query errors instead of silently showing empty dashboard
    const { data, error } = await query.order('created_at', { ascending: false })
    if (seq !== fetchSeq.current) return
    if (error) { setAllCases([]); setCatList([]); setLoading(false); console.error('[Dashboard] fetch error', error.message); return }
    // Staff scope: own department, any department tagged as involved, or cases they
    // are PIC of. Filtered client-side (not a server .eq) so involved-department
    // cases are included; a raw PostgREST .or() would break on custom dept labels
    // that contain commas/parens (BUG-002).
    const rows = (data || []) as KaizenCase[]
    const staffDept = profile.department ?? ''
    setAllCases(profile.role === 'staff'
      ? rows.filter(c => c.department === staffDept || (!!staffDept && (c.assigned_departments ?? []).includes(staffDept as Department)) || (c.pic_ids ?? []).includes(profile.id))
      : rows)
    if (seq !== fetchSeq.current) return
    if (activeCompany) {
      const { data: catRow } = await supabase.from('kaizen_settings').select('value')
        .eq('company_id', activeCompany.id).eq('key', 'custom_categories').maybeSingle()
      if (seq !== fetchSeq.current) return
      const labels = Array.isArray(catRow?.value) ? (catRow!.value as string[]) : []
      setCatList(labels.map(l => ({ slug: l.toLowerCase().replace(/ /g, '_'), label: l })))
    }
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
    // Round to whole hours FIRST, then split into days/hours so a remainder that
    // rounds up to 24 carries into the day count (47.6h → "2d 0h", not "1d 24h").
    const total = Math.round(hours)
    if (total < 24) return `${total}h`
    return `${Math.floor(total / 24)}d ${total % 24}h`
  }

  const PIE_COLORS = { open: '#f97316', reopened: '#ef4444', inProgress: '#3b82f6', pending: '#f59e0b', resolved: '#22c55e' }
  const CATEGORY_PIE_COLORS: Record<string, string> = {
    maintenance: '#3b82f6', cleanliness: '#14b8a6', safety: '#ef4444',
    guest_complaint: '#a855f7', equipment: '#f97316', other: '#6b7280',
  }
  const CAT_FALLBACK = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#6366f1']

  const pieData = [
    { name: t.dashboard.open,             value: stats.open,       color: PIE_COLORS.open,       group: 'open' },
    { name: t.dashboard.inProgress,       value: stats.inProgress, color: PIE_COLORS.inProgress, group: 'in_progress' },
    { name: t.dashboard.waitingApproval,  value: stats.pending,    color: PIE_COLORS.pending,     group: 'pending' },
    { name: t.dashboard.resolved,         value: stats.closed,     color: PIE_COLORS.resolved,    group: 'resolved' },
    { name: t.status.reopened,            value: stats.reopened,   color: PIE_COLORS.reopened,    group: 'reopened' },
  ].filter(d => d.value > 0)

  const catPieData = effectiveCats.map((c, i) => ({
    name:     c.label,
    value:    categoryData[c.slug] ?? 0,
    color:    CATEGORY_PIE_COLORS[c.slug] || CAT_FALLBACK[i % CAT_FALLBACK.length],
    category: c.slug,
  }))
  // Surface cases whose category no longer exists in the taxonomy as "Other"
  // rather than dropping them from the chart (see categoryData.__other__).
  //
  // DASH-BUG-01: this pushed `category: 'other'` — the SAME key a company's own
  // real "Other" category row uses when effectiveCats includes one (built in,
  // or kept as a custom category). Two rows sharing a React key means one
  // silently overwrites the other's DOM node on reorder/update, and both
  // pointed the deep-link at `/cases?category=other`, so whichever row
  // survived showed a count (the orphan count) that did not match what
  // clicking through to that filtered case list actually contained (the real
  // "Other"-category cases). Give the orphan bucket its own identity: merge
  // into an existing real "Other" row's count if there is one, otherwise add a
  // distinct, non-navigating row (the render below skips the Link for it,
  // since `/cases?category=__other__` is not a filter CasesPage understands).
  if ((categoryData.__other__ ?? 0) > 0) {
    const existingOther = catPieData.find(d => d.category === 'other')
    if (existingOther) {
      existingOther.value += categoryData.__other__
    } else {
      catPieData.push({
        name:     t.categories?.other ?? 'Other',
        value:    categoryData.__other__,
        color:    CAT_FALLBACK[effectiveCats.length % CAT_FALLBACK.length],
        category: '__other__',
      })
    }
  }
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

  // DASH-003: use filteredCases so Recent Cases respects the month picker
  const recentCases = filteredCases.slice(0, 5)

  if (loading) return (
    <div className="p-8 flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between mb-4 md:mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t.dashboard.title}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t.dashboard.welcome}, {profile?.full_name} · {profile ? deptLabel(profile.department, lang) : ''}
          </p>
        </div>
        {(profile?.role === 'staff' || profile?.role === 'manager' || profile?.role === 'super_admin') && (
          <Link to="/cases/new" className="hidden md:block">
            <Button><PlusCircle className="h-4 w-4" />{t.dashboard.newCase}</Button>
          </Link>
        )}
      </div>

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
                { label: t.dashboard.overdue,         count: overdueCases.length, color: '#dc2626',          to: '/cases?group=overdue',     hover: 'hover:bg-red-50' },
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
              {catPieData.map((d) => {
                // DASH-BUG-01: '__other__' is the synthetic orphaned-category
                // bucket, not a real filterable category — CasesPage has no
                // matching filter for it, so this row isn't a link.
                const rowClass = "flex items-center justify-between px-2 py-1 rounded-lg hover:bg-gray-50 transition-colors group"
                const inner = (
                  <>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color, opacity: d.value === 0 ? 0.3 : 1 }} />
                      <span className={`text-xs truncate ${d.value === 0 ? 'text-gray-400' : 'text-gray-700'}`}>{d.name}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 ml-1">
                      <span className="text-sm font-bold" style={{ color: d.value > 0 ? d.color : undefined }}>{d.value === 0 ? <span className="text-gray-300">0</span> : d.value}</span>
                      {d.value > 0 && d.category !== '__other__' && <svg className="h-3 w-3 text-gray-300 group-hover:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
                    </div>
                  </>
                )
                return d.category === '__other__' ? (
                  <div key={d.category} className={rowClass}>{inner}</div>
                ) : (
                  <Link key={d.category} to={`/cases?category=${d.category}`} className={rowClass}>{inner}</Link>
                )
              })}
            </div>
          </div>
        </div>

      </div>

      {/* Avg Resolution + Resolution Rate — one line, under the overview cards */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <div className="w-6 h-6 rounded-md bg-purple-50 flex items-center justify-center flex-shrink-0">
              <Clock className="h-3.5 w-3.5 text-purple-600" />
            </div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.avgResolution}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatResolution(avgResolutionHours)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <div className="w-6 h-6 rounded-md bg-green-50 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
            </div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.resolutionRate}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{resolutionRate}%</p>
        </div>
      </div>

      {/* Preventive Maintenance summary (PMS add-on only) */}
      {companyHasAddon(activeCompany, 'pms') && <PMSummaryCard />}

      {/* Routine Roster summary (Routine Roster add-on only) */}
      {companyHasAddon(activeCompany, 'routine_roster') && <RRSummaryCard />}

      {/* Banners */}
      {criticalCases.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <div className="flex items-center gap-3 mb-2">
            <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-800 font-medium">{t.dashboard.criticalBanner(criticalCases.length)}</p>
          </div>
          <div className="flex flex-wrap gap-2 pl-8">
            {criticalCases.map(c => (
              <Link key={c.id} to={`/cases/${c.id}`}
                className="inline-flex items-center gap-1.5 text-xs bg-red-100 hover:bg-red-200 text-red-800 font-medium px-2.5 py-1 rounded-full transition-colors">
                <span className="font-bold">{c.case_number}</span>
                <span className="text-red-400">·</span>
                <span className="truncate max-w-[160px]">{c.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {overdueCases.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-3 mb-2">
            <Clock className="h-5 w-5 text-amber-600 flex-shrink-0" />
            <p className="text-sm text-amber-800 font-medium">{t.dashboard.slaBanner(overdueCases.length)}</p>
          </div>
          <div className="flex flex-wrap gap-2 pl-8">
            {overdueCases.map(c => (
              <Link key={c.id} to={`/cases/${c.id}`}
                className="inline-flex items-center gap-1.5 text-xs bg-amber-100 hover:bg-amber-200 text-amber-800 font-medium px-2.5 py-1 rounded-full transition-colors">
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
                    <Cell key={i} fill="var(--brand-primary)" fillOpacity={i === monthlyData.length - 1 ? 1 : 0.45} />
                  ))}
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
                <Link key={c.id} to={`/cases/${c.id}`} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors">
                  <div className="flex-shrink-0 w-10 text-center">
                    {(() => { const [,bm,bd] = bangkokDate(new Date(c.created_at)).split('-'); return (<>
                      <p className="text-sm font-semibold text-gray-800 leading-none">{parseInt(bd)}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{MONTH_SHORT[parseInt(bm) - 1]}</p>
                    </>) })()}
                  </div>
                  <div className="w-px h-10 bg-gray-100 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="text-xs text-gray-400 font-mono whitespace-nowrap">{c.case_number}</span>
                      <StatusBadge status={c.status} />
                      <PriorityBadge priority={c.priority} />
                    </div>
                    <p className="text-sm font-medium text-gray-900 truncate">{c.title}</p>
                  </div>
                  {(() => {
                    const { pct, color } = getCaseProgress(c.status)
                    return (
                      <div className="hidden md:flex flex-shrink-0 w-40 flex-col items-end gap-1">
                        <span className="text-xs font-medium text-gray-500">{pct}%</span>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                          <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                        </div>
                      </div>
                    )
                  })()}
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
