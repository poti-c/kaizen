import { useState, useEffect, useMemo, useCallback } from 'react'
import { X, Printer, Loader2, FileBarChart, ArrowUp, ArrowDown, Minus, AlertTriangle, CheckCircle2, TrendingUp, Users, CalendarClock, ClipboardList } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { DEPARTMENT_LABELS, type Department } from '@/types'
import { bangkokDate } from '@/lib/utils'

// ── Types for the data we query ──────────────────────────────────────────────
interface RTask {
  id: string; status: string; due_date: string; performed_at: string | null
  performed_by: string | null; asset_id: string | null
  checklist_results: { item: string; result: string }[] | null
  approved_at: string | null
  asset?: { name: string; location: string | null; department: string | null; type?: { name: string; category: string | null } | null } | null
}
interface RAsset {
  id: string; name: string; location: string | null; department: string | null
  is_active: boolean; last_maintenance_date: string | null; next_maintenance_date: string | null
  type?: { name: string; category: string | null } | null
}

// ── Date helpers (Asia/Bangkok, YYYY-MM-DD) ──────────────────────────────────
// Use the hotel's fixed timezone (matches PMSummaryCard, which uses bangkokDate) so
// the on-time/compliance/overdue day boundaries are stable for every viewer — the
// browser-local keyOf understated compliance for off-TZ viewers and during the
// 00:00–07:00 Bangkok window.
const keyOf = bangkokDate
const perfKey = (ts: string) => bangkokDate(new Date(ts))
const todayKey = bangkokDate()
function addMonths(base: Date, m: number) { const d = new Date(base); d.setMonth(d.getMonth() + m); return d }
function diffDays(a: string, b: string) {
  return Math.round((new Date(a + 'T00:00:00').getTime() - new Date(b + 'T00:00:00').getTime()) / 86400000)
}
const FINISHED = new Set(['done', 'approved'])
const OPEN_OVERDUE_EXCLUDED = new Set(['done', 'approved', 'cancelled'])

function isFail(r: string) { const v = String(r).toLowerCase(); return v === 'fail' || v === 'failed' || v === 'false' }
function isPass(r: string) { const v = String(r).toLowerCase(); return v === 'pass' || v === 'passed' || v === 'ok' || v === 'true' }

// A metric computed over a trailing window ending at an anchor date.
interface Metric { compliancePct: number; due: number; onTime: number; overdue: number; fails: number }
function computeMetric(tasks: RTask[], windowStartKey: string, anchorKey: string): Metric {
  let due = 0, onTime = 0, overdue = 0, fails = 0
  for (const t of tasks) {
    const dueInWindow = t.due_date >= windowStartKey && t.due_date <= anchorKey
    if (dueInWindow) {
      due++
      if (FINISHED.has(t.status) && t.performed_at && perfKey(t.performed_at) <= t.due_date) onTime++
      if (!OPEN_OVERDUE_EXCLUDED.has(t.status) && t.due_date < anchorKey) overdue++
    }
    // checklist fails for tasks performed within the window
    if (t.performed_at && perfKey(t.performed_at) >= windowStartKey && perfKey(t.performed_at) <= anchorKey) {
      if ((t.checklist_results ?? []).some(r => isFail(r.result))) fails++
    }
  }
  return { compliancePct: due ? Math.round((onTime / due) * 100) : 0, due, onTime, overdue, fails }
}

type Period = 30 | 90 | 180 | 365

