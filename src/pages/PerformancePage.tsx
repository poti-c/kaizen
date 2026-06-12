import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Clock, CheckCircle2, AlertTriangle, FolderOpen, Trophy, Building2, ChevronRight, ChevronLeft, Wrench } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials, isSLABreached, companyHasAddon } from '@/lib/utils'
import { loadPerfConfig, DEFAULT_PERF_CONFIG, type PerfConfig } from '@/lib/perfConfig'
import { DEPARTMENT_LABELS } from '@/types'
import type { KaizenCase, KaizenProfile, Department } from '@/types'
import { differenceInHours } from 'date-fns'

type RangeKey = 'month' | '30d' | '90d' | 'all'

interface DeptRow {
  dept: Department
  label: string
  total: number
  open: number
  resolutionRate: number
  avgDays: number | null
  overdue: number
}

interface StaffRow {
  id: string
  name: string
  avatar_url: string | null
  department: Department
  reported: number
  resolved: number
  resolutionRate: number
  overdue: number
  score: number
}

export function PerformancePage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const [cases, setCases] = useState<KaizenCase[]>([])
  const [people, setPeople] = useState<KaizenProfile[]>([])
  const [pmTasks, setPmTasks] = useState<{ status: string; due_date: string; performed_at: string | null }[]>([])
  const [cfg, setCfg] = useState<PerfConfig>(DEFAULT_PERF_CONFIG)
  const [loading, setLoading] = useState(true)
  const pmsEnabled = companyHasAddon(activeCompany, 'pms')
  const [range, setRange] = useState<RangeKey>(() => {
    return (localStorage.getItem('kaizen-perf-range') as RangeKey) || 'month'
  })
  const LEADER_PAGE_SIZE = 6
  const [leaderPage, setLeaderPage] = useState(1)

  useEffect(() => {
    if (profile && activeCompany) load()
  }, [profile, activeCompany])

  async function load() {
    setLoading(true)
    const companyFilter = activeCompany?.id
    const [casesRes, peopleRes] = await Promise.all([
      supabase.from('kaizen_cases').select('*')
        .eq('company_id', companyFilter!)
        .order('created_at', { ascending: false }),
      supabase.from('kaizen_profiles').select('*').is('deleted_at', null)
        .eq('company_id', companyFilter!),
    ])
    setCases((casesRes.data || []) as KaizenCase[])
    setPeople((peopleRes.data || []) as KaizenProfile[])
    setCfg(await loadPerfConfig(companyFilter))
    if (companyHasAddon(activeCompany, 'pms')) {
      const { data: pm } = await supabase.from('kaizen_pm_tasks').select('status, due_date, performed_at').eq('company_id', companyFilter!)
      setPmTasks((pm || []) as { status: string; due_date: string; performed_at: string | null }[])
    } else { setPmTasks([]) }
    setLoading(false)
  }

  function setRangeAndSave(r: RangeKey) {
    setRange(r)
    setLeaderPage(1)   // new period → back to the top of the leaderboard
    localStorage.setItem('kaizen-perf-range', r)
  }

  // Cases within the selected time window (by created_at)
  const scopedCases = useMemo(() => {
    if (range === 'all') return cases
    const now = new Date()
    const cutoff = range === 'month'
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : new Date(now.getTime() - (range === '30d' ? 30 : 90) * 24 * 60 * 60 * 1000)
    return cases.filter((c) => new Date(c.created_at) >= cutoff)
  }, [cases, range])

  // Manager sees only their own department; HR Manager + super_admin see all
  const isManager   = profile?.role === 'manager'
  const isHRManager = profile?.role === 'manager' && profile?.department === 'human_resource'
  const visibleCases = useMemo(() => {
    if (isManager && !isHRManager && profile) return scopedCases.filter((c) => c.department === profile.department)
    return scopedCases
  }, [scopedCases, isManager, isHRManager, profile])

  // ── Org summary ──
  const summary = useMemo(() => {
    const total = visibleCases.length
    const closed = visibleCases.filter((c) => c.status === 'closed' && c.closed_at)
    const overdue = visibleCases.filter((c) => isSLABreached(c)).length
    const avgHours = closed.length > 0
      ? closed.reduce((s, c) => s + differenceInHours(new Date(c.closed_at!), new Date(c.created_at)), 0) / closed.length
      : null
    return {
      total,
      resolutionRate: total > 0 ? Math.round((closed.length / total) * 100) : 0,
      avgHours,
      overdue,
    }
  }, [visibleCases])

  // ── Department comparison ──
  const deptRows = useMemo<DeptRow[]>(() => {
    const set = new Set(visibleCases.map((c) => c.department))
    const rows: DeptRow[] = []
    set.forEach((dept) => {
      const dc = visibleCases.filter((c) => c.department === dept)
      const open = dc.filter((c) => c.status !== 'closed')
      const closed = dc.filter((c) => c.status === 'closed' && c.closed_at)
      const avgDays = closed.length > 0
        ? Math.round(closed.reduce((s, c) => s + differenceInHours(new Date(c.closed_at!), new Date(c.created_at)), 0) / closed.length / 24 * 10) / 10
        : null
      rows.push({
        dept,
        label: DEPARTMENT_LABELS[dept] || dept,
        total: dc.length,
        open: open.length,
        resolutionRate: dc.length > 0 ? Math.round((closed.length / dc.length) * 100) : 0,
        avgDays,
        overdue: open.filter((c) => isSLABreached(c)).length,
      })
    })
    // Rank by performance (top performer first), mirroring the staff leaderboard:
    // resolution rate 50% + on-time (non-overdue) rate 50%, then tie-breakers.
    const deptScore = (r: DeptRow) =>
      r.resolutionRate * 0.5 + (r.total > 0 ? ((r.total - r.overdue) / r.total) * 100 : 100) * 0.5
    return rows.sort((a, b) =>
      deptScore(b) - deptScore(a) ||
      b.resolutionRate - a.resolutionRate ||
      a.overdue - b.overdue ||
      b.total - a.total
    )
  }, [visibleCases])

  // ── Staff leaderboard (by reporter / resolver) ──
  const staffRows = useMemo<StaffRow[]>(() => {
    // Eligible people: HR Manager sees everyone except super_admin; regular managers see own-dept staff; admins see all
    const eligible = people.filter((p) => {
      if (p.role === 'super_admin') return false
      if (isHRManager) return true  // HR sees all staff + managers
      if (isManager && profile) return p.department === profile.department && p.role === 'staff'
      return true
    })
    const rows: StaffRow[] = eligible.map((p) => {
      const reported = visibleCases.filter((c) => c.created_by === p.id)
      // "Resolved" = cases this person actually resolved (not merely reported-and-later-closed).
      const resolved = visibleCases.filter((c) => c.resolved_by === p.id)
      const closedReported = reported.filter((c) => c.status === 'closed')
      const overdue = reported.filter((c) => isSLABreached(c)).length
      const resolutionRate = reported.length > 0 ? Math.round((closedReported.length / reported.length) * 100) : 0
      const onTime = reported.length > 0 ? Math.round(((reported.length - overdue) / reported.length) * 100) : 100
      // Lightweight leaderboard score: the two indicators we have (resolution +
      // on-time), weighted by the configured STAFF weights, normalized over just
      // those two. Falls back to 50/50 if both weights are zero. The full,
      // multi-indicator model (incl. PMS/RR) lives on the detail page — per-person
      // PMS/RR data is too heavy to fetch for the whole leaderboard here.
      const wRes = cfg.staff.resolution
      const wOn = cfg.staff.ontime
      const wSum = wRes + wOn
      const score = reported.length === 0
        ? 0
        : wSum > 0
          ? Math.round((resolutionRate * wRes + onTime * wOn) / wSum)
          : Math.round(resolutionRate * 0.5 + onTime * 0.5)
      return {
        id: p.id,
        name: p.full_name,
        avatar_url: p.avatar_url,
        department: p.department,
        reported: reported.length,
        resolved: resolved.length,
        resolutionRate,
        overdue,
        score,
      }
    })
    return rows
      .filter((r) => r.reported > 0 || r.resolved > 0)
      .sort((a, b) => b.score - a.score || b.reported - a.reported)
  }, [people, visibleCases, isManager, profile, cfg])

  function fmtRes(h: number | null) {
    if (h === null) return '—'
    if (h < 24) return `${Math.round(h)}h`
    return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`
  }

  const RANGES: { key: RangeKey; label: string }[] = [
    { key: 'month', label: lang === 'th' ? 'เดือนนี้' : 'This Month' },
    { key: '30d', label: lang === 'th' ? '30 วัน' : 'Last 30d' },
    { key: '90d', label: lang === 'th' ? '90 วัน' : 'Last 90d' },
    { key: 'all', label: lang === 'th' ? 'ทั้งหมด' : 'All Time' },
  ]

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 md:mb-6 gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">
            {lang === 'th' ? 'ประสิทธิภาพทีม' : 'Team Performance'}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {lang === 'th' ? 'เปรียบเทียบแผนกและพนักงาน' : 'Department & individual breakdown'}
          </p>
        </div>
      </div>

      {/* Time range selector */}
      <div className="flex gap-1.5 mb-5 bg-gray-100 p-1 rounded-lg w-fit">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRangeAndSave(r.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              range === r.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Org summary KPIs */}
      <div className={`grid grid-cols-2 gap-3 mb-6 ${pmsEnabled ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        <SummaryCard icon={FolderOpen} color="blue" label={lang === 'th' ? 'เคสทั้งหมด' : 'Total Cases'} value={String(summary.total)} />
        <SummaryCard icon={CheckCircle2} color="green" label={t.dashboard.resolutionRate} value={`${summary.resolutionRate}%`} />
        <SummaryCard icon={Clock} color="purple" label={t.dashboard.avgResolution} value={fmtRes(summary.avgHours)} />
        <SummaryCard icon={AlertTriangle} color="red" label={t.dashboard.overdueSLA} value={String(summary.overdue)} danger={summary.overdue > 0} />
        {pmsEnabled && (() => {
          const todayKey = new Date().toISOString().slice(0, 10)
          const pmOverdue = pmTasks.filter(t => (t.status === 'scheduled' || t.status === 'in_progress') && t.due_date < todayKey).length
          const pmDone = pmTasks.filter(t => t.status === 'done' || t.status === 'approved').length
          const pmOpen = pmTasks.filter(t => ['scheduled', 'in_progress', 'pending_approval'].includes(t.status)).length
          const pmRate = (pmDone + pmOpen) > 0 ? Math.round((pmDone / (pmDone + pmOpen)) * 100) : 100
          return <SummaryCard icon={Wrench} color={pmOverdue > 0 ? 'red' : 'green'} label={lang === 'th' ? 'PMS (เสร็จ/เกินกำหนด)' : 'PMS done · overdue'} value={`${pmRate}% · ${pmOverdue}`} danger={pmOverdue > 0} className="col-span-2 lg:col-span-1" />
        })()}
      </div>

      {/* Department comparison */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-6">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <Building2 className="h-4 w-4 text-gray-500" />
          <h2 className="font-semibold text-gray-900">{lang === 'th' ? 'เปรียบเทียบแผนก' : 'Department Comparison'}</h2>
        </div>
        {deptRows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">{t.dashboard.noData}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.cases.dept}</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.dashboard.openCases}</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.dashboard.avgDays}</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{lang === 'th' ? 'เกิน' : 'Due'}</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{lang === 'th' ? 'อัตรา' : 'Rate'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {deptRows.map((d) => (
                  <tr key={d.dept} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-medium text-gray-900">{d.label}</td>
                    <td className="px-5 py-3 text-gray-700">{d.open}<span className="text-gray-400 text-xs ml-1">/ {d.total}</span></td>
                    <td className="px-5 py-3 text-gray-500">{d.avgDays !== null ? `${d.avgDays}d` : '—'}</td>
                    <td className="px-5 py-3">
                      {d.overdue > 0
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">{d.overdue}</span>
                        : <span className="text-gray-400 text-xs">—</span>}
                    </td>
                    <td className={`px-5 py-3 text-sm font-semibold ${d.resolutionRate === 100 ? 'text-green-600' : d.resolutionRate >= 50 ? 'text-blue-600' : 'text-orange-600'}`}>
                      {d.resolutionRate}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Staff leaderboard */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <Trophy className="h-4 w-4 text-amber-500" />
          <h2 className="font-semibold text-gray-900">{lang === 'th' ? 'อันดับพนักงาน' : 'Staff Leaderboard'}</h2>
          <span className="ml-auto text-xs text-gray-400">{staffRows.length}</span>
        </div>
        {staffRows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">{lang === 'th' ? 'ยังไม่มีข้อมูล' : 'No activity in this period'}</p>
        ) : (() => {
          const totalPages = Math.max(1, Math.ceil(staffRows.length / LEADER_PAGE_SIZE))
          const page = Math.min(leaderPage, totalPages)
          const start = (page - 1) * LEADER_PAGE_SIZE
          const paged = staffRows.slice(start, start + LEADER_PAGE_SIZE)
          return (<>
          <div className="divide-y divide-gray-50">
            {paged.map((s, idx) => {
              const i = start + idx   // global rank across pages
              return (
              <Link key={s.id} to={`/performance/${s.id}`} className="flex items-center gap-3 px-4 md:px-5 py-3 hover:bg-gray-50 transition-colors">
                {/* Rank */}
                <span className={`flex-shrink-0 w-6 text-center text-sm font-bold ${i === 0 ? 'text-amber-500' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-amber-700' : 'text-gray-300'}`}>
                  {i + 1}
                </span>
                <Avatar className="h-9 w-9 flex-shrink-0">
                  {s.avatar_url && <AvatarImage src={s.avatar_url} alt={s.name} className="object-cover" />}
                  <AvatarFallback className="text-xs">{getInitials(s.name)}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
                  <p className="text-xs text-gray-400 truncate">{DEPARTMENT_LABELS[s.department]}</p>
                </div>
                {/* Metrics */}
                <div className="hidden sm:flex items-center gap-5 text-center flex-shrink-0">
                  <Metric label={lang === 'th' ? 'รายงาน' : 'Reported'} value={s.reported} />
                  <Metric label={lang === 'th' ? 'แก้ไข' : 'Resolved'} value={s.resolved} />
                  <Metric label={t.dashboard.overdue} value={s.overdue} danger={s.overdue > 0} />
                </div>
                {/* Score */}
                <div className="flex-shrink-0 w-14 text-right">
                  <p className={`text-base font-bold ${s.score >= 80 ? 'text-green-600' : s.score >= 60 ? 'text-blue-600' : s.score >= 40 ? 'text-amber-600' : 'text-red-500'}`}>{s.score}</p>
                  <p className="text-[10px] text-gray-400">{lang === 'th' ? 'คะแนน' : 'score'}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-gray-300 flex-shrink-0" />
              </Link>
            )})}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 px-4 md:px-5 py-3 border-t border-gray-100">
              <p className="text-xs text-gray-500">
                {lang === 'th'
                  ? `แสดง ${start + 1}–${Math.min(start + LEADER_PAGE_SIZE, staffRows.length)} จาก ${staffRows.length}`
                  : `Showing ${start + 1}–${Math.min(start + LEADER_PAGE_SIZE, staffRows.length)} of ${staffRows.length}`}
              </p>
              <div className="flex items-center gap-2">
                <button onClick={() => setLeaderPage(page - 1)} disabled={page === 1}
                  className="inline-flex items-center gap-1 h-8 px-3 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:pointer-events-none">
                  <ChevronLeft className="h-4 w-4" />{lang === 'th' ? 'ก่อนหน้า' : 'Previous'}
                </button>
                <span className="text-sm text-gray-600">{lang === 'th' ? `หน้า ${page} จาก ${totalPages}` : `Page ${page} of ${totalPages}`}</span>
                <button onClick={() => setLeaderPage(page + 1)} disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 h-8 px-3 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:pointer-events-none">
                  {lang === 'th' ? 'ถัดไป' : 'Next'}<ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
          </>)
        })()}
      </div>
    </div>
  )
}

function SummaryCard({ icon: Icon, color, label, value, danger, className }: {
  icon: typeof FolderOpen; color: 'blue' | 'green' | 'purple' | 'red'; label: string; value: string; danger?: boolean; className?: string
}) {
  const bg = { blue: 'bg-blue-50', green: 'bg-green-50', purple: 'bg-purple-50', red: 'bg-red-50' }[color]
  const fg = { blue: 'text-blue-600', green: 'text-green-600', purple: 'text-purple-600', red: 'text-red-600' }[color]
  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-4 shadow-sm ${className ?? ''}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <div className={`w-6 h-6 rounded-md ${bg} flex items-center justify-center flex-shrink-0`}>
          <Icon className={`h-3.5 w-3.5 ${fg}`} />
        </div>
        <p className="text-xs font-medium text-gray-500 truncate">{label}</p>
      </div>
      <p className={`text-2xl font-bold ${danger ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
    </div>
  )
}

function RateBar({ rate }: { rate: number }) {
  const color = rate === 100 ? '#22c55e' : rate >= 50 ? '#3b82f6' : '#f97316'
  const textColor = rate === 100 ? 'text-green-600' : rate >= 50 ? 'text-blue-600' : 'text-orange-600'
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className="h-2 rounded-full transition-all" style={{ width: `${rate}%`, backgroundColor: color }} />
      </div>
      <span className={`text-xs font-semibold w-9 text-right ${textColor}`}>{rate}%</span>
    </div>
  )
}

function Metric({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="w-12">
      <p className={`text-sm font-bold ${danger ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
      <p className="text-[10px] text-gray-400 truncate">{label}</p>
    </div>
  )
}
