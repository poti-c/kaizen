import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Wrench, Plus, Loader2, X, Check, Trash2, Pencil, MapPin, Search, Ban } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { DEPARTMENT_LABELS, type Department } from '@/types'
import { FREQUENCIES, freqLabel, addInterval, assetStatus, STATUS_META, type FreqUnit, type AssetStatus } from '@/lib/pm'
import { PMTaskModal, taskTone, type PMTask } from '@/components/pm/PMSchedule'

const STATUS_KEY: Record<AssetStatus, 'good' | 'dueSoon' | 'overdue' | 'notScheduled' | 'inactiveStatus'> = {
  good: 'good', due_soon: 'dueSoon', overdue: 'overdue', unscheduled: 'notScheduled', inactive: 'inactiveStatus',
}
import { toast } from 'sonner'

interface EqType { id: string; name: string; category: string | null; is_active: boolean }
interface Asset {
  id: string; company_id: string; name: string; type_id: string | null
  location: string | null; serial_no: string | null; model: string | null
  department: string | null; pic_id: string | null
  freq_unit: FreqUnit; freq_interval: number; checklist: string[]
  purchase_date: string | null
  last_maintenance_date: string | null; next_maintenance_date: string | null
  est_minutes: number | null; notes: string | null; is_active: boolean
  type?: { name: string; category: string | null } | null
}

const STATUS_ORDER: AssetStatus[] = ['overdue', 'due_soon', 'good', 'unscheduled']