export function PMReport({ companyName, onClose }: { companyName: string; onClose: () => void }) {
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const r = t.pmReport
  const companyId = activeCompany?.id ?? null
  const [period, setPeriod] = useState<Period>(90)
  const [loading, setLoading] = useState(true)
  const [tasks, setTasks] = useState<RTask[]>([])
  const [assets, setAssets] = useState<RAsset[]>([])
  const [techNames, setTechNames] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [tRes, aRes, pRes] = await Promise.all([
      supabase.from('kaizen_pm_tasks')
        .select('id, status, due_date, performed_at, performed_by, asset_id, checklist_results, approved_at, asset:kaizen_pm_assets(name, location, department, type:kaizen_pm_equipment_types(name, category))')
        .eq('company_id', companyId),
      supabase.from('kaizen_pm_assets')
        .select('id, name, location, department, is_active, last_maintenance_date, next_maintenance_date, type:kaizen_pm_equipment_types(name, category)')
        .eq('company_id', companyId),
      supabase.from('kaizen_profiles').select('id, full_name').eq('company_id', companyId),
    ])
    setTasks((tRes.data as unknown as RTask[]) ?? [])
    setAssets((aRes.data as unknown as RAsset[]) ?? [])
    const names: Record<string, string> = {}
    for (const p of (pRes.data as { id: string; full_name: string }[] ?? [])) names[p.id] = p.full_name
    setTechNames(names)
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  // ── All aggregations in one memo ───────────────────────────────────────────
  const data = useMemo(() => {
    const now = new Date()
    // `period` is a day count (30/90/180/365). Subtract days directly — the old
    // addMonths(-(period/30)) truncated the fractional month, so 365 became an
    // exact 12-month window instead of 365 days.
    const periodStartKey = keyOf(new Date(now.getTime() - period * 86400000))

    // Current period headline
    const cur = computeMetric(tasks, periodStartKey, todayKey)

    // vs 1M / 3M / 6M: same window length ending at each anchor in the past
    const anchors: { label: string; months: number }[] = [
      { label: r.vs1m, months: 1 }, { label: r.vs3m, months: 3 }, { label: r.vs6m, months: 6 },
    ]
    const deltas = anchors.map(a => {
      const anchor = addMonths(now, -a.months)
      const anchorKey = keyOf(anchor)
      const winStart = keyOf(new Date(anchor.getTime() - period * 86400000))
      return { label: a.label, metric: computeMetric(tasks, winStart, anchorKey) }
    })

    // Overdue list (current open overdue tasks, regardless of period window)
    const overdueTasks = tasks.filter(t => !OPEN_OVERDUE_EXCLUDED.has(t.status) && t.due_date < todayKey)
    const overdueRows = overdueTasks.map(t => {
      const late = diffDays(todayKey, t.due_date)
      const everPerformed = tasks.some(o => o.asset_id === t.asset_id && o.performed_at)
      return {
        id: t.id, name: t.asset?.name ?? '—', dept: t.asset?.department ?? null,
        days: late, reason: everPerformed ? 'missed' as const : 'never' as const,
      }
    }).sort((a, b) => b.days - a.days)

    // Checklist fail tasks (within period, performed)
    const periodPerformed = tasks.filter(t => t.performed_at && perfKey(t.performed_at) >= periodStartKey && perfKey(t.performed_at) <= todayKey)
    let passItems = 0, failItems = 0, naItems = 0, tasksWithFail = 0
    for (const t of periodPerformed) {
      let hasFail = false
      for (const c of (t.checklist_results ?? [])) {
        if (isFail(c.result)) { failItems++; hasFail = true }
        else if (isPass(c.result)) passItems++
        else naItems++
      }
      if (hasFail) tasksWithFail++
    }

    // Top problem assets: overdue count + checklist fails + avg delay (within period)
    const perAsset: Record<string, { name: string; type: string | null; loc: string | null; overdue: number; fails: number; delaySum: number; delayN: number }> = {}
    const ensure = (id: string, t?: RTask) => {
      if (!perAsset[id]) perAsset[id] = { name: t?.asset?.name ?? '—', type: t?.asset?.type?.name ?? null, loc: t?.asset?.location ?? null, overdue: 0, fails: 0, delaySum: 0, delayN: 0 }
      return perAsset[id]
    }
    for (const t of overdueTasks) if (t.asset_id) ensure(t.asset_id, t).overdue++
    for (const t of periodPerformed) {
      if (!t.asset_id) continue
      const a = ensure(t.asset_id, t)
      if ((t.checklist_results ?? []).some(c => isFail(c.result))) a.fails++
      if (t.performed_at) { const d = diffDays(perfKey(t.performed_at), t.due_date); if (d > 0) { a.delaySum += d; a.delayN++ } }
    }
    const problemAssets = Object.values(perAsset)
      .map(a => ({ ...a, avgDelay: a.delayN ? a.delaySum / a.delayN : 0, score: a.overdue * 2 + a.fails * 1.5 + (a.delayN ? a.delaySum / a.delayN : 0) * 0.3 }))
      .filter(a => a.score > 0)
      .sort((a, b) => b.score - a.score).slice(0, 8)

    // By category & by department compliance (within period)
    const groupCompliance = (keyFn: (t: RTask) => string | null) => {
      const g: Record<string, { due: number; onTime: number }> = {}
      for (const t of tasks) {
        if (!(t.due_date >= periodStartKey && t.due_date <= todayKey)) continue
        const k = keyFn(t) ?? '—'
        g[k] ??= { due: 0, onTime: 0 }
        g[k].due++
        if (FINISHED.has(t.status) && t.performed_at && perfKey(t.performed_at) <= t.due_date) g[k].onTime++
      }
      return Object.entries(g).map(([k, v]) => ({ key: k, pct: v.due ? Math.round((v.onTime / v.due) * 100) : 0, due: v.due }))
        .sort((a, b) => a.pct - b.pct)
    }
    const byCategory = groupCompliance(t => t.asset?.type?.category ?? t.asset?.type?.name ?? null)
    const byDepartment = groupCompliance(t => t.asset?.department ?? null)

    // Extra insights
    const in7 = new Date(); in7.setDate(in7.getDate() + 7); const in7Key = keyOf(in7)
    const in30 = new Date(); in30.setDate(in30.getDate() + 30); const in30Key = keyOf(in30)
    const dueThisWeek = tasks.filter(t => !OPEN_OVERDUE_EXCLUDED.has(t.status) && t.due_date >= todayKey && t.due_date <= in7Key).length
    const forecast30 = tasks.filter(t => !OPEN_OVERDUE_EXCLUDED.has(t.status) && t.due_date >= todayKey && t.due_date <= in30Key).length
    const neverMaintained = assets.filter(a => a.is_active && !a.last_maintenance_date).length

    const avgDaysLate = (() => {
      let sum = 0, n = 0
      for (const t of periodPerformed) if (t.performed_at) { const d = diffDays(perfKey(t.performed_at), t.due_date); if (d > 0) { sum += d; n++ } }
      return n ? Math.round(sum / n) : 0
    })()

    // Approval backlog
    const pendingApproval = tasks.filter(t => t.status === 'pending_approval').length
    const approvalWaits = tasks.filter(t => t.approved_at && t.performed_at)
      .map(t => diffDays(perfKey(t.approved_at!), perfKey(t.performed_at!))).filter(d => d >= 0)
    const avgApprovalWait = approvalWaits.length ? Math.round(approvalWaits.reduce((a, b) => a + b, 0) / approvalWaits.length) : 0

    // Completion by technician (within period)
    const byTechMap: Record<string, number> = {}
    for (const t of periodPerformed) { const k = t.performed_by ?? '__none'; byTechMap[k] = (byTechMap[k] ?? 0) + 1 }
    const byTech = Object.entries(byTechMap).map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n).slice(0, 6)

    return {
      cur, deltas, overdueRows, passItems, failItems, naItems, tasksWithFail,
      problemAssets, byCategory, byDepartment, dueThisWeek, forecast30, neverMaintained,
      avgDaysLate, pendingApproval, avgApprovalWait, byTech,
      totalPerformed: periodPerformed.length,
    }
  }, [tasks, assets, period, r])

  const periodLabel: Record<Period, string> = { 30: r.last30, 90: r.last90, 180: r.last180, 365: r.last365 }
  const today = new Date().toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  const deptLabel = (d: string) => DEPARTMENT_LABELS[d as Department] ?? d

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm print:bg-white print:static print:overflow-visible">
      <style>{`@media print {
        body * { visibility: hidden !important; }
        .pm-report, .pm-report * { visibility: visible !important; }
        .pm-report { position: absolute !important; left: 0; top: 0; width: 100%; box-shadow: none !important; margin: 0 !important; }
        .no-print { display: none !important; }
        @page { size: A4; margin: 12mm; }
        .pm-card { break-inside: avoid; }
      }`}</style>

      {/* Toolbar */}
      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-3 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2 text-gray-900 text-sm font-semibold min-w-0">
          <FileBarChart className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
          <span className="truncate">{r.title}</span>
        </div>
        <div className="flex items-center gap-2">
          <select value={period} onChange={e => setPeriod(Number(e.target.value) as Period)}
            className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
            {([30, 90, 180, 365] as Period[]).map(p => <option key={p} value={p}>{periodLabel[p]}</option>)}
          </select>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-3 h-8 rounded-lg">
            <Printer className="h-4 w-4" />{r.printSave}
          </button>
          <button onClick={onClose} title={r.close} className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-24"><Loader2 className="h-7 w-7 animate-spin text-gray-400" /></div>
      ) : (
        <div className="flex justify-center py-6 print:py-0">
          <div className="pm-report bg-white w-[210mm] max-w-full p-6 sm:p-8 shadow-2xl print:shadow-none">
            {/* 1. Header */}
            <header className="flex items-start justify-between gap-4 border-b border-gray-200 pb-4 mb-5">
              <div>
                <h1 className="text-xl font-bold text-gray-900">{r.title}</h1>
                <p className="text-sm text-gray-500">{r.subtitle}</p>
                <p className="text-sm font-semibold text-gray-700 mt-1">{companyName}</p>
              </div>
              <div className="text-right text-xs text-gray-500">
                <p>{r.dateOfReport}: <span className="font-semibold text-gray-700">{today}</span></p>
                <p className="mt-0.5">{r.period}: <span className="font-semibold text-gray-700">{periodLabel[period]}</span></p>
              </div>
            </header>

            {/* 2 + 3 + 4: compliance ring, overdue, checklist fails */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              {/* Compliance */}
              <Card className="flex flex-col items-center text-center">
                <CardTitle icon={<TrendingUp className="h-3.5 w-3.5" />}>{r.compliance}</CardTitle>
                <Ring pct={data.cur.compliancePct} />
                <p className="text-xs text-gray-500 mt-2">{data.cur.onTime}/{data.cur.due} {r.onTimeDone}</p>
                <DeltaRow deltas={data.deltas.map(d => ({ label: d.label, cur: data.cur.compliancePct, prev: d.metric.compliancePct, suffix: '%' }))} />
              </Card>

              {/* Overdue */}
              <Card>
                <CardTitle icon={<AlertTriangle className="h-3.5 w-3.5 text-red-500" />}>{r.overdue}</CardTitle>
                <p className="text-3xl font-bold text-red-600 leading-none">{data.overdueRows.length}</p>
                <p className="text-xs text-gray-500">{r.overdueTasks}</p>
                <DeltaRow invert deltas={data.deltas.map(d => ({ label: d.label, cur: data.overdueRows.length, prev: d.metric.overdue, suffix: '' }))} />
                <div className="mt-2 space-y-1 max-h-32 overflow-y-auto print:overflow-visible print:max-h-none">
                  {data.overdueRows.length === 0 ? (
                    <p className="text-[11px] text-green-600">{r.noOverdue}</p>
                  ) : data.overdueRows.slice(0, 6).map(o => (
                    <div key={o.id} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate text-gray-700">{o.name}{o.dept ? ` · ${deptLabel(o.dept)}` : ''}</span>
                      <span className="flex-shrink-0 text-red-600 font-medium">
                        {o.reason === 'never' ? r.neverPerformed : `${o.days}${r.daysOverdue}`}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Checklist fails */}
              <Card className="flex flex-col items-center text-center">
                <CardTitle icon={<ClipboardList className="h-3.5 w-3.5 text-amber-500" />}>{r.checklistFails}</CardTitle>
                <Donut pass={data.passItems} fail={data.failItems} na={data.naItems} />
                <p className="text-xs text-gray-500 mt-1">{data.tasksWithFail} {r.tasksWithFail}</p>
                <div className="flex items-center gap-2.5 mt-1.5 text-[10px]">
                  <Legend color="#22c55e" label={`${r.passItems} ${data.passItems}`} />
                  <Legend color="#ef4444" label={`${r.failItems} ${data.failItems}`} />
                  <Legend color="#d1d5db" label={`${r.naItems} ${data.naItems}`} />
                </div>
                <DeltaRow invert deltas={data.deltas.map(d => ({ label: d.label, cur: data.tasksWithFail, prev: d.metric.fails, suffix: '' }))} />
              </Card>
            </div>

            {/* 7: insight strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <Stat icon={<CalendarClock className="h-4 w-4 text-sky-500" />} value={data.dueThisWeek} label={r.dueThisWeek} />
              <Stat icon={<CalendarClock className="h-4 w-4 text-indigo-500" />} value={data.forecast30} label={r.forecast} />
              <Stat icon={<AlertTriangle className="h-4 w-4 text-orange-500" />} value={data.neverMaintained} label={r.neverMaintained} />
              <Stat icon={<TrendingUp className="h-4 w-4 text-rose-500" />} value={`${data.avgDaysLate} ${r.days}`} label={r.avgDaysLate} />
              <Stat icon={<ClipboardList className="h-4 w-4 text-violet-500" />} value={data.pendingApproval} label={r.approvalBacklog} />
              <Stat icon={<CheckCircle2 className="h-4 w-4 text-teal-500" />} value={`${data.avgApprovalWait} ${r.days}`} label={r.avgApprovalWait} />
              <Stat icon={<CheckCircle2 className="h-4 w-4 text-green-500" />} value={data.totalPerformed} label={r.completed} />
              <Stat icon={<AlertTriangle className="h-4 w-4 text-red-500" />} value={data.overdueRows.length} label={r.overdue} />
            </div>

            {/* 5: Top problem assets */}
            <Card className="mb-3">
              <CardTitle icon={<AlertTriangle className="h-3.5 w-3.5 text-red-500" />}>{r.topProblems}</CardTitle>
              <p className="text-[11px] text-gray-400 mb-2">{r.problemsHelp}</p>
              {data.problemAssets.length === 0 ? (
                <p className="text-xs text-gray-400">{r.noTasks}</p>
              ) : (
                <BarList items={data.problemAssets.map(a => ({
                  label: a.name, sub: [a.type, a.loc].filter(Boolean).join(' · ') || undefined, value: Math.round(a.score),
                  note: `${a.overdue} ${r.overdue.toLowerCase()} · ${a.fails} ${r.failItems.toLowerCase()} · ${Math.round(a.avgDelay)}${r.daysOverdue}`,
                }))} color="#ef4444" />
              )}
            </Card>

            {/* 6: By category + By department */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <Card>
                <CardTitle icon={<TrendingUp className="h-3.5 w-3.5" />}>{r.byCategory}</CardTitle>
                <GroupBars rows={data.byCategory} weakestLabel={r.weakest} emptyLabel={r.noData} />
              </Card>
              <Card>
                <CardTitle icon={<TrendingUp className="h-3.5 w-3.5" />}>{r.byDepartment}</CardTitle>
                <GroupBars rows={data.byDepartment.map(x => ({ ...x, key: x.key === '—' ? '—' : deptLabel(x.key) }))} weakestLabel={r.weakest} emptyLabel={r.noData} />
              </Card>
            </div>

            {/* Completion by technician */}
            <Card>
              <CardTitle icon={<Users className="h-3.5 w-3.5 text-teal-500" />}>{r.byTechnician}</CardTitle>
              {data.byTech.length === 0 ? (
                <p className="text-xs text-gray-400">{r.noTasks}</p>
              ) : (
                <BarList items={data.byTech.map(tch => ({
                  label: tch.id === '__none' ? r.unassigned : (techNames[tch.id] ?? r.technician),
                  value: tch.n, note: `${tch.n} ${r.completed}`,
                }))} color="#14b8a6" />
              )}
            </Card>

            <p className="text-[10px] text-gray-400 mt-5 text-center print:mt-3">{companyName} · {r.title} · {today}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Small infographic primitives ─────────────────────────────────────────────
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`pm-card rounded-xl border border-gray-200 bg-white p-3 ${className}`}>{children}</div>
}
function CardTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return <h2 className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">{icon}{children}</h2>
}
function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1 text-gray-500"><span className="w-2 h-2 rounded-full" style={{ background: color }} />{label}</span>
}
function Stat({ icon, value, label }: { icon: React.ReactNode; value: number | string; label: string }) {
  return (
    <div className="pm-card rounded-xl border border-gray-200 bg-white p-3">
      <div className="flex items-center gap-1.5 mb-1">{icon}</div>
      <p className="text-xl font-bold text-gray-900 leading-none">{value}</p>
      <p className="text-[11px] text-gray-500 mt-1 leading-tight">{label}</p>
    </div>
  )
}

// Progress ring (donut) for a single percentage.
function Ring({ pct }: { pct: number }) {
  const size = 92, stroke = 9, rad = (size - stroke) / 2, circ = 2 * Math.PI * rad
  const clamped = Math.max(0, Math.min(100, pct))
  const color = clamped >= 85 ? '#22c55e' : clamped >= 60 ? '#f59e0b' : '#ef4444'
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="my-1">
      <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke="#e5e7eb" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={circ * (1 - clamped / 100)} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="font-bold" style={{ fontSize: 20, fill: '#111827' }}>{clamped}%</text>
    </svg>
  )
}

