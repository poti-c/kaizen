import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Wrench, ClipboardList, DoorOpen, Flag } from 'lucide-react'
import { unitOne, DEFAULT_UNIT, type UnitNoun } from '@/lib/roomUnit'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { cn, companyHasAddon, formatDueBy, bangkokDate, parseDateOnlyBkk, bangkokDayOfWeek } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { KaizenCase, Department, RrOrder } from '@/types'
import { DEPARTMENTS, deptLabel } from '@/types'
import { useDepartments } from '@/hooks/useDepartments'
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
  return bangkokDate(date)
}

type RoomOrderCal = { id: string; order_date: string; status: 'draft' | 'submitted'; submitted_by: string | null; room_statuses: Record<string, string> }
type Entry = { kind: 'case'; case: KaizenCase } | { kind: 'casedue'; case: KaizenCase } | { kind: 'pm'; task: PMTask } | { kind: 'rr'; order: RrOrder } | { kind: 'roomorder'; ro: RoomOrderCal }

// Room-order chip/dot tone by submission status.
const ROOMORDER_TONE: Record<string, { chip: string; dot: string }> = {
  draft:     { chip: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  submitted: { chip: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' },
}

// Routine-order chip/dot tones by workflow status (matches the roster page pills).
const RR_TONES: Record<string, { chip: string; dot: string }> = {
  pending:   { chip: 'bg-gray-100 text-gray-600 border-gray-200',    dot: 'bg-gray-400' },
  sent:      { chip: 'bg-sky-50 text-sky-700 border-sky-200',        dot: 'bg-sky-500' },
  accepted:  { chip: 'bg-amber-50 text-amber-700 border-amber-200',  dot: 'bg-amber-500' },
  delivered: { chip: 'bg-teal-50 text-teal-700 border-teal-200',     dot: 'bg-teal-500' },
  confirmed: { chip: 'bg-green-50 text-green-700 border-green-200',  dot: 'bg-green-500' },
}

export function CasesCalendarPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { lang, t } = useLanguage()
  const navigate = useNavigate()
  const _bkkNow = bangkokDate()
  const [_bkkYear, _bkkMM] = _bkkNow.split('-').map(Number)

  const [viewYear, setViewYear] = useState(_bkkYear)
  const [viewMonth, setViewMonth] = useState(_bkkMM - 1)
  const [cases, setCases] = useState<KaizenCase[]>([])
  const [dueCases, setDueCases] = useState<KaizenCase[]>([]) // open cases whose DUE DATE falls in this month
  const [pmTasks, setPmTasks] = useState<PMTask[]>([])
  const [rrOrders, setRrOrders] = useState<RrOrder[]>([])
  const [actorNames, setActorNames] = useState<Record<string, string>>({}) // id → full_name for order actors
  const [rrRoomOrders, setRrRoomOrders] = useState<RoomOrderCal[]>([])
  const [roomUnit, setRoomUnit] = useState<UnitNoun>(DEFAULT_UNIT)
  const [loading, setLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string>(_bkkNow)
  const [deptFilter, setDeptFilter] = useState<Department | 'all'>(
    () => (localStorage.getItem('kaizen-default-dept') as Department | 'all') || 'all'
  )
  const pmEnabled = companyHasAddon(activeCompany, 'pms')
  const rrEnabled = companyHasAddon(activeCompany, 'routine_roster')
  const [searchParams] = useSearchParams()
  const initialTab = searchParams.get('tab')
  const [mode, setMode] = useState<'cases' | 'pm' | 'rr' | 'combined'>(() => {
    if (pmEnabled && initialTab === 'pm') return 'pm'
    if (rrEnabled && initialTab === 'rr') return 'rr'
    if ((pmEnabled || rrEnabled) && initialTab === 'combined') return 'combined'
    return 'cases'
  })
  const [openTask, setOpenTask] = useState<PMTask | null>(null)
  const fetchSeqCal = useRef(0)
  const { allOptions: calDepts } = useDepartments()

  const MONTH_NAMES = lang === 'th' ? MONTH_NAMES_TH : MONTH_NAMES_EN
  const DAY_LABELS = lang === 'th' ? DAY_LABELS_TH : DAY_LABELS_EN
  const showPmData = pmEnabled && (mode === 'pm' || mode === 'combined')
  const showRrData = rrEnabled && (mode === 'rr' || mode === 'combined')
  const showCaseData = mode === 'cases' || mode === 'combined'

  useEffect(() => {
    if (!profile || !activeCompany) return
    const seq = ++fetchSeqCal.current
    void fetchData(seq)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, activeCompany, viewMonth, viewYear, mode])

  // Configurable room-order noun (Room / Hut / Resort …) for the calendar label.
  useEffect(() => {
    if (!rrEnabled || !activeCompany) return
    let stale = false
    supabase.from('kaizen_settings').select('value').eq('company_id', activeCompany.id).eq('key', 'rr_room_config').maybeSingle()
      .then(({ data }) => { const u = (data?.value as { unit?: UnitNoun } | undefined)?.unit; if (!stale && u) setRoomUnit(u) })
    return () => { stale = true }
  }, [rrEnabled, activeCompany])

  // Resolve a batch of profile ids → names and merge into actorNames (used for
  // "Confirmed by …" on routine orders and "Submitted by …" on room orders).
  async function resolveNames(ids: (string | null | undefined)[]) {
    const uniq = [...new Set(ids.filter(Boolean) as string[])]
    if (!uniq.length) return
    const { data } = await supabase.from('kaizen_profiles').select('id, full_name').in('id', uniq)
    const map: Record<string, string> = {}
    ;((data as { id: string; full_name: string }[]) ?? []).forEach(p => { map[p.id] = p.full_name })
    setActorNames(prev => ({ ...prev, ...map }))
  }

  async function fetchData(fetchSeq?: number) {
    if (!activeCompany) return
    setLoading(true)
    const start = new Date(Date.UTC(viewYear, viewMonth, 1))
    // Bangkok-aligned instant window [monthStart, nextMonthStart) for the case
    // queries below. The grid buckets each case by bangkokDate(created_at/due_date),
    // so the fetch window must use the same Bangkok day boundaries — local-TZ
    // .toISOString() edges drop/leak boundary cases on non-Bangkok clients.
    const pad2 = (n: number) => String(n).padStart(2, '0')
    const nextY = viewMonth === 11 ? viewYear + 1 : viewYear
    const nextM = viewMonth === 11 ? 0 : viewMonth + 1
    const bkkStartIso = `${viewYear}-${pad2(viewMonth + 1)}-01T00:00:00+07:00`
    const bkkEndIso = `${nextY}-${pad2(nextM + 1)}-01T00:00:00+07:00` // exclusive
    const jobs: PromiseLike<unknown>[] = []

    if (showCaseData) {
      // Staff see their own department's cases PLUS any case they are Person In Charge
      // of (which may live in another department), matching the Cases list page. Quote
      // the department so custom labels with spaces/punctuation stay literal.
      const staffScope = profile?.role === 'staff' && profile.department
        ? `department.eq."${profile.department.replace(/"/g, '\\"')}",pic_ids.cs.{${profile.id}}`
        : null
      let q = supabase.from('kaizen_cases').select('*').eq('company_id', activeCompany.id)
        .gte('created_at', bkkStartIso).lt('created_at', bkkEndIso)
      if (staffScope) q = q.or(staffScope)
      jobs.push(q.then(({ data }) => setCases((data || []) as KaizenCase[])))

      // Open cases whose DEADLINE falls in this month — plotted on the due day (may have
      // been created in an earlier month, so this is a separate query from the one above).
      let dq = supabase.from('kaizen_cases').select('*').eq('company_id', activeCompany.id)
        .not('due_date', 'is', null).neq('status', 'closed')
        .gte('due_date', bkkStartIso).lt('due_date', bkkEndIso)
      if (staffScope) dq = dq.or(staffScope)
      jobs.push(dq.then(({ data }) => setDueCases((data || []) as KaizenCase[])))
    } else { setCases([]); setDueCases([]) }

    if (showPmData) {
      jobs.push((async () => {
        await supabase.rpc('kaizen_pm_sync')
        const from = isoKey(new Date(Date.UTC(viewYear, viewMonth - 1, 21)))
        const to = isoKey(new Date(Date.UTC(viewYear, viewMonth + 1, 14)))
        const { data } = await supabase.from('kaizen_pm_tasks')
          .select('*, asset:kaizen_pm_assets(name, location, notes, checklist, department, type:kaizen_pm_equipment_types(name))')
          .eq('company_id', activeCompany.id).neq('status', 'cancelled').gte('due_date', from).lte('due_date', to)
        setPmTasks((data as PMTask[]) ?? [])
      })())
    } else { setPmTasks([]) }

    if (showRrData) {
      const monthEnd = isoKey(new Date(Date.UTC(viewYear, viewMonth + 1, 0)))
      jobs.push((async () => {
        const { data } = await supabase.from('kaizen_rr_orders')
          .select('*')
          .eq('company_id', activeCompany.id).neq('status', 'cancelled')
          .gte('order_date', isoKey(start)).lte('order_date', monthEnd)
        const list = (data as RrOrder[]) ?? []
        setRrOrders(list)
        // Resolve actor names so rows can show "Confirmed by …", "Accepted by …", etc.
        await resolveNames(list.flatMap(o => [o.sent_by, o.accepted_by, o.delivered_by, o.confirmed_by]))
      })())
      jobs.push((async () => {
        const { data } = await supabase.from('kaizen_rr_room_orders')
          .select('id, order_date, status, submitted_by, room_statuses')
          .eq('company_id', activeCompany.id)
          .gte('order_date', isoKey(start)).lte('order_date', monthEnd)
        const list = (data as RoomOrderCal[]) ?? []
        setRrRoomOrders(list)
        await resolveNames(list.map(ro => ro.submitted_by))
      })())
    } else { setRrOrders([]); setRrRoomOrders([]) }

    await Promise.all(jobs)
    if (fetchSeq != null && fetchSeq !== fetchSeqCal.current) return
    setLoading(false)
  }

  function prevMonth() { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) } else setViewMonth(m => m - 1) }
  function nextMonth() { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) } else setViewMonth(m => m + 1) }
  function goToday() { const bkk = bangkokDate(); const [y, m] = bkk.split('-').map(Number); setViewMonth(m - 1); setViewYear(y); setSelectedKey(bkk) }

  const deptOk = (c: KaizenCase) => profile?.role === 'staff' || deptFilter === 'all' || c.department === deptFilter
  const filteredCases = cases.filter(deptOk)
  const filteredDueCases = dueCases.filter(deptOk)
  const isOverdue = (c: KaizenCase) => !!c.due_date && bangkokDate(new Date(c.due_date)) < bangkokDate()

  // Monday-first grid
  const firstOfMonth = parseDateOnlyBkk(`${viewYear}-${String(viewMonth + 1).padStart(2,'0')}-01`)
  const firstDayOfMonth = bangkokDayOfWeek(firstOfMonth)
  const startOffset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1
  // days in month: check what date Bangkok considers the last day of month
  const lastOfMonth = parseDateOnlyBkk(`${viewMonth === 11 ? viewYear+1 : viewYear}-${String(viewMonth === 11 ? 1 : viewMonth+2).padStart(2,'0')}-01`)
  lastOfMonth.setTime(lastOfMonth.getTime() - 86400000)  // go back 1 day
  const daysInMonth = parseInt(bangkokDate(lastOfMonth).slice(8), 10)
  // prev month days
  const prevMonthLastDay = new Date(firstOfMonth.getTime() - 86400000)
  const daysInPrevMonth = parseInt(bangkokDate(prevMonthLastDay).slice(8), 10)
  type Cell = { date: Date; isCurrentMonth: boolean; key: string }
  const p2 = (n: number) => String(n).padStart(2, '0')
  const cells: Cell[] = []
  for (let i = startOffset - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i
    const [py, pm] = viewMonth === 0 ? [viewYear - 1, 12] : [viewYear, viewMonth]
    cells.push({ date: new Date(viewYear, viewMonth - 1, day), isCurrentMonth: false, key: `${py}-${p2(pm)}-${p2(day)}` })
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(viewYear, viewMonth, d), isCurrentMonth: true, key: `${viewYear}-${p2(viewMonth + 1)}-${p2(d)}` })
  const remaining = (7 - (cells.length % 7)) % 7
  for (let d = 1; d <= remaining; d++) {
    const [ny, nm] = viewMonth === 11 ? [viewYear + 1, 1] : [viewYear, viewMonth + 2]
    cells.push({ date: new Date(viewYear, viewMonth + 1, d), isCurrentMonth: false, key: `${ny}-${p2(nm)}-${p2(d)}` })
  }

  // Entries by day key
  const byDay: Record<string, Entry[]> = {}
  if (showCaseData) filteredCases.forEach(c => {
    const k = isoKey(new Date(c.created_at)); (byDay[k] ||= []).push({ kind: 'case', case: c })
  })
  if (showCaseData) filteredDueCases.forEach(c => {
    const k = isoKey(new Date(c.due_date!)); (byDay[k] ||= []).push({ kind: 'casedue', case: c })
  })
  if (showPmData) pmTasks.forEach(tk => { (byDay[tk.due_date] ||= []).push({ kind: 'pm', task: tk }) })
  if (showRrData) rrOrders.forEach(o => { (byDay[o.order_date] ||= []).push({ kind: 'rr', order: o }) })
  if (showRrData) rrRoomOrders.forEach(ro => { (byDay[ro.order_date] ||= []).push({ kind: 'roomorder', ro }) })

  const roomNoun = unitOne(roomUnit, lang)
  const roomOrderLabel = lang === 'th' ? `ใบสั่ง${roomNoun}` : `${roomNoun} order`
  // Room-order summary: who submitted + how many rooms in each state, numbers in brackets.
  const roomOrderSub = (ro: RoomOrderCal) => {
    const who = ro.submitted_by ? actorNames[ro.submitted_by] : null
    const head = ro.status === 'submitted'
      ? (who ? `${lang === 'th' ? 'ส่งโดย' : 'Submitted by'} ${who}` : (lang === 'th' ? 'ส่งแล้ว' : 'Submitted'))
      : (lang === 'th' ? 'ฉบับร่าง' : 'Draft')
    const c = { checkin: 0, occupied: 0, empty: 0, oo: 0 }
    Object.values(ro.room_statuses ?? {}).forEach(s => { if (s in c) c[s as keyof typeof c]++ })
    const breakdown = [
      `${lang === 'th' ? 'เช็คอิน' : 'C/I'} [${c.checkin}]`,
      `${lang === 'th' ? 'พักต่อ' : 'Occ'} [${c.occupied}]`,
      `${lang === 'th' ? 'ว่าง' : 'Empty'} [${c.empty}]`,
      `O/O [${c.oo}]`,
    ].join(' - ')
    return `${head} · ${breakdown}`
  }

  function isToday(date: Date) {
    return bangkokDate(date) === bangkokDate()
  }
  function caseColor(c: KaizenCase) {
    if (c.status === 'closed') return 'bg-gray-200 text-gray-500'
    return PRIORITY_COLORS[c.priority] || 'bg-gray-400 text-white'
  }

  const rrStatusLabel = (s: string) => ({
    pending: t.rr.pending, sent: t.rr.sentStatus, accepted: t.rr.acceptedStatus,
    delivered: t.rr.deliveredStatus, confirmed: t.rr.confirmedStatus, cancelled: t.rr.cancelledStatus,
  } as Record<string, string>)[s] ?? s

  // Status + who did it: "Confirmed by Panomwan", "Accepted by Manode", "Sent by Wiboonchai".
  const rrStatusWithActor = (o: RrOrder) => {
    const id = o.status === 'confirmed' ? o.confirmed_by : o.status === 'delivered' ? o.delivered_by
      : o.status === 'accepted' ? o.accepted_by : o.status === 'sent' ? o.sent_by : null
    const who = id ? actorNames[id] : null
    return who ? `${rrStatusLabel(o.status)} ${lang === 'th' ? 'โดย' : 'by'} ${who}` : rrStatusLabel(o.status)
  }

  const showDeptFilter = (profile?.role === 'super_admin' || profile?.role === 'manager') && showCaseData
  const selectedDate = selectedKey ? parseDateOnlyBkk(selectedKey) : null
  const selectedEntries = byDay[selectedKey] ?? []

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="mb-4 space-y-3">
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t.nav.calendar}</h1>
        {(pmEnabled || rrEnabled) && (
          <div className="flex gap-0.5 sm:gap-1 border-b border-gray-200 flex-nowrap overflow-x-auto">
            {([
              ['cases', t.nav.cases] as const,
              ...(pmEnabled ? [['pm', t.nav.maintenance] as const] : []),
              ...(rrEnabled ? [['rr', t.calendar.routine] as const] : []),
              ['combined', t.calendar.combined] as const,
            ]).map(([m, label]) => (
              <button key={m} onClick={() => setMode(m as typeof mode)}
                className={`px-1.5 sm:px-3 py-2 text-[11px] sm:text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors flex-shrink-0 ${mode === m ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
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
                {calDepts.filter(d => d.value !== 'top_management').map((d) => (
                  <SelectItem key={d.value} value={d.value} className="text-xs">{d.isCustom ? d.label : deptLabel(d.value, lang)}</SelectItem>
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
              const key = cell.key
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
                      {parseInt(bangkokDate(cell.date).slice(8), 10)}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {entries.slice(0, 3).map((e) => e.kind === 'case' ? (
                      <button key={'c' + e.case.id} onClick={(ev) => { ev.stopPropagation(); navigate(`/cases/${e.case.id}`) }}
                        className={`w-full text-left px-1.5 py-0.5 rounded text-[10px] font-medium truncate block leading-4 ${caseColor(e.case)} hover:opacity-75`}
                        title={`${e.case.case_number} · ${e.case.title}`}>{e.case.case_number}</button>
                    ) : e.kind === 'casedue' ? (
                      <button key={'cd' + e.case.id} onClick={(ev) => { ev.stopPropagation(); navigate(`/cases/${e.case.id}`) }}
                        className={`w-full text-left px-1.5 py-0.5 rounded border text-[10px] font-medium truncate flex items-center gap-1 leading-4 hover:opacity-75 ${isOverdue(e.case) ? 'bg-red-50 text-red-700 border-red-300' : 'bg-amber-50 text-amber-700 border-amber-200'}`}
                        title={`${lang === 'th' ? 'ครบกำหนด' : 'Due'} ${formatDueBy(e.case.due_date, lang)} · ${e.case.case_number} · ${e.case.title}`}><Flag className="h-2.5 w-2.5 flex-shrink-0" /><span className="truncate">{e.case.case_number}</span></button>
                    ) : e.kind === 'pm' ? (
                      <button key={'p' + e.task.id} onClick={(ev) => { ev.stopPropagation(); setOpenTask(e.task) }}
                        className={`w-full text-left px-1.5 py-0.5 rounded border text-[10px] font-medium truncate flex items-center gap-1 leading-4 ${taskTone(e.task).chip}`}
                        title={e.task.asset?.name}><Wrench className="h-2.5 w-2.5 flex-shrink-0" /><span className="truncate">{e.task.asset?.name ?? 'Asset'}</span></button>
                    ) : e.kind === 'rr' ? (
                      <button key={'r' + e.order.id} onClick={(ev) => { ev.stopPropagation(); navigate('/routine-roster') }}
                        className={`w-full text-left px-1.5 py-0.5 rounded border text-[10px] font-medium truncate flex items-center gap-1 leading-4 ${(RR_TONES[e.order.status] ?? RR_TONES.pending).chip}`}
                        title={e.order.title}><ClipboardList className="h-2.5 w-2.5 flex-shrink-0" /><span className="truncate">{e.order.title}</span></button>
                    ) : (
                      <button key={'ro' + e.ro.id} onClick={(ev) => { ev.stopPropagation(); navigate('/routine-roster', { state: { rrView: 'rooms', roomDate: e.ro.order_date } }) }}
                        className={`w-full text-left px-1.5 py-0.5 rounded border text-[10px] font-medium truncate flex items-center gap-1 leading-4 ${(ROOMORDER_TONE[e.ro.status] ?? ROOMORDER_TONE.draft).chip}`}
                        title={roomOrderLabel}><DoorOpen className="h-2.5 w-2.5 flex-shrink-0" /><span className="truncate">{roomOrderLabel}</span></button>
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
            <h3 className="text-sm font-semibold text-gray-900">{selectedDate.toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3>
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
                    <p className="text-xs text-gray-400">{e.case.case_number} · {deptLabel(e.case.department, lang)}</p>
                  </div>
                </div>
              ) : e.kind === 'casedue' ? (
                <div key={'cd' + e.case.id} onClick={() => navigate(`/cases/${e.case.id}`)} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer">
                  <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', isOverdue(e.case) ? 'bg-red-500' : 'bg-amber-500')} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5">
                      <Flag className={cn('h-3 w-3 flex-shrink-0', isOverdue(e.case) ? 'text-red-500' : 'text-amber-500')} />
                      {lang === 'th' ? 'ครบกำหนด' : 'Due'}: {e.case.title}
                    </p>
                    <p className={cn('text-xs', isOverdue(e.case) ? 'text-red-500 font-medium' : 'text-gray-400')}>
                      {formatDueBy(e.case.due_date, lang)}{isOverdue(e.case) ? ` · ${lang === 'th' ? 'เลยกำหนด' : 'overdue'}` : ''} · {e.case.case_number}
                    </p>
                  </div>
                </div>
              ) : e.kind === 'pm' ? (
                <button key={'p' + e.task.id} onClick={() => setOpenTask(e.task)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left">
                  <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', taskTone(e.task).dot)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5"><Wrench className="h-3 w-3 text-gray-400" />{e.task.asset?.name ?? 'Maintenance'}</p>
                    <p className="text-xs text-gray-400">{t.pm[taskStatusKey(e.task)]}{e.task.asset?.location ? ` · ${e.task.asset.location}` : ''}</p>
                  </div>
                </button>
              ) : e.kind === 'rr' ? (
                <button key={'r' + e.order.id} onClick={() => navigate('/routine-roster')} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left">
                  <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', (RR_TONES[e.order.status] ?? RR_TONES.pending).dot)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5"><ClipboardList className="h-3 w-3 text-gray-400" />{e.order.title}{e.order.item_label ? ` · ${e.order.item_label}` : ''}</p>
                    <p className="text-xs text-gray-400 truncate">
                      {[
                        `${deptLabel(e.order.request_department, lang)} → ${deptLabel(e.order.fulfill_department, lang)}`,
                        e.order.order_type === 'bulk'
                          ? (e.order.unit_label ? `${e.order.quantity ?? 0} ${e.order.unit_label}` : (e.order.quantity != null ? String(e.order.quantity) : ''))
                          : (e.order.quantity != null ? `${e.order.quantity} ${lang === 'th' ? 'ห้อง' : 'rooms'}` : ''),
                        rrStatusWithActor(e.order),
                      ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </button>
              ) : (
                <button key={'ro' + e.ro.id} onClick={() => navigate('/routine-roster', { state: { rrView: 'rooms', roomDate: e.ro.order_date } })} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left">
                  <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', (ROOMORDER_TONE[e.ro.status] ?? ROOMORDER_TONE.draft).dot)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5"><DoorOpen className="h-3 w-3 text-gray-400" />{roomOrderLabel}</p>
                    {/* Allow wrapping to a 2nd line so the full breakdown stays readable on mobile. */}
                    <p className="text-xs text-gray-400">{roomOrderSub(e.ro)}</p>
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
            <span className="text-gray-300">|</span>
            <Legend color="bg-amber-100 border border-amber-300" label={lang === 'th' ? '⚑ ครบกำหนด' : '⚑ Due'} />
            <Legend color="bg-red-100 border border-red-300" label={lang === 'th' ? 'เลยกำหนด' : 'Overdue'} />
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
        {showRrData && (
          <div className={`flex items-center gap-4 flex-wrap ${showCaseData || showPmData ? 'border-t border-gray-200 pt-2' : ''}`}>
            <span className="text-xs text-gray-400 font-medium">{t.calendar.rrStatus}</span>
            <Legend color="bg-gray-400" label={t.rr.pending} />
            <Legend color="bg-sky-500" label={t.rr.sentStatus} />
            <Legend color="bg-amber-500" label={t.rr.acceptedStatus} />
            <Legend color="bg-teal-500" label={t.rr.deliveredStatus} />
            <Legend color="bg-green-500" label={t.rr.confirmedStatus} />
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
