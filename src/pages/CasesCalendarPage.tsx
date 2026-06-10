import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Wrench } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { cn, companyHasAddon } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { KaizenCase, Department } from '@/types'
import { DEPARTMENTS } from '@/types'
import { PMTaskModal, taskTone, taskStatusKey, type PMTask } from '@/components/pm/PMSchedule'

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-green-500 text-white', medium: 'bg-blue-400 text-white',
  high: 'bg-orange-500 text-white', critical: 'bg-red-500 text-white',
}
const MONTH_NAMES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTH_NAMES_TH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']
const DAY_LABELS_EN = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const DAY_LABELS_TH = ['จ','อ','พ','พฤ','ศ','ส','อา']

function isoKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

type Entry = { kind: 'case'; case: KaizenCase } | { kind: 'pm'; task: PMTask }

export function CasesCalendarPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { lang, t } = useLanguage()
  const navigate = useNavigate()
  const today = new Date()

  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [cases, setCases] = useState<KaizenCase[]>([])
  const [pmTasks, setPmTasks] = useState<PMTask[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string>(isoKey(today))
  const [deptFilter, setDeptFilter] = useState<Department | 'all'>(
    () => (localStorage.getItem('kaizen-default-dept') as Department | 'all') || 'all'
  )
  const pmEnabled = companyHasAddon(activeCompany, 'pms')
  const [searchParams] = useSearchParams()
  const initialTab = searchParams.get('tab')
  const [mode, setMode] = useState<'cases' | 'pm' | 'combined'>(
    pmEnabled && (initialTab === 'pm' || initialTab === 'combined') ? initialTab : 'cases'
  )
  const [openTask, setOpenTask] = useState<PMTask | null>(null)

  const MONTH_NAMES = lang === 'th' ? MONTH_NAMES_TH : MONTH_NAMES_EN
  const DAY_LABELS = lang === 'th' ? DAY_LABELS_TH : DAY_LABELS_EN
  const showPmData = pmEnabled && (mode === 'pm' || mode === 'combined')
  const showCaseData = mode === 'cases' || mode === 'combined'

  useEffect(() => {
    if (profile && activeCompany) fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, activeCompany, viewMonth, viewYear, mode])

  async function fetchData() {
    if (!activeCompany) return
    setLoading(true)
    const start = new Date(viewYear, viewMonth, 1)
    const end = new Date(viewYear, viewMonth + 1, 0, 23, 59, 59)
    const jobs: PromiseLike<unknown>[] = []

    if (showCaseData) {
      let q = supabase.from('kaizen_cases').select('*').eq('company_id', activeCompany.id)
        .gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
      if (profile?.role === 'staff' && profile.department) q = q.eq('department', profile.department)
      jobs.push(q.then(({ data }) => setCases((data || []) as KaizenCase[])))
    } else { setCases([]) }

    if (showPmData) {
      jobs.push((async () => {
        await supabase.rpc('kaizen_pm_sync')
        const from = isoKey(new Date(viewYear, viewMonth - 1, 21))
        const to = isoKey(new Date(viewYear, viewMonth + 1, 14))
        const { data } = await supabase.from('kaizen_pm_tasks')
          .select('*, asset:kaizen_pm_assets(name, location, notes, checklist, department, type:kaizen_pm_equipment_types(name))')
          .eq('company_id', activeCompany.id).neq('status', 'cancelled').gte('due_date', from).lte('due_date', to)
        setPmTasks((data as PMTask[]) ?? [])
      })())
    } else { setPmTasks([]) }

    await Promise.all(jobs)
    setLoading(false)
  }

  function prevMonth() { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) } else setViewMonth(m => m - 1) }
  function nextMonth() { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) } else setViewMonth(m => m + 1) }
  function goToday() { setViewMonth(today.getMonth()); setViewYear(today.getFullYear()); setSelectedKey(isoKey(today)) }

  const filteredCases = cases.filter(c => {
    if (profile?.role === 'staff') return true
    if (deptFilter === 'all') return true
    return c.department === deptFilter
  })

  // Monday-first grid
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay()
  const startOffset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate()
  type Cell = { date: Date; isCurrentMonth: boolean }
  const cells: Cell[] = []
  for (let i = startOffset - 1; i >= 0; i--) cells.push({ date: new Date(viewYear, viewMonth - 1, daysInPrevMonth - i), isCurrentMonth: false })
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(viewYear, viewMonth, d), isCurrentMonth: true })
  const remaining = (7 - (cells.length % 7)) % 7
  for (let d = 1; d <= remaining; d++) cells.push({ date: new Date(viewYear, viewMonth + 1, d), isCurrentMonth: false })

  // Entries by day key
  const byDay: Record<string, Entry[]> = {}
  if (showCaseData) filteredCases.forEach(c => {
    const k = isoKey(new Date(c.created_at)); (byDay[k] ||= []).push({ kind: 'case', case: c })
  })
  if (showPmData) pmTasks.forEach(tk => { (byDay[tk.due_date] ||= []).push({ kind: 'pm', task: tk }) })

  function isToday(date: Date) {
    return date.getDate() === today.getDate() && date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear()
  }
  function caseColor(c: KaizenCase) {
    if (c.status === 'closed') return 'bg-gray-200 text-gray-500'
    return PRIORITY_COLORS[c.priority] || 'bg-gray-400 text-white'
  }

  const showDeptFilter = (profile?.role === 'super_admin' || profile?.role === 'manager') && showCaseData
  const selectedDate = selectedKey ? new Date(selectedKey + 'T00:00:00') : null
  const selectedEntries = byDay[selectedKey] ?? []

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="mb-4 space-y-3">
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t.nav.calendar}</h1>
        {pmEnabled && (
          <div className="flex gap-1 border-b border-gray-200 flex-wrap">
            {([['cases', t.nav.cases], ['pm', t.nav.maintenance], ['combined', t.calendar.combined]] as const).map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${mode === m ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Controls: department (left) · month (centre) · prev/Today/next (right) */}
        <div className="flex items-center gap-2">
          {showDeptFilter ? (
            <Select value={deptFilter} onValueChange={(v) => setDeptFilter(v as Department | 'all')}>
              <SelectTrigger className="h-8 w-32 text-[11px] whitespace-nowrap flex-shrink-0"><SelectValue placeholder={t.calendar.allDepts} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t.calendar.allDepts}</SelectItem>
                {DEPARTMENTS.filter(d => d.value !== 'top_management').map((d) => (
                  <SelectItem key={d.value} value={d.value} className="text-xs">{d.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : <div className="w-32 flex-shrink-0" />}
          <span className="flex-1 text-center text-base font-semibold text-gray-900 whitespace-nowrap">{MONTH_NAMES[viewMonth]} {viewYear}</span>
          <div className="flex items-center gap-0.5 h-8 bg-white border border-gray-200 rounded-lg px-0.5 flex-shrink-0">
            <button onClick={prevMonth} title={lang === 'th' ? 'เดือนก่อนหน้า' : 'Previous month'} className="p-1 rounded-md hover:bg-gray-100"><ChevronLeft className="h-4 w-4 text-gray-600" /></button>
            <button onClick={goToday} className="px-2.5 h-6 text-xs font-medium text-gray-700 hover:bg-gray-100 rounded-md">{t.calendar.today}</button>
            <button onClick={nextMonth} title={lang === 'th' ? 'เดือนถัดไป' : 'Next month'} className="p-1 rounded-md hover:bg-gray-100"><ChevronRight className="h-4 w-4 text-gray-600" /></button>
          </div>
        </div>
      </div>

      {/* Calendar */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
          {DAY_LABELS.map((d, i) => (
            <div key={d} className={`py-2 text-[11px] font-semibold uppercase tracking-wider text-center ${i >= 5 ? 'text-blue-400' : 'text-gray-500'}`}>{d}</div>
          ))}
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-24"><div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-7 divide-x divide-y divide-gray-100">
            {cells.map((cell, i) => {
              const key = isoKey(cell.date)
              const entries = byDay[key] || []
              const today_ = isToday(cell.date)
              const selected = key === selectedKey
              const isWeekend = i % 7 >= 5
              return (
                <div key={i} onClick={() => setSelectedKey(key)}
                  className={cn('min-h-[78px] md:min-h-[104px] p-1 md:p-1.5 cursor-pointer transition-colors',
                    selected ? 'bg-[var(--brand-primary)]/5' : !cell.isCurrentMonth ? 'bg-gray-50/70' : isWeekend ? 'bg-blue-50/20' : 'bg-white hover:bg-gray-50')}>
                  <div className="flex justify-end mb-1">
                    <span className={cn('text-xs w-6 h-6 flex items-center justify-center rounded-full leading-none',
                      today_ ? 'bg-[var(--brand-primary)] text-white font-bold'
                      : selected ? 'border border-[var(--brand-primary)] text-[var(--brand-primary)] font-semibold'
                      : cell.isCurrentMonth ? (isWeekend ? 'text-blue-500' : 'text-gray-700') : 'text-gray-300')}>
                      {cell.date.getDate()}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {entries.slice(0, 3).map((e, idx) => e.kind === 'case' ? (
                      <button key={'c' + e.case.id} onClick={(ev) => { ev.stopPropagation(); navigate(`/cases/${e.case.id}`) }}
                        className={`w-full text-left px-1.5 py-0.5 rounded text-[10px] font-medium truncate block leading-4 ${caseColor(e.case)} hover:opacity-75`}
                        title={`${e.case.case_number} · ${e.case.title}`}>{e.case.case_number}</button>
                    ) : (
                      <button key={'p' + e.task.id} onClick={(ev) => { ev.stopPropagation(); setOpenTask(e.task) }}
                        className={`w-full text-left px-1.5 py-0.5 rounded border text-[10px] font-medium truncate flex items-center gap-1 leading-4 ${taskTone(e.task).chip}`}
                        title={e.task.asset?.name}><Wrench className="h-2.5 w-2.5 flex-shrink-0" /><span className="truncate">{e.task.asset?.name ?? 'Asset'}</span></button>
                    ))}
                    {entries.length > 3 && <p className="text-[10px] text-gray-400 pl-1 leading-4">+{entries.length - 3} {t.calendar.more}</p>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Inline selected-day list (iPhone-style) */}
      {selectedDate && (
        <div className="mt-4 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">{selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3>
          </div>
          {selectedEntries.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-400">{mode === 'pm' ? t.calendar.noMaintenance : t.calendar.nothingDay}</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {selectedEntries.map((e) => e.kind === 'case' ? (
                <div key={'c' + e.case.id} onClick={() => navigate(`/cases/${e.case.id}`)} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer">
                  <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', caseColor(e.case).split(' ')[0])} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{e.case.title}</p>
                    <p className="text-xs text-gray-400">{e.case.case_number} · {e.case.department}</p>
                  </div>
                </div>
              ) : (
                <button key={'p' + e.task.id} onClick={() => setOpenTask(e.task)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left">
                  <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', taskTone(e.task).dot)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5"><Wrench className="h-3 w-3 text-gray-400" />{e.task.asset?.name ?? 'Maintenance'}</p>
                    <p className="text-xs text-gray-400">{t.pm[taskStatusKey(e.task)]}{e.task.asset?.location ? ` · ${e.task.asset.location}` : ''}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Legend — Case priority and PM status split by a divider */}
      <div className="mt-3 space-y-2">
        {showCaseData && (
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xs text-gray-400 font-medium">{t.calendar.casePriority}</span>
            <Legend color="bg-green-500" label={t.priority.low} />
            <Legend color="bg-blue-400" label={t.priority.medium} />
            <Legend color="bg-orange-500" label={t.priority.high} />
            <Legend color="bg-red-500" label={t.priority.critical} />
            <Legend color="bg-gray-200 border border-gray-300" label={t.status.closed} />
          </div>
        )}
        {showPmData && (
          <div className={`flex items-center gap-4 flex-wrap ${showCaseData ? 'border-t border-gray-200 pt-2' : ''}`}>
            <span className="text-xs text-gray-400 font-medium">{t.calendar.pmStatus}</span>
            <Legend color="bg-sky-500" label={t.pm.scheduled} />
            <Legend color="bg-amber-500" label={t.pm.inProgress} />
            <Legend color="bg-violet-500" label={t.pm.awaitingApproval} />
            <Legend color="bg-red-500" label={t.pm.overdue} />
            <Legend color="bg-green-500" label={t.pm.done} />
          </div>
        )}
      </div>

      {openTask && <PMTaskModal task={openTask} onClose={() => setOpenTask(null)} onDone={() => { setOpenTask(null); fetchData() }} />}
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return <div className="flex items-center gap-1.5"><div className={`w-3 h-2.5 rounded-sm ${color}`} /><span className="text-xs text-gray-500">{label}</span></div>
}