export function PreventiveMaintenancePage() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { t: tr } = useLanguage()
  const statusLabel = (s: AssetStatus) => tr.pm[STATUS_KEY[s]]
  const companyId = activeCompany?.id ?? null
  const canManage = profile?.role === 'super_admin' || profile?.role === 'manager'

  const [assets, setAssets] = useState<Asset[]>([])
  const [types, setTypes] = useState<EqType[]>([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<Asset | 'new' | null>(null)
  const [q, setQ] = useState('')
  const [searchParams] = useSearchParams()
  const initialStatus = searchParams.get('status')
  const validStatuses: AssetStatus[] = ['good', 'due_soon', 'overdue', 'unscheduled', 'inactive']
  const [filter, setFilter] = useState<AssetStatus | 'all'>(
    initialStatus && validStatuses.includes(initialStatus as AssetStatus) ? (initialStatus as AssetStatus) : 'all'
  )
  // Which task-activity tile is selected (mutually exclusive with the asset filter).
  const [taskView, setTaskView] = useState<'duethisweek' | 'awaiting' | 'done' | null>(null)
  const [dueSoonDays, setDueSoonDays] = useState(7)
  const [typeFilter, setTypeFilter] = useState('all')
  const [locFilter, setLocFilter] = useState('all')
  const [deptFilter, setDeptFilter] = useState('all')
  const [inactiveOnly, setInactiveOnly] = useState(false)
  const [pageSize, setPageSize] = useState<number | 'all'>(10)
  const [page, setPage] = useState(1)
  const [pmTasks, setPmTasks] = useState<PMTask[]>([])
  const [pmDoneTasks, setPmDoneTasks] = useState<PMTask[]>([])
  const [openTask, setOpenTask] = useState<PMTask | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try { await supabase.rpc('kaizen_pm_sync') } catch { /* materialize tasks; ignore if it fails */ }
    const taskSel = '*, asset:kaizen_pm_assets(name, location, notes, checklist, department, type:kaizen_pm_equipment_types(name))'
    const monthStartKey = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
    const [a, t, s, openT, doneT] = await Promise.all([
      supabase.from('kaizen_pm_assets').select('*, type:kaizen_pm_equipment_types(name, category)').eq('company_id', companyId).order('next_maintenance_date', { ascending: true, nullsFirst: false }),
      supabase.from('kaizen_pm_equipment_types').select('id, name, category, is_active').eq('company_id', companyId).eq('is_active', true).order('category').order('name'),
      supabase.from('kaizen_pm_settings').select('due_soon_days').eq('company_id', companyId).maybeSingle(),
      supabase.from('kaizen_pm_tasks').select(taskSel).eq('company_id', companyId).in('status', ['scheduled', 'in_progress', 'pending_approval']),
      supabase.from('kaizen_pm_tasks').select(taskSel).eq('company_id', companyId).in('status', ['done', 'approved']).gte('performed_at', monthStartKey),
    ])
    if (a.error) toast.error(a.error.message)
    setAssets((a.data as Asset[]) ?? [])
    setTypes((t.data as EqType[]) ?? [])
    if (s.data?.due_soon_days != null) setDueSoonDays(s.data.due_soon_days)
    setPmTasks((openT.data as unknown as PMTask[]) ?? [])
    setPmDoneTasks((doneT.data as unknown as PMTask[]) ?? [])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const counts = assets.reduce((acc, a) => {
    const s = assetStatus(a.next_maintenance_date, a.is_active, dueSoonDays)
    acc[s] = (acc[s] ?? 0) + 1
    return acc
  }, {} as Record<AssetStatus, number>)

  // Task activity breakdown (search-aware) — mirrors the dashboard PM summary
  const todayKey = new Date().toISOString().slice(0, 10)
  const weekKey = new Date(Date.now() + dueSoonDays * 86400000).toISOString().slice(0, 10)
  const monthPrefix = todayKey.slice(0, 7)
  const taskMatch = (tk: PMTask) => !q || `${tk.asset?.name ?? ''} ${tk.asset?.location ?? ''} ${tk.asset?.type?.name ?? ''}`.toLowerCase().includes(q.toLowerCase())
  const dueThisWeekTasks = pmTasks.filter(tk => (tk.status === 'scheduled' || tk.status === 'in_progress') && tk.due_date >= todayKey && tk.due_date <= weekKey && taskMatch(tk))
  const awaitingTasks = pmTasks.filter(tk => tk.status === 'pending_approval' && taskMatch(tk))
  const doneThisMonthTasks = pmDoneTasks.filter(tk => tk.performed_at && tk.performed_at.slice(0, 7) === monthPrefix && taskMatch(tk))

  // Distinct option lists for the filter dropdowns.
  const typeOptions = Array.from(new Set(assets.map(a => a.type?.name).filter(Boolean) as string[])).sort()
  const locOptions = Array.from(new Set(assets.map(a => a.location).filter(Boolean) as string[])).sort()
  const deptOptions = Array.from(new Set(assets.map(a => a.department).filter(Boolean) as string[])).sort()

  const filtered = assets.filter((a) => {
    if (filter !== 'all' && assetStatus(a.next_maintenance_date, a.is_active, dueSoonDays) !== filter) return false
    if (inactiveOnly && a.is_active) return false
    if (typeFilter !== 'all' && a.type?.name !== typeFilter) return false
    if (locFilter !== 'all' && a.location !== locFilter) return false
    if (deptFilter !== 'all' && a.department !== deptFilter) return false
    if (q) {
      const hay = `${a.name} ${a.serial_no ?? ''} ${a.model ?? ''} ${a.notes ?? ''} ${a.location ?? ''} ${a.type?.name ?? ''} ${DEPARTMENT_LABELS[a.department as Department] ?? a.department ?? ''}`.toLowerCase()
      if (!hay.includes(q.toLowerCase())) return false
    }
    return true
  })

  // Pagination (10 / 15 / 20 / All)
  const totalPages = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageClamped = Math.min(page, totalPages)
  const paginated = pageSize === 'all' ? filtered : filtered.slice((pageClamped - 1) * pageSize, pageClamped * pageSize)
  const changePageSize = (v: number | 'all') => { setPageSize(v); setPage(1) }
  useEffect(() => { setPage(1) }, [q, typeFilter, locFilter, deptFilter, inactiveOnly, filter])

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-[var(--brand-primary)]" />
          <h1 className="text-lg font-bold text-gray-900">{tr.pm.scheduler}</h1>
        </div>
        {canManage && (
          <button onClick={() => setEditor('new')} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-2 rounded-lg">
            <Plus className="h-4 w-4" />{tr.pm.addAsset}
          </button>
        )}
      </div>

      {/* Summary — asset health (filters the list) + task activity (scrolls to its list below) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-4">
        {STATUS_ORDER.map((s) => (
          <button key={s} onClick={() => { setFilter(filter === s ? 'all' : s); setTaskView(null) }}
            className={`rounded-xl border p-3 text-left transition-colors ${filter === s && taskView === null ? 'ring-2 ring-[var(--brand-primary)]/40' : ''} ${STATUS_META[s].pill}`}>
            <p className="text-lg font-bold leading-none">{counts[s] ?? 0}</p>
            <p className="text-[11px] mt-1">{statusLabel(s)}</p>
          </button>
        ))}
        <button onClick={() => { setTaskView(taskView === 'duethisweek' ? null : 'duethisweek'); setFilter('all') }}
          className={`rounded-xl border p-3 text-left hover:brightness-95 transition-all border-gray-200 bg-gray-50 text-gray-700 ${taskView === 'duethisweek' ? 'ring-2 ring-[var(--brand-primary)]/40' : ''}`}>
          <p className="text-lg font-bold leading-none">{dueThisWeekTasks.length}</p>
          <p className="text-[11px] mt-1">{tr.pm.dueThisWeek}</p>
        </button>
        <button onClick={() => { setTaskView(taskView === 'awaiting' ? null : 'awaiting'); setFilter('all') }}
          className={`rounded-xl border p-3 text-left hover:brightness-95 transition-all ${awaitingTasks.length > 0 ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-gray-200 bg-gray-50 text-gray-700'} ${taskView === 'awaiting' ? 'ring-2 ring-[var(--brand-primary)]/40' : ''}`}>
          <p className="text-lg font-bold leading-none">{awaitingTasks.length}</p>
          <p className="text-[11px] mt-1">{tr.pm.awaitingApproval}</p>
        </button>
        <button onClick={() => { setTaskView(taskView === 'done' ? null : 'done'); setFilter('all') }}
          className={`rounded-xl border p-3 text-left hover:brightness-95 transition-all border-gray-200 bg-gray-50 text-gray-700 ${taskView === 'done' ? 'ring-2 ring-[var(--brand-primary)]/40' : ''}`}>
          <p className="text-lg font-bold leading-none">{doneThisMonthTasks.length}</p>
          <p className="text-[11px] mt-1">{tr.pm.doneThisMonth}</p>
        </button>
      </div>

      {taskView === null && (<>
      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr.pm.searchAssets}
          className="w-full h-9 rounded-lg border border-gray-300 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40" />
      </div>

      {/* Filters — single line on every screen size; dropdowns flex to fit width */}
      <div className="flex items-center gap-1.5 sm:gap-2 mb-3">
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="flex-1 min-w-0 h-8 rounded-lg border border-gray-300 bg-white px-1.5 sm:px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
          <option value="all">All Equipment</option>
          {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={locFilter} onChange={(e) => setLocFilter(e.target.value)} className="flex-1 min-w-0 h-8 rounded-lg border border-gray-300 bg-white px-1.5 sm:px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
          <option value="all">All Area</option>
          {locOptions.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="flex-1 min-w-0 h-8 rounded-lg border border-gray-300 bg-white px-1.5 sm:px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
          <option value="all">All Departments</option>
          {deptOptions.map(d => <option key={d} value={d}>{DEPARTMENT_LABELS[d as Department] ?? d}</option>)}
        </select>
        <button onClick={() => setInactiveOnly(v => !v)}
          className={`flex-shrink-0 h-8 px-2 rounded-lg border text-xs font-medium transition-colors flex items-center gap-1 ${inactiveOnly ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
          <Ban className="h-3.5 w-3.5" /><span className="hidden sm:inline">Inactive</span>
        </button>
        {(typeFilter !== 'all' || locFilter !== 'all' || deptFilter !== 'all' || inactiveOnly) && (
          <button onClick={() => { setTypeFilter('all'); setLocFilter('all'); setDeptFilter('all'); setInactiveOnly(false) }}
            className="flex-shrink-0 h-8 px-1.5 text-xs text-[var(--brand-primary)] hover:underline" title="Clear filters">Clear</button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <Wrench className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">{assets.length === 0 ? tr.pm.noAssets : tr.pm.noAssetsFiltered}</p>
          {canManage && assets.length === 0 && <button onClick={() => setEditor('new')} className="mt-3 text-sm text-[var(--brand-primary)] font-medium">{tr.pm.registerFirst}</button>}
        </div>
      ) : (
        <div className="space-y-2">
          {paginated.map((a) => {
            const s = assetStatus(a.next_maintenance_date, a.is_active, dueSoonDays)
            const m = STATUS_META[s]
            return (
              <button key={a.id} onClick={() => canManage && setEditor(a)} className="w-full flex items-center gap-3 bg-white border border-gray-200 rounded-xl p-3 text-left hover:border-gray-300 transition-colors">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${m.dot}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-gray-900 truncate">{a.name}</p>
                    {a.type?.name && <span className="text-[11px] text-gray-500">{a.type.name}</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${m.pill}`}>{statusLabel(s)}</span>
                  </div>
                  <p className="text-[11px] text-gray-500 truncate flex items-center gap-2 mt-0.5">
                    {a.location && <span className="flex items-center gap-0.5"><MapPin className="h-3 w-3" />{a.location}</span>}
                    <span>{freqLabel(a.freq_unit, a.freq_interval)}</span>
                    {a.next_maintenance_date && <span>· {tr.pm.next} {fmt(a.next_maintenance_date)}</span>}
                  </p>
                </div>
                {canManage && <Pencil className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
              </button>
            )
          })}

          {filtered.length > 10 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-2">
              <p className="text-xs text-gray-500">
                {pageSize === 'all' ? `Showing all ${filtered.length}` : `Showing ${(pageClamped - 1) * pageSize + 1}–${Math.min(pageClamped * pageSize, filtered.length)} of ${filtered.length}`} assets
              </p>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={pageSize === 'all' || pageClamped === 1}
                  className="h-7 px-2 rounded-md border border-gray-300 text-xs text-gray-600 disabled:opacity-40 hover:border-gray-400">Previous</button>
                <span className="text-xs text-gray-600">{pageSize === 'all' ? 'All' : `Page ${pageClamped} of ${totalPages}`}</span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={pageSize === 'all' || pageClamped >= totalPages}
                  className="h-7 px-2 rounded-md border border-gray-300 text-xs text-gray-600 disabled:opacity-40 hover:border-gray-400">{pageSize === 'all' ? 'Next' : `Next ${pageSize}`}</button>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span>Display</span>
                {([10, 15, 20, 'all'] as const).map(opt => (
                  <button key={String(opt)} onClick={() => changePageSize(opt)}
                    className={`h-7 px-2 rounded-md border text-xs font-medium transition-colors ${pageSize === opt ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
                    {opt === 'all' ? 'All' : opt}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      </>)}

      {/* ── Task activity lists ──
           Default (no asset filter, no task tile): show every non-empty section.
           A task tile selected: show only that section (even if empty).
           An asset tile selected: hidden (the asset list is shown instead). */}
      {!loading && (() => {
        const show = (k: 'duethisweek' | 'awaiting' | 'done', len: number) =>
          taskView === k ? true : (taskView === null && filter === 'all' && len > 0)
        const any = show('duethisweek', dueThisWeekTasks.length) || show('awaiting', awaitingTasks.length) || show('done', doneThisMonthTasks.length)
        if (!any) return null
        return (
          <div className={`${taskView === null ? 'mt-6' : 'mt-4'} space-y-5`}>
            {show('duethisweek', dueThisWeekTasks.length) && (
              <TaskSection id="pm-duethisweek" title={tr.pm.dueThisWeek} count={dueThisWeekTasks.length} accent="text-amber-700"
                tasks={dueThisWeekTasks} onOpen={setOpenTask} />
            )}
            {show('awaiting', awaitingTasks.length) && (
              <TaskSection id="pm-awaiting" title={tr.pm.awaitingApproval} count={awaitingTasks.length} accent="text-violet-700"
                tasks={awaitingTasks} onOpen={setOpenTask} />
            )}
            {show('done', doneThisMonthTasks.length) && (
              <TaskSection id="pm-done" title={tr.pm.doneThisMonth} count={doneThisMonthTasks.length} accent="text-green-700"
                tasks={doneThisMonthTasks} onOpen={setOpenTask} />
            )}
          </div>
        )
      })()}

      {openTask && <PMTaskModal task={openTask} onClose={() => setOpenTask(null)} onDone={() => { setOpenTask(null); load() }} />}

      {editor && companyId && (
        <AssetEditor companyId={companyId} types={types} asset={editor === 'new' ? null : editor}
          onClose={() => setEditor(null)} onSaved={() => { setEditor(null); load() }} />
      )}
    </div>
  )
}

function TaskSection({ id, title, count, accent, tasks, onOpen }: {
  id: string; title: string; count: number; accent: string; tasks: PMTask[]; onOpen: (t: PMTask) => void
}) {
  return (
    <div id={id} className="scroll-mt-4">
      <h2 className={`text-base font-semibold mb-3 ${accent}`}>{title}<span className="ml-2 text-sm font-normal opacity-60">{count}</span></h2>
      {tasks.length === 0 ? (
        <div className="text-center py-8 bg-white rounded-xl border border-gray-200 text-sm text-gray-400">No tasks in this category.</div>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => <PmTaskListRow key={t.id} t={t} onOpen={() => onOpen(t)} />)}
        </div>
      )}
    </div>
  )
}

function PmTaskListRow({ t, onOpen }: { t: PMTask; onOpen: () => void }) {
  const tone = taskTone(t)
  const due = fmt(t.due_date)
  return (
    <button onClick={onOpen} className="w-full flex items-center gap-3 bg-white border border-gray-200 rounded-xl p-3 text-left hover:border-gray-300 transition-colors">
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${tone.dot}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-gray-900 truncate">{t.asset?.name ?? 'Asset'}</p>
          {t.asset?.type?.name && <span className="text-[11px] text-gray-500">{t.asset.type.name}</span>}
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${tone.chip}`}>{tone.label}</span>
        </div>
        <p className="text-[11px] text-gray-500 truncate flex items-center gap-2 mt-0.5">
          {t.asset?.location && <span className="flex items-center gap-0.5"><MapPin className="h-3 w-3" />{t.asset.location}</span>}
          <span>· due {due}</span>
        </p>
      </div>
      <Pencil className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
    </button>
  )
}

function fmt(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40'

function AssetEditor({ companyId, types, asset, onClose, onSaved }: {
  companyId: string; types: EqType[]; asset: Asset | null; onClose: () => void; onSaved: () => void
}) {
  const { t: tr } = useLanguage()
  const freqIdx0 = asset ? FREQUENCIES.findIndex((f) => f.unit === asset.freq_unit && f.interval === asset.freq_interval) : 3
  const [f, setF] = useState({
    name: asset?.name ?? '', type_id: asset?.type_id ?? '', location: asset?.location ?? '',
    serial_no: asset?.serial_no ?? '', model: asset?.model ?? '', department: asset?.department ?? '',
    freqMode: (freqIdx0 >= 0 ? String(freqIdx0) : 'custom') as string,
    customDays: freqIdx0 < 0 && asset ? asset.freq_interval : 30,
    purchase_date: asset?.purchase_date ?? '',
    last_maintenance_date: asset?.last_maintenance_date ?? '',
    next_maintenance_date: asset?.next_maintenance_date ?? '',
    est_minutes: asset?.est_minutes ?? '', checklist: (asset?.checklist ?? []).join('\n'),
    notes: asset?.notes ?? '', is_active: asset?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }))

  function freqParts(): { unit: FreqUnit; interval: number } {
    if (f.freqMode === 'custom') return { unit: 'day', interval: Math.max(1, Number(f.customDays) || 1) }
    const fr = FREQUENCIES[Number(f.freqMode)]
    return { unit: fr.unit, interval: fr.interval }
  }
  // Auto-fill next from last + frequency.
  function recalcNext(lastVal: string, mode: string, custom: number) {
    if (!lastVal) return
    const parts = mode === 'custom' ? { unit: 'day' as FreqUnit, interval: Math.max(1, custom || 1) } : { unit: FREQUENCIES[Number(mode)].unit, interval: FREQUENCIES[Number(mode)].interval }
    set({ next_maintenance_date: addInterval(lastVal, parts.unit, parts.interval) })
  }

  async function save() {
    if (!f.name.trim()) { toast.error(tr.pm.assetNameRequired); return }
    setBusy(true)
    const { unit, interval } = freqParts()
    const row = {
      company_id: companyId, name: f.name.trim(), type_id: f.type_id || null,
      location: f.location.trim() || null, serial_no: f.serial_no.trim() || null, model: f.model.trim() || null,
      department: f.department || null, freq_unit: unit, freq_interval: interval,
      checklist: f.checklist.split('\n').map((s) => s.trim()).filter(Boolean),
      purchase_date: f.purchase_date || null,
      last_maintenance_date: f.last_maintenance_date || null,
      next_maintenance_date: f.next_maintenance_date || null,
      est_minutes: f.est_minutes === '' ? null : Number(f.est_minutes),
      notes: f.notes.trim() || null, is_active: f.is_active, updated_at: new Date().toISOString(),
    }
    const res = asset
      ? await supabase.from('kaizen_pm_assets').update(row).eq('id', asset.id)
      : await supabase.from('kaizen_pm_assets').insert(row)
    setBusy(false)
    if (res.error) toast.error(res.error.message)
    else { toast.success(asset ? tr.pm.assetSaved : tr.pm.assetAdded); onSaved() }
  }
  async function remove() {
    if (!asset || !confirm(`${tr.pm.confirmDeleteAsset}`)) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_pm_assets').delete().eq('id', asset.id)
    setBusy(false)
    if (error) toast.error(error.message); else onSaved()
  }

  const cats = [...new Set(types.map((t) => t.category ?? 'Other'))]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">{asset ? tr.pm.editAsset : tr.pm.registerAsset}</h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <Field label={`${tr.pm.assetName} *`}><input value={f.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder={tr.pm.assetNamePh} autoFocus /></Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.pm.equipmentType}>
              <select value={f.type_id} onChange={(e) => set({ type_id: e.target.value })} className={inputCls}>
                <option value="">{tr.pm.selectType}</option>
                {cats.map((c) => (
                  <optgroup key={c} label={c}>
                    {types.filter((t) => (t.category ?? 'Other') === c).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label={tr.pm.location}><input value={f.location} onChange={(e) => set({ location: e.target.value })} className={inputCls} placeholder={tr.pm.locationPh} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.pm.serialNo}><input value={f.serial_no} onChange={(e) => set({ serial_no: e.target.value })} className={inputCls} /></Field>
            <Field label={tr.pm.model}><input value={f.model} onChange={(e) => set({ model: e.target.value })} className={inputCls} /></Field>
          </div>
          <Field label={tr.pm.purchaseDate}><input type="date" value={f.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} className={inputCls} /></Field>
          <Field label={tr.pm.responsibleDept}>
            <select value={f.department} onChange={(e) => set({ department: e.target.value })} className={inputCls}>
              <option value="">{tr.pm.none}</option>
              {(Object.keys(DEPARTMENT_LABELS) as Department[]).map((d) => <option key={d} value={d}>{DEPARTMENT_LABELS[d]}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.pm.frequency}>
              <select value={f.freqMode} onChange={(e) => { set({ freqMode: e.target.value }); recalcNext(f.last_maintenance_date, e.target.value, f.customDays) }} className={inputCls}>
                {FREQUENCIES.map((fr, i) => <option key={fr.label} value={String(i)}>{fr.label}</option>)}
                <option value="custom">{tr.pm.customEvery}</option>
              </select>
            </Field>
            {f.freqMode === 'custom' ? (
              <Field label={tr.pm.everyNDays}><input value={f.customDays} onChange={(e) => { const v = Number(e.target.value.replace(/[^0-9]/g, '')) || 1; set({ customDays: v }); recalcNext(f.last_maintenance_date, 'custom', v) }} className={inputCls} inputMode="numeric" /></Field>
            ) : <Field label={tr.pm.estMinutes}><input value={f.est_minutes} onChange={(e) => set({ est_minutes: e.target.value.replace(/[^0-9]/g, '') })} className={inputCls} inputMode="numeric" placeholder={tr.pm.optional} /></Field>}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.pm.lastMaint}><input type="date" value={f.last_maintenance_date} onChange={(e) => { set({ last_maintenance_date: e.target.value }); recalcNext(e.target.value, f.freqMode, f.customDays) }} className={inputCls} /></Field>
            <Field label={tr.pm.nextMaint}><input type="date" value={f.next_maintenance_date} onChange={(e) => set({ next_maintenance_date: e.target.value })} className={inputCls} /></Field>
          </div>
          <Field label={tr.pm.checklist}><textarea value={f.checklist} onChange={(e) => set({ checklist: e.target.value })} rows={4} className={inputCls + ' h-auto py-2 resize-none'} placeholder={tr.pm.checklistPh} /></Field>
          <Field label={tr.pm.notesInstr}><textarea value={f.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} className={inputCls + ' h-auto py-2 resize-none'} /></Field>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set({ is_active: e.target.checked })} className="accent-[var(--brand-primary)]" />{tr.pm.activeInclude}
          </label>
        </div>
        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200">
          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{asset ? tr.pm.save : tr.pm.register}
          </button>
          <button onClick={onClose} className="px-3 h-9 rounded-lg text-gray-500 hover:bg-gray-100 text-sm">{tr.pm.cancel}</button>
          {asset && <button onClick={remove} disabled={busy} className="ml-auto flex items-center gap-1.5 px-3 h-9 rounded-lg text-red-500 hover:bg-red-50 text-sm"><Trash2 className="h-4 w-4" />{tr.pm.delete}</button>}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-gray-500">{label}</label>{children}</div>
}