// Pass/fail/na donut.
function Donut({ pass, fail, na }: { pass: number; fail: number; na: number }) {
  const total = pass + fail + na
  const size = 84, stroke = 12, rad = (size - stroke) / 2, circ = 2 * Math.PI * rad
  if (total === 0) {
    return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="my-1"><circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke="#e5e7eb" strokeWidth={stroke} /></svg>
  }
  const segs = [{ v: pass, c: '#22c55e' }, { v: fail, c: '#ef4444' }, { v: na, c: '#d1d5db' }]
  let offset = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="my-1">
      {segs.map((s, i) => {
        const frac = s.v / total
        const dash = circ * frac
        const el = (
          <circle key={i} cx={size / 2} cy={size / 2} r={rad} fill="none" stroke={s.c} strokeWidth={stroke}
            strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )
        offset += dash
        return el
      })}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="font-bold" style={{ fontSize: 16, fill: '#111827' }}>{total}</text>
    </svg>
  )
}

// vs 1M / 3M / 6M delta row.
function DeltaRow({ deltas, invert = false }: { deltas: { label: string; cur: number; prev: number; suffix: string }[]; invert?: boolean }) {
  return (
    <div className="flex items-center justify-center gap-2.5 mt-2 pt-2 border-t border-gray-100 w-full">
      {deltas.map((d, i) => {
        const delta = Math.round(d.cur - d.prev)
        // For "good-up" metrics (compliance) higher is better; for invert metrics (overdue/fails) lower is better.
        const good = invert ? delta < 0 : delta > 0
        const bad = invert ? delta > 0 : delta < 0
        const color = delta === 0 ? 'text-gray-400' : good ? 'text-green-600' : bad ? 'text-red-600' : 'text-gray-400'
        const Icon = delta === 0 ? Minus : delta > 0 ? ArrowUp : ArrowDown
        return (
          <div key={i} className="flex flex-col items-center">
            <span className="text-[9px] text-gray-400 leading-none">{d.label}</span>
            <span className={`flex items-center gap-0.5 text-[11px] font-semibold leading-tight ${color}`}>
              <Icon className="h-2.5 w-2.5" />{Math.abs(delta)}{d.suffix}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Horizontal bar list (ranked).
function BarList({ items, color }: { items: { label: string; sub?: string; value: number; note?: string }[]; color: string }) {
  const max = Math.max(1, ...items.map(i => i.value))
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i}>
          <div className="flex items-center justify-between gap-2 text-[11px] mb-0.5">
            <span className="truncate text-gray-800 font-medium">{it.label}{it.sub ? <span className="text-gray-400 font-normal"> · {it.sub}</span> : null}</span>
            <span className="flex-shrink-0 text-gray-400">{it.note ?? it.value}</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${(it.value / max) * 100}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// Compliance % bars per group, weakest highlighted.
function GroupBars({ rows, weakestLabel, emptyLabel }: { rows: { key: string; pct: number; due: number }[]; weakestLabel: string; emptyLabel: string }) {
  if (rows.length === 0) return <p className="text-xs text-gray-400">{emptyLabel}</p>
  const weakest = rows[0]?.key
  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        const color = row.pct >= 85 ? '#22c55e' : row.pct >= 60 ? '#f59e0b' : '#ef4444'
        return (
          <div key={i}>
            <div className="flex items-center justify-between gap-2 text-[11px] mb-0.5">
              <span className="truncate text-gray-800">
                {row.key}
                {row.key === weakest && rows.length > 1 && <span className="ml-1 text-[9px] text-red-500 font-semibold uppercase">{weakestLabel}</span>}
              </span>
              <span className="flex-shrink-0 text-gray-500 font-medium">{row.pct}% <span className="text-gray-300">({row.due})</span></span>
            </div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${row.pct}%`, background: color }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
