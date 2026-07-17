import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronLeft, ChevronRight, Loader2, X, Check, Play, MapPin, Wrench, ThumbsUp, Undo2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'
import { getEffectiveDepts } from '@/types'
import { bangkokDate, bangkokDayOfWeek, parseDateOnlyBkk } from '@/lib/utils'
import { assetDepartments } from '@/lib/pm'

export interface PMTask {
  id: string; company_id: string; asset_id: string; due_date: string; status: string
  created_at?: string | null
  started_at?: string | null; started_by?: string | null
  performed_at: string | null; performed_by?: string | null
  approved_at?: string | null; approver_id?: string | null
  checklist_results: { item: string; result: string }[]
  findings: string | null; readings: string | null; parts_used: string | null; notes: string | null
  asset?: { name: string; location: string | null; notes: string | null; checklist: string[]; department: string | null; departments?: string[] | null; type?: { name: string } | null } | null
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
function dayKey(d: Date) { return bangkokDate(d) }
function fmt(d: string) { return new Date(d + 'T00:00:00+07:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }) }
function fmtTs(ts: string, lang: string) { return new Date(ts).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) }

export function taskTone(t: PMTask): { chip: string; dot: string; label: string } {
  if (t.status === 'done' || t.status === 'approved') return { chip: 'bg-green-100 text-green-700 border-green-200', dot: 'bg-green-500', label: 'Done' }
  if (t.status === 'pending_approval') return { chip: 'bg-violet-100 text-violet-700 border-violet-200', dot: 'bg-violet-500', label: 'Awaiting approval' }
  const overdue = t.due_date < dayKey(new Date())
  if (overdue) return { chip: 'bg-red-100 text-red-700 border-red-200', dot: 'bg-red-500', label: 'Overdue' }
  if (t.status === 'in_progress') return { chip: 'bg-amber-100 text-amber-700 border-amber-200', dot: 'bg-amber-500', label: 'In progress' }
  return { chip: 'bg-sky-100 text-sky-700 border-sky-200', dot: 'bg-sky-500', label: 'Scheduled' }
}

// i18n key for a task's display status (use with t.pm[...]).
export function taskStatusKey(t: PMTask): 'done' | 'awaitingApproval' | 'overdue' | 'inProgress' | 'scheduled' {
  if (t.status === 'done' || t.status === 'approved') return 'done'
  if (t.status === 'pending_approval') return 'awaitingApproval'
  if (t.due_date < dayKey(new Date())) return 'overdue'
  if (t.status === 'in_progress') return 'inProgress'
  return 'scheduled'
}

export function PMSchedule() {
  const { activeCompany } = useCompany()
  const { lang } = useLanguage()
  const companyId = activeCompany?.id ?? null
  const [cursor, setCursor] = useState(() => { const bkk = bangkokDate(); return new Date(bkk.slice(0, 7) + '-01T12:00:00+07:00') })
  const [tasks, setTasks] = useState<PMTask[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<PMTask | null>(null)

  const cells = useMemo(() => {
    const bkkCursorStr = bangkokDate(cursor)              // 'YYYY-MM-DD'
    const firstStr = bkkCursorStr.slice(0, 7) + '-01'    // 'YYYY-MM-01'
    const first = parseDateOnlyBkk(firstStr)
    const firstDow = bangkokDayOfWeek(first)
    const start = new Date(first.getTime() - firstDow * 86400000)
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
  }, [cursor])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    await supabase.rpc('kaizen_pm_sync') // materialize tasks, escalate overdue, send reminders
    const from = dayKey(cells[0]); const to = dayKey(cells[cells.length - 1])
    const { data, error } = await supabase
      .from('kaizen_pm_tasks')
      .select('*, asset:kaizen_pm_assets(name, location, notes, checklist, department, departments, type:kaizen_pm_equipment_types(name))')
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
  const monthTitle = new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', { timeZone: 'Asia/Bangkok', month: 'long', year: 'numeric' }).format(cursor)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold text-gray-900">{monthTitle}</h3>
        <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-0.5">
          <button onClick={() => { const [cy, cm] = bangkokDate(cursor).split('-').map(Number); setCursor(parseDateOnlyBkk(`${cm === 1 ? cy-1 : cy}-${String(cm === 1 ? 12 : cm-1).padStart(2,'0')}-01`)) }} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => { const bkk = bangkokDate(); setCursor(parseDateOnlyBkk(bkk.slice(0, 7) + '-01')) }} className="px-2.5 h-7 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">{lang === 'th' ? 'วันนี้' : 'Today'}</button>
          <button onClick={() => { const [cy, cm] = bangkokDate(cursor).split('-').map(Number); setCursor(parseDateOnlyBkk(`${cm === 12 ? cy+1 : cy}-${String(cm === 12 ? 1 : cm+1).padStart(2,'0')}-01`)) }} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
            {(lang === 'th' ? WEEKDAYS_TH : WEEKDAYS).map((w) => <div key={w} className="py-2 text-center text-[11px] font-semibold text-gray-400">{w}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((d, i) => {
              const key = dayKey(d)
              const inMonth = bangkokDate(d).slice(0, 7) === bangkokDate(cursor).slice(0, 7)
              const isToday = key === todayKey
              const items = byDay.get(key) ?? []
              return (
                <div key={i} className={`min-h-[96px] border-b border-r border-gray-100 p-1.5 ${i % 7 === 6 ? 'border-r-0' : ''} ${inMonth ? '' : 'bg-gray-50/60'}`}>
                  <div className="flex justify-end">
                    <span className={`text-[11px] w-5 h-5 flex items-center justify-center rounded-full ${isToday ? 'bg-[var(--brand-primary)] text-white font-bold' : inMonth ? 'text-gray-600' : 'text-gray-300'}`}>{parseInt(bangkokDate(d).slice(8, 10), 10)}</span>
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
                    {items.length > 3 && <button onClick={() => setOpen(items[3])} className="text-[10px] text-gray-400 hover:text-gray-700 px-1.5">{lang === 'th' ? `อีก ${items.length - 3} รายการ` : `+${items.length - 3} more`}</button>}
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
  const { t: tr, lang } = useLanguage()
  const items = task.asset?.checklist ?? []
  const pending = task.status === 'pending_approval'
  const finished = task.status === 'done' || task.status === 'approved'
  const recorded = finished || pending // execution already captured
  const [justStarted, setJustStarted] = useState(false)
  const started = task.status === 'in_progress' || justStarted // checklist/inputs unlock only after Start
  // Approver = Top Management, or the responsible department's manager.
  const assetDepts = assetDepartments(task.asset)
  const inResponsibleDept = !!profile && getEffectiveDepts(profile).some((d) => assetDepts.includes(d as string))
  const isApprover = profile?.role === 'super_admin' || (profile?.role === 'manager' && inResponsibleDept)
  const canExecute = profile?.role === 'super_admin' || profile?.role === 'manager' ||
    (profile?.role === 'staff' && inResponsibleDept)
  const [results, setResults] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    if (recorded) for (const r of task.checklist_results ?? []) init[r.item] = r.result
    return init
  })
  const [findings, setFindings] = useState(task.findings ?? '')
  const [readings, setReadings] = useState(task.readings ?? '')
  const [parts, setParts] = useState(task.parts_used ?? '')
  const [busy, setBusy] = useState(false)
  const [confirmingComplete, setConfirmingComplete] = useState(false)
  // Resolve actor ids → names for the audit timeline (started / performed / approved by).
  const [actors, setActors] = useState<Record<string, string>>({})
  useEffect(() => {
    const ids = [...new Set([task.started_by, task.performed_by, task.approver_id].filter(Boolean) as string[])]
    if (!ids.length) return
    let stale = false
    supabase.from('kaizen_profiles').select('id, full_name').in('id', ids).then(({ data }) => {
      if (stale) return
      const m: Record<string, string> = {}
      ;((data as { id: string; full_name: string }[]) ?? []).forEach((p) => { m[p.id] = p.full_name })
      setActors((prev) => ({ ...prev, ...m }))
    })
    return () => { stale = true }
  }, [task.id, task.started_by, task.performed_by, task.approver_id])
  // Readings and parts are mandatory; findings stay optional.
  const completeReady = readings.trim().length > 0 && parts.trim().length > 0

  async function approve() {
    setBusy(true)
    const { error } = await supabase.rpc('kaizen_pm_approve_task', { p_task: task.id })
    setBusy(false)
    if (error) toast.error(error.message); else { toast.success(tr.pm.approvedToast); onDone() }
  }
  async function reject() {
    const note = prompt(tr.pm.rejectPrompt) ?? ''
    setBusy(true)
    const { error } = await supabase.rpc('kaizen_pm_reject_task', { p_task: task.id, p_note: note || null })
    setBusy(false)
    if (error) toast.error(error.message); else { toast.success(tr.pm.returnedToast); onDone() }
  }

  async function start() {
    setBusy(true)
    const nowIso = new Date().toISOString()
    const { error } = await supabase.from('kaizen_pm_tasks')
      .update({ status: 'in_progress', started_at: nowIso, started_by: profile?.id ?? null, updated_at: nowIso }).eq('id', task.id)
    setBusy(false)
    // Unlock the checklist/inputs in place rather than closing — the user starts, then records.
    if (error) { toast.error(error.message); return }
    task.started_at = nowIso; task.started_by = profile?.id ?? null // reflect immediately in the timeline
    if (profile?.id && profile.full_name) setActors((p) => ({ ...p, [profile.id]: profile.full_name }))
    setJustStarted(true)
  }
  async function complete() {
    if (!completeReady) { toast.error(tr.pm.readingsPartsRequired); setConfirmingComplete(false); return }
    setBusy(true)
    const checklist = items.map((it) => ({ item: it, result: results[it] ?? 'na' }))
    const { error } = await supabase.rpc('kaizen_pm_complete_task', {
      p_task: task.id, p_checklist: checklist, p_findings: findings || null, p_readings: readings || null, p_parts: parts || null,
    })
    setBusy(false)
    if (error) toast.error(error.message)
    else { toast.success(tr.pm.recorded); onDone() }
  }

  const tone = taskTone(task)
  // If the task was started in this session, closing should refresh the parent so
  // the calendar reflects the new "in progress" state.
  const closeModal = () => { if (busy) return; justStarted ? onDone() : onClose() }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={closeModal} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2"><Wrench className="h-5 w-5 text-[var(--brand-primary)]" /><h3 className="font-semibold text-gray-900">{task.asset?.name ?? 'Maintenance'}</h3></div>
          <button onClick={closeModal} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto text-sm">
          <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500">
            <span className={`px-1.5 py-0.5 rounded-full border ${tone.chip}`}>{tr.pm[taskStatusKey(task)]}</span>
            {task.asset?.type?.name && <span>{task.asset.type.name}</span>}
            <span>· {tr.pm.next} {fmt(task.due_date)}</span>
          </div>
          {task.asset?.location && <p className="text-xs text-gray-600 flex items-center gap-1"><MapPin className="h-3 w-3" />{task.asset.location}</p>}
          {task.asset?.notes && <p className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2">{task.asset.notes}</p>}

          {items.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">{tr.pm.checklistTitle}</p>
              <div className="space-y-1.5">
                {items.map((it) => (
                  <div key={it} className="flex items-center gap-2">
                    <span className="flex-1 text-sm text-gray-800">{it}</span>
                    {recorded ? (
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${results[it] === 'pass' ? 'bg-green-100 text-green-700' : results[it] === 'fail' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>{tr.pm[(results[it] ?? 'na') as 'pass' | 'fail' | 'na']}</span>
                    ) : (
                      <div className="flex gap-1">
                        {(['pass', 'fail', 'na'] as const).map((r) => (
                          <button key={r} disabled={!started} onClick={() => setResults((p) => ({ ...p, [it]: r }))}
                            className={`text-[10px] px-1.5 py-0.5 rounded border ${!started ? 'border-gray-200 text-gray-300 cursor-not-allowed' : results[it] === r ? (r === 'pass' ? 'bg-green-500 text-white border-green-500' : r === 'fail' ? 'bg-red-500 text-white border-red-500' : 'bg-gray-400 text-white border-gray-400') : 'border-gray-300 text-gray-500'}`}>{tr.pm[r]}</button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {recorded ? (
            <div className="space-y-3">
              <div className="space-y-1.5 text-xs text-gray-600">
                {task.readings && <p><span className="font-medium">{tr.pm.readings}:</span> {task.readings}</p>}
                {task.parts_used && <p><span className="font-medium">{tr.pm.parts}:</span> {task.parts_used}</p>}
                {task.findings && <p><span className="font-medium">{tr.pm.findings}:</span> {task.findings}</p>}
              </div>
              {/* Audit timeline: Scheduled → Started → Completed → (Awaiting) → Approved */}
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-2">{tr.pm.timeline}</p>
                <ol className="space-y-3">
                  {([
                    task.created_at ? { key: 'sch', color: 'bg-sky-500', label: tr.pm.tlScheduled, who: null as string | null, at: task.created_at as string | null } : null,
                    task.started_at ? { key: 'start', color: 'bg-amber-500', label: tr.pm.tlStarted, who: task.started_by ?? null, at: task.started_at } : null,
                    task.performed_at ? { key: 'done', color: 'bg-green-500', label: tr.pm.tlCompleted, who: task.performed_by ?? null, at: task.performed_at } : null,
                    pending ? { key: 'await', color: 'bg-violet-500', label: tr.pm.awaitingNote, who: null, at: null } : null,
                    task.approved_at ? { key: 'appr', color: 'bg-green-600', label: tr.pm.tlApproved, who: task.approver_id ?? null, at: task.approved_at } : null,
                  ].filter(Boolean) as { key: string; color: string; label: string; who: string | null; at: string | null }[]).map((ev, i, arr) => (
                    <li key={ev.key} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ring-2 ring-white ${ev.color}`} />
                        {i < arr.length - 1 && <span className="w-px flex-1 bg-gray-200 mt-0.5" />}
                      </div>
                      <div className="flex-1 -mt-0.5 pb-0.5">
                        <p className="text-xs font-medium text-gray-800">{ev.label}{ev.who && actors[ev.who] ? ` · ${actors[ev.who]}` : ''}</p>
                        {ev.at && <p className="text-[11px] text-gray-400">{fmtTs(ev.at, lang)}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
                {pending && !isApprover && <p className="mt-2 text-[11px] text-violet-600">{tr.pm.awaitingNote} {tr.pm.awaitingBy}.</p>}
              </div>
            </div>
          ) : (
            <>
              {!started && <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">{tr.pm.startFirst}</p>}
              <Field label={`${tr.pm.readingsLabel} *`}><input value={readings} disabled={!started} onChange={(e) => setReadings(e.target.value)} className={inp + (started ? '' : ' bg-gray-50 text-gray-400 cursor-not-allowed')} placeholder={tr.pm.readingsPh} /></Field>
              <Field label={`${tr.pm.partsLabel} *`}><input value={parts} disabled={!started} onChange={(e) => setParts(e.target.value)} className={inp + (started ? '' : ' bg-gray-50 text-gray-400 cursor-not-allowed')} /></Field>
              <Field label={tr.pm.findingsLabel}><textarea value={findings} disabled={!started} onChange={(e) => setFindings(e.target.value)} rows={2} className={inp + ' h-auto py-2 resize-none' + (started ? '' : ' bg-gray-50 text-gray-400 cursor-not-allowed')} /></Field>
            </>
          )}
        </div>
        {pending && isApprover ? (
          <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200">
            <button onClick={reject} disabled={busy} className="flex items-center gap-1.5 px-3 h-9 rounded-lg text-red-600 hover:bg-red-50 text-sm font-medium"><Undo2 className="h-4 w-4" />{tr.pm.return}</button>
            <button onClick={approve} disabled={busy} className="ml-auto flex items-center gap-1.5 px-4 h-9 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-semibold disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}{tr.pm.approve}
            </button>
          </div>
        ) : !recorded && canExecute ? (
          <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200">
            {!started ? (
              <button onClick={start} disabled={busy} className="ml-auto flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50"><Play className="h-4 w-4" />{tr.pm.start}</button>
            ) : (
              <button onClick={() => setConfirmingComplete(true)} disabled={busy || !completeReady} title={!completeReady ? tr.pm.readingsPartsRequired : undefined} className="ml-auto flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{tr.pm.complete}
              </button>
            )}
          </div>
        ) : null}

        {/* Confirmation before recording the maintenance. */}
        {confirmingComplete && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-4 rounded-2xl bg-black/30" onClick={() => !busy && setConfirmingComplete(false)}>
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-xs p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
              <h4 className="font-semibold text-gray-900 text-sm">{tr.pm.confirmCompleteTitle}</h4>
              <p className="text-xs text-gray-500">{tr.pm.confirmCompleteMsg}</p>
              <div className="flex items-center gap-2 pt-1">
                <button onClick={() => setConfirmingComplete(false)} disabled={busy} className="flex-1 h-9 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50">{tr.pm.confirmCancel}</button>
                <button onClick={complete} disabled={busy} className="flex-1 flex items-center justify-center gap-1.5 h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{tr.pm.confirmComplete}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const inp = 'w-full h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40'
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-gray-500">{label}</label>{children}</div>
}
