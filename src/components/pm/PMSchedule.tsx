import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronLeft, ChevronRight, Loader2, X, Check, Play, MapPin, Wrench, ThumbsUp, Undo2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { toast } from 'sonner'

export interface PMTask {
  id: string; company_id: string; asset_id: string; due_date: string; status: string
  performed_at: string | null; checklist_results: { item: string; result: string }[]
  findings: string | null; readings: string | null; parts_used: string | null; notes: string | null
  asset?: { name: string; location: string | null; notes: string | null; checklist: string[]; department: string | null; type?: { name: string } | null } | null
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function dayKey(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function fmt(d: string) { return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) }

export function taskTone(t: PMTask): { chip: string; dot: string; label: string } {
  if (t.status === 'done' || t.status === 'approved') return { chip: 'bg-green-100 text-green-700 border-green-200', dot: 'bg-green-500', label: 'Done' }
  if (t.status === 'pending_approval') return { chip: 'bg-violet-100 text-violet-700 border-violet-200', dot: 'bg-violet-500', label: 'Awaiting approval' }
  const overdue = t.due_date < dayKey(new Date())
  if (overdue) return { chip: 'bg-red-100 text-red-700 border-red-200', dot: 'bg-red-500', label: 'Overdue' }
  if (t.status === 'in_progress') return { chip: 'bg-amber-100 text-amber-700 border-amber-200', dot: 'bg-amber-500', label: 'In progress' }
  return { chip: 'bg-sky-100 text-sky-700 border-sky-200', dot: 'bg-sky-500', label: 'Scheduled' }
}

export function PMSchedule() {
  const { activeCompany } = useCompany()
  const companyId = activeCompany?.id ?? null
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [tasks, setTasks] = useState<PMTask[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<PMTask | null>(null)

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const start = new Date(first); start.setDate(first.getDate() - first.getDay())
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
  }, [cursor])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    await supabase.rpc('kaizen_pm_sync') // materialize tasks, escalate overdue, send reminders
    const from = dayKey(cells[0]); const to = dayKey(cells[cells.length - 1])
    const { data, error } = await supabase
      .from('kaizen_pm_tasks')
      .select('*, asset:kaizen_pm_assets(name, location, notes, checklist, department, type:kaizen_pm_equipment_types(name))')
      .eq('company_id', companyId).neq('status', 'cancelled')
      .gte('due_date', from).lte('due_date', to)
    if (error) toast.error(error.message)
    setTasks((data as PMTask[]) ?? [])
    setLoading(false)
  }, [companyId, cells])
  useEffect(() => { load() }, [load])

  const byDay = useMemo(() => {
    const m = new Map<string, PMTask[]>()
    for (const t of tasks) { if (!m.has(t.due_date)) m.set(t.due_date, []); m.get(t.due_date)!.push(t) }
    return m
  }, [tasks])

  const todayKey = dayKey(new Date())
  const monthTitle = cursor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold text-gray-900">{monthTitle}</h3>
        <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-0.5">
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)) }} className="px-2.5 h-7 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">Today</button>
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
            {WEEKDAYS.map((w) => <div key={w} className="py-2 text-center text-[11px] font-semibold text-gray-400">{w}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((d, i) => {
              const key = dayKey(d)
              const inMonth = d.getMonth() === cursor.getMonth()
              const isToday = key === todayKey
              const items = byDay.get(key) ?? []
              return (
                <div key={i} className={`min-h-[96px] border-b border-r border-gray-100 p-1.5 ${i % 7 === 6 ? 'border-r-0' : ''} ${inMonth ? '' : 'bg-gray-50/60'}`}>
                  <div className="flex justify-end">
                    <span className={`text-[11px] w-5 h-5 flex items-center justify-center rounded-full ${isToday ? 'bg-[var(--brand-primary)] text-white font-bold' : inMonth ? 'text-gray-600' : 'text-gray-300'}`}>{d.getDate()}</span>
                  </div>
                  <div className="space-y-1 mt-0.5">
                    {items.slice(0, 3).map((t) => {
                      const tone = taskTone(t)
                      return (
                        <button key={t.id} onClick={() => setOpen(t)} title={t.asset?.name}
                          className={`w-full flex items-center gap-1 text-[10px] leading-tight px-1.5 py-0.5 rounded border text-left truncate ${tone.chip}`}>
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tone.dot}`} />
                          <span className="truncate">{t.asset?.name ?? 'Asset'}</span>
                        </button>
                      )
                    })}
                    {items.length > 3 && <button onClick={() => setOpen(items[3])} className="text-[10px] text-gray-400 hover:text-gray-700 px-1.5">+{items.length - 3} more</button>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {open && <PMTaskModal task={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load() }} />}
    </div>
  )
}

export function PMTaskModal({ task, onClose, onDone }: { task: PMTask; onClose: () => void; onDone: () => void }) {
  const { profile } = useAuth()
  const items = task.asset?.checklist ?? []
  const pending = task.status === 'pending_approval'
  const finished = task.status === 'done' || task.status === 'approved'
  const recorded = finished || pending // execution already captured
  // Approver = Top Management, or the responsible department's manager.
  const isApprover = profile?.role === 'super_admin' || (profile?.role === 'manager' && profile?.department === task.asset?.department)
  const [results, setResults] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    if (recorded) for (const r of task.checklist_results ?? []) init[r.item] = r.result
    return init
  })
  const [findings, setFindings] = useState(task.findings ?? '')
  const [readings, setReadings] = useState(task.readings ?? '')
  const [parts, setParts] = useState(task.parts_used ?? '')
  const [busy, setBusy] = useState(false)

  async function approve() {
    setBusy(true)
    const { error } = await supabase.rpc('kaizen_pm_approve_task', { p_task: task.id })
    setBusy(false)
    if (error) toast.error(error.message); else { toast.success('Maintenance approved'); onDone() }
  }
  async function reject() {
    const note = prompt('Reason for returning this task to the technician?') ?? ''
    setBusy(true)
    const { error } = await supabase.rpc('kaizen_pm_reject_task', { p_task: task.id, p_note: note || null })
    setBusy(false)
    if (error) toast.error(error.message); else { toast.success('Returned to technician'); onDone() }
  }

  async function start() {
    setBusy(true)
    const { error } = await supabase.from('kaizen_pm_tasks').update({ status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', task.id)
    setBusy(false)
    if (error) toast.error(error.message); else onDone()
  }
  async function complete() {
    setBusy(true)
    const checklist = items.map((it) => ({ item: it, result: results[it] ?? 'na' }))
    const { error } = await supabase.rpc('kaizen_pm_complete_task', {
      p_task: task.id, p_checklist: checklist, p_findings: findings || null, p_readings: readings || null, p_parts: parts || null,
    })
    setBusy(false)
    if (error) toast.error(error.message)
    else { toast.success('Maintenance recorded'); onDone() }
  }

  const tone = taskTone(task)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2"><Wrench className="h-5 w-5 text-[var(--brand-primary)]" /><h3 className="font-semibold text-gray-900">{task.asset?.name ?? 'Maintenance'}</h3></div>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto text-sm">
          <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500">
            <span className={`px-1.5 py-0.5 rounded-full border ${tone.chip}`}>{tone.label}</span>
            {task.asset?.type?.name && <span>{task.asset.type.name}</span>}
            <span>· Due {fmt(task.due_date)}</span>
          </div>
          {task.asset?.location && <p className="text-xs text-gray-600 flex items-center gap-1"><MapPin className="h-3 w-3" />{task.asset.location}</p>}
          {task.asset?.notes && <p className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2">{task.asset.notes}</p>}

          {items.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">Checklist</p>
              <div className="space-y-1.5">
                {items.map((it) => (
                  <div key={it} className="flex items-center gap-2">
                    <span className="flex-1 text-sm text-gray-800">{it}</span>
                    {recorded ? (
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${results[it] === 'pass' ? 'bg-green-100 text-green-700' : results[it] === 'fail' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>{(results[it] ?? 'na').toUpperCase()}</span>
                    ) : (
                      <div className="flex gap-1">
                        {(['pass', 'fail', 'na'] as const).map((r) => (
                          <button key={r} onClick={() => setResults((p) => ({ ...p, [it]: r }))}
                            className={`text-[10px] px-1.5 py-0.5 rounded border ${results[it] === r ? (r === 'pass' ? 'bg-green-500 text-white border-green-500' : r === 'fail' ? 'bg-red-500 text-white border-red-500' : 'bg-gray-400 text-white border-gray-400') : 'border-gray-300 text-gray-500'}`}>{r.toUpperCase()}</button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {recorded ? (
            <div className="space-y-1.5 text-xs text-gray-600">
              {task.readings && <p><span className="font-medium">Readings:</span> {task.readings}</p>}
              {task.parts_used && <p><span className="font-medium">Parts:</span> {task.parts_used}</p>}
              {task.findings && <p><span className="font-medium">Findings:</span> {task.findings}</p>}
              {task.performed_at && <p className="text-gray-400">Performed {new Date(task.performed_at).toLocaleString()}</p>}
              {pending && <p className="text-violet-600 font-medium">Awaiting approval{!isApprover ? ' by the responsible manager / Top Management' : ''}.</p>}
            </div>
          ) : (
            <>
              <Field label="Readings / measurements"><input value={readings} onChange={(e) => setReadings(e.target.value)} className={inp} placeholder="e.g. 12°C, 220V" /></Field>
              <Field label="Parts / consumables used"><input value={parts} onChange={(e) => setParts(e.target.value)} className={inp} /></Field>
              <Field label="Findings / notes"><textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={2} className={inp + ' h-auto py-2 resize-none'} /></Field>
            </>
          )}
        </div>
        {pending && isApprover ? (
          <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200">
            <button onClick={reject} disabled={busy} className="flex items-center gap-1.5 px-3 h-9 rounded-lg text-red-600 hover:bg-red-50 text-sm font-medium"><Undo2 className="h-4 w-4" />Return</button>
            <button onClick={approve} disabled={busy} className="ml-auto flex items-center gap-1.5 px-4 h-9 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-semibold disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}Approve
            </button>
          </div>
        ) : !recorded ? (
          <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200">
            {task.status === 'scheduled' && <button onClick={start} disabled={busy} className="flex items-center gap-1.5 px-3 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium"><Play className="h-4 w-4" />Start</button>}
            <button onClick={complete} disabled={busy} className="ml-auto flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Complete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const inp = 'w-full h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40'
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-gray-500">{label}</label>{children}</div>
}
