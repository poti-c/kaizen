import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Calendar as CalIcon, ChevronLeft, ChevronRight, Plus, X, Loader2, Trash2, Check,
  FileText, Wrench, Settings2, Users, MapPin, ExternalLink, AlertTriangle,
} from 'lucide-react'
import { LoadError } from '@/components/LoadError'

type Call = <T,>(a: string, p?: Record<string, unknown>) => Promise<T>

// ── Types ────────────────────────────────────────────────────────────────────
interface FormRow {
  id: string; form_type: 'quotation' | 'invoice' | 'tax_invoice_receipt' | 'receipt'
  doc_number: string; issue_date: string; due_date: string | null; status: string
  client_name: string | null; total: number; currency: string; company_id: string | null
}
interface ApptRow {
  id: string; kind: 'setup' | 'troubleshooting' | 'meeting' | 'other'; title: string
  company_id: string | null; client_name: string | null; start_at: string; end_at: string | null
  all_day: boolean; mode: 'onsite' | 'remote' | 'phone'; location: string | null
  assignee: string | null; contact_name: string | null; contact_phone: string | null
  notes: string | null; status: 'scheduled' | 'completed' | 'cancelled'
}
interface CalCompany { id: string; name: string; contact_person: string | null; contact_phone: string | null }

interface CalEvent {
  key: string; date: string; sort: number; label: string
  color: string; dot: string
  source: 'form' | 'appt'
  form?: FormRow; variant?: 'delivered' | 'expiry'; appt?: ApptRow
}

const KIND_META: Record<ApptRow['kind'], { label: string; icon: typeof Wrench; color: string; dot: string }> = {
  setup: { label: 'Setup', icon: Settings2, color: 'bg-violet-500/15 text-violet-300 border-violet-500/30', dot: 'bg-violet-400' },
  troubleshooting: { label: 'Troubleshooting', icon: Wrench, color: 'bg-orange-500/15 text-orange-300 border-orange-500/30', dot: 'bg-orange-400' },
  meeting: { label: 'Meeting', icon: Users, color: 'bg-teal-500/15 text-teal-300 border-teal-500/30', dot: 'bg-teal-400' },
  other: { label: 'Other', icon: CalIcon, color: 'bg-slate-500/15 text-slate-300 border-slate-500/30', dot: 'bg-slate-400' },
}
const MODE_LABEL = { onsite: 'On-site', remote: 'Remote', phone: 'Phone' }
const FORM_LABEL: Record<FormRow['form_type'], string> = {
  quotation: 'Quotation', invoice: 'Invoice', tax_invoice_receipt: 'Tax Invoice / Receipt', receipt: 'Receipt',
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── Date helpers ─────────────────────────────────────────────────────────────
function dayKey(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(d)
}
function parseDateOnly(s: string) { return new Date(s.length <= 10 ? s + 'T12:00:00+07:00' : s) }
function fmtTime(d: Date) { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) }
function fmtLongDate(s: string) {
  return parseDateOnly(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' })
}
function money(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

// ── Main ─────────────────────────────────────────────────────────────────────
export function CalendarView({ call, onOpenForm }: { call: Call; onOpenForm: (formId: string) => void }) {
  const [loading, setLoading] = useState(true)
  // CAL-BUG-02: a failed load only ever logged to the console — the grid
  // still rendered with whatever forms/appts/companies state happened to be
  // there (empty on first load), indistinguishable from a genuinely quiet
  // month.
  const [loadError, setLoadError] = useState(false)
  const [forms, setForms] = useState<FormRow[]>([])
  const [appts, setAppts] = useState<ApptRow[]>([])
  const [companies, setCompanies] = useState<CalCompany[]>([])
  const [cursor, setCursor] = useState(() => { const bkk = dayKey(new Date()); return new Date(bkk.slice(0, 7) + '-01T12:00:00+07:00') })
  const [openDetail, setOpenDetail] = useState<CalEvent | null>(null)
  const [editAppt, setEditAppt] = useState<ApptRow | 'new' | null>(null)
  const [dayExpand, setDayExpand] = useState<string | null>(null)

  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const [f, a] = await Promise.all([
        call<{ forms: FormRow[] }>('list_forms'),
        call<{ appointments: ApptRow[]; companies: CalCompany[] }>('list_appointments'),
      ])
      if (seq !== loadSeq.current) return
      setForms(f.forms ?? [])
      setAppts(a.appointments ?? [])
      setCompanies(a.companies ?? [])
      setLoadError(false)
    } catch (e) {
      console.error('Calendar load failed:', e)
      if (seq === loadSeq.current) setLoadError(true)
    } finally { if (seq === loadSeq.current) setLoading(false) }
  }, [call])
  useEffect(() => { load() }, [load])

  // Build events from forms + appointments
  const events = useMemo<CalEvent[]>(() => {
    const out: CalEvent[] = []
    for (const f of forms) {
      const label = FORM_LABEL[f.form_type]
      out.push({
        key: `f-${f.id}-d`, date: f.issue_date, sort: 1, source: 'form', form: f, variant: 'delivered',
        label: `${label} ${f.doc_number} delivered`,
        color: 'bg-sky-500/15 text-sky-300 border-sky-500/30', dot: 'bg-sky-400',
      })
      if (f.form_type === 'quotation' && f.due_date) {
        out.push({
          key: `f-${f.id}-e`, date: f.due_date, sort: 0, source: 'form', form: f, variant: 'expiry',
          label: `${label} ${f.doc_number} expires`,
          color: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: 'bg-amber-400',
        })
      }
      if ((f.form_type === 'invoice' || f.form_type === 'tax_invoice_receipt') && f.due_date) {
        out.push({
          key: `f-${f.id}-due`, date: f.due_date, sort: 0, source: 'form', form: f, variant: 'expiry',
          label: `${label} ${f.doc_number} payment due`,
          color: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: 'bg-amber-400',
        })
      }
    }
    for (const a of appts) {
      const start = new Date(a.start_at)
      const meta = KIND_META[a.kind] ?? KIND_META['other']
      const cancelled = a.status === 'cancelled'
      // hour:'2-digit' (not 'numeric') so midnight is '00' not '24' — 'numeric' with
      // hour12:false returns '24' for 00:00 in Chromium, which sorted midnight last.
      const bkkH = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }).format(start)) % 24
      const bkkM = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', minute: 'numeric' }).format(start))
      out.push({
        // All-day events sort before timed appointments for the same day (1.5 puts
        // them after form events at 1 but before any timed appointment at 2+).
        key: `a-${a.id}`, date: dayKey(start), sort: a.all_day ? 1.5 : 2 + (bkkH * 60 + bkkM) / 1440,
        source: 'appt', appt: a, label: `${a.all_day ? '' : fmtTime(start) + ' · '}${a.title}`,
        color: cancelled ? 'bg-slate-700/40 text-slate-500 border-slate-700 line-through' : meta.color,
        dot: cancelled ? 'bg-slate-500' : meta.dot,
      })
    }
    return out
  }, [forms, appts])

  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>()
    for (const e of events) {
      if (!m.has(e.date)) m.set(e.date, [])
      m.get(e.date)!.push(e)
    }
    for (const list of m.values()) list.sort((a, b) => a.sort - b.sort)
    return m
  }, [events])

  // Build 6-week grid starting Sunday — all anchored to noon Bangkok (+07:00) so
  // dayKey() and the displayed day number both reference the same Bangkok calendar
  // date regardless of the viewer's browser timezone.
  const cells = useMemo(() => {
    const bkkFirst = dayKey(cursor) // 'YYYY-MM-01' (cursor is always 1st of month)
    const firstNoon = new Date(`${bkkFirst}T12:00:00+07:00`)
    const bkkMonth = bkkFirst.slice(0, 7)
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Bangkok' }).format(firstNoon)
    )
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(firstNoon.getTime() + (i - dow) * 86400000)
      const bkkDate = dayKey(d)
      return { date: d, bkkDate, day: Number(bkkDate.slice(8)), inMonth: bkkDate.slice(0, 7) === bkkMonth }
    })
  }, [cursor])

  // Recompute the 'today' key once a minute so the highlight follows Bangkok midnight
  // even if the calendar is left open overnight without any interaction.
  const [todayKey, setTodayKey] = useState(() => dayKey(new Date()))
  useEffect(() => {
    const id = setInterval(() => setTodayKey(dayKey(new Date())), 60000)
    return () => clearInterval(id)
  }, [])
  const monthTitle = new Date(`${dayKey(cursor)}T12:00:00+07:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' })

  // Form events open the document (PDF) directly; appointments open the detail card.
  const openEvent = (e: CalEvent) => {
    if (e.source === 'form' && e.form) onOpenForm(e.form.id)
    else setOpenDetail(e)
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <CalIcon className="h-5 w-5 text-amber-400" />
          <h2 className="text-base font-semibold text-white">Calendar</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-0.5">
            <button onClick={() => { const bkk = dayKey(cursor); const [y, m] = [Number(bkk.slice(0, 4)), Number(bkk.slice(5, 7))]; const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; setCursor(new Date(`${prev}T12:00:00+07:00`)); setDayExpand(null) }} className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800"><ChevronLeft className="h-4 w-4" /></button>
            <button onClick={() => { const bkk = dayKey(new Date()); setCursor(new Date(bkk.slice(0, 7) + '-01T12:00:00+07:00')); setDayExpand(null) }} className="px-2.5 h-7 text-xs font-medium text-slate-300 hover:text-white rounded-md hover:bg-slate-800">Today</button>
            <button onClick={() => { const bkk = dayKey(cursor); const [y, m] = [Number(bkk.slice(0, 4)), Number(bkk.slice(5, 7))]; const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; setCursor(new Date(`${next}T12:00:00+07:00`)); setDayExpand(null) }} className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800"><ChevronRight className="h-4 w-4" /></button>
          </div>
          <button onClick={() => setEditAppt('new')} className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold px-3 py-2 rounded-lg transition-colors">
            <Plus className="h-3.5 w-3.5" />Appointment
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-bold text-white">{monthTitle}</h3>
        <div className="flex items-center gap-3 text-[10px] text-slate-400 flex-wrap">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400" />Delivered</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" />Due / Expiry</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-400" />Setup</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400" />Troubleshooting</span>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
      ) : loadError ? (
        <LoadError dark message="Failed to load the calendar." onRetry={load} className="py-20" />
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="grid grid-cols-7 border-b border-slate-800">
            {WEEKDAYS.map((w) => (
              <div key={w} className="px-2 py-2 text-center text-[11px] font-semibold text-slate-400">{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map(({ bkkDate, day, inMonth }, i) => {
              const isToday = bkkDate === todayKey
              const dayEvents = eventsByDay.get(bkkDate) ?? []
              const expanded = dayExpand === bkkDate
              return (
                <div key={i} className={`min-h-[104px] border-b border-r border-slate-800 p-1.5 ${i % 7 === 6 ? 'border-r-0' : ''} ${inMonth ? '' : 'bg-slate-950/40'}`}>
                  <div className="flex justify-end">
                    <span className={`text-[11px] w-5 h-5 flex items-center justify-center rounded-full ${isToday ? 'bg-amber-500 text-slate-950 font-bold' : inMonth ? 'text-slate-300' : 'text-slate-600'}`}>{day}</span>
                  </div>
                  <div className="space-y-1 mt-0.5">
                    {(expanded ? dayEvents : dayEvents.slice(0, 3)).map((e) => (
                      <button key={e.key} onClick={() => openEvent(e)} title={e.label}
                        className={`w-full flex items-center gap-1 text-[10px] leading-tight px-1.5 py-0.5 rounded border text-left truncate ${e.color}`}>
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.dot}`} />
                        <span className="truncate">{e.label}</span>
                      </button>
                    ))}
                    {!expanded && dayEvents.length > 3 && (
                      <button onClick={() => setDayExpand(bkkDate)} className="text-[10px] text-slate-400 hover:text-white px-1.5">+{dayEvents.length - 3} more</button>
                    )}
                    {expanded && dayEvents.length > 3 && (
                      <button onClick={() => setDayExpand(null)} className="text-[10px] text-slate-400 hover:text-white px-1.5">show less</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {openDetail && (
        <EventDetail event={openDetail} companies={companies} onClose={() => setOpenDetail(null)}
          onOpenForm={(id) => { setOpenDetail(null); onOpenForm(id) }}
          onEdit={(a) => { setOpenDetail(null); setEditAppt(a) }} />
      )}
      {editAppt && (
        <AppointmentEditor key={editAppt === 'new' ? '__new__' : editAppt.id} call={call} companies={companies} appt={editAppt === 'new' ? null : editAppt}
          onClose={() => setEditAppt(null)} onSaved={() => { setEditAppt(null); load() }} />
      )}
    </div>
  )
}

// ── Event detail modal ───────────────────────────────────────────────────────
function EventDetail({ event, companies, onClose, onOpenForm, onEdit }: {
  event: CalEvent; companies: CalCompany[]; onClose: () => void
  onOpenForm: (id: string) => void; onEdit: (a: ApptRow) => void
}) {
  return (
    <Modal onClose={onClose}>
      {event.source === 'form' && event.form ? (
        <div>
          <div className="flex items-center gap-2 mb-1"><FileText className="h-5 w-5 text-sky-400" /><h3 className="text-sm font-semibold text-white">{FORM_LABEL[event.form.form_type]} · {event.form.doc_number}</h3></div>
          <p className="text-xs text-slate-400 mb-4">{event.variant === 'expiry' ? 'Validity / payment reminder' : 'Document delivered'}</p>
          <div className="space-y-2 text-sm">
            <DetailRow label="Client">{event.form.client_name || '—'}</DetailRow>
            <DetailRow label="Issue date">{fmtLongDate(event.form.issue_date)}</DetailRow>
            {event.form.due_date && <DetailRow label={event.form.form_type === 'quotation' ? 'Valid until' : 'Due date'}>{fmtLongDate(event.form.due_date)}</DetailRow>}
            <DetailRow label="Amount">{event.form.currency} {money(event.form.total)}</DetailRow>
            <DetailRow label="Status"><span className="capitalize">{event.form.status}</span></DetailRow>
          </div>
          <button onClick={() => onOpenForm(event.form!.id)} className="mt-5 w-full flex items-center justify-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold h-9 rounded-lg">
            <ExternalLink className="h-3.5 w-3.5" />Open in Form Generator
          </button>
        </div>
      ) : event.appt ? (
        <AppointmentDetail appt={event.appt} companies={companies} onEdit={() => onEdit(event.appt!)} />
      ) : null}
    </Modal>
  )
}

function AppointmentDetail({ appt, companies, onEdit }: { appt: ApptRow; companies: CalCompany[]; onEdit: () => void }) {
  // cal-1: fall back to 'other' for an unknown kind (e.g. a new DB enum value not yet in
  // KIND_META), mirroring the events builder — a bare lookup would throw and white-screen.
  const meta = KIND_META[appt.kind] ?? KIND_META['other']
  const Icon = meta.icon
  const start = new Date(appt.start_at)
  const end = appt.end_at ? new Date(appt.end_at) : null
  const company = companies.find(c => c.id === appt.company_id)
  return (
    <div>
      <div className="flex items-center gap-2 mb-1"><Icon className="h-5 w-5 text-violet-300" /><h3 className="text-sm font-semibold text-white">{appt.title}</h3></div>
      <div className="flex items-center gap-2 mb-4">
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${meta.color}`}>{meta.label}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${appt.status === 'completed' ? 'bg-green-500/15 text-green-300 border-green-500/30' : appt.status === 'cancelled' ? 'bg-red-500/15 text-red-300 border-red-500/30' : 'bg-slate-700/40 text-slate-300 border-slate-700'}`}>{appt.status}</span>
      </div>
      <div className="space-y-2 text-sm">
        <DetailRow label="When">{appt.all_day ? fmtLongDate(appt.start_at) + ' · All day' : `${fmtLongDate(appt.start_at)} · ${fmtTime(start)}${end ? `–${fmtTime(end)}` : ''}`}</DetailRow>
        <DetailRow label="Client">{company?.name || appt.client_name || '—'}</DetailRow>
        <DetailRow label="Mode">{MODE_LABEL[appt.mode]}</DetailRow>
        {appt.location && <DetailRow label="Location"><span className="flex items-center gap-1"><MapPin className="h-3 w-3 text-slate-500" />{appt.location}</span></DetailRow>}
        {appt.assignee && <DetailRow label="Assigned to">{appt.assignee}</DetailRow>}
        {(appt.contact_name || appt.contact_phone) && <DetailRow label="Contact">{[appt.contact_name, appt.contact_phone].filter(Boolean).join(' · ')}</DetailRow>}
        {appt.notes && <DetailRow label="Notes"><span className="whitespace-pre-wrap">{appt.notes}</span></DetailRow>}
      </div>
      <button onClick={onEdit} className="mt-5 w-full flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold h-9 rounded-lg">Edit appointment</button>
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-3"><span className="text-slate-500 w-24 flex-shrink-0 text-xs pt-0.5">{label}</span><span className="text-slate-200 flex-1">{children}</span></div>
}

// ── Appointment editor ───────────────────────────────────────────────────────
const inputCls = 'w-full h-9 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50'

function AppointmentEditor({ call, companies, appt, onClose, onSaved }: {
  call: Call; companies: CalCompany[]; appt: ApptRow | null; onClose: () => void; onSaved: () => void
}) {
  const init = (() => {
    if (appt) {
      const bkkFmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', ...opts }).format(d)
      const s = new Date(appt.start_at), e = appt.end_at ? new Date(appt.end_at) : null
      return {
        kind: appt.kind, title: appt.title, company_id: appt.company_id ?? '', status: appt.status,
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(s),
        start: bkkFmt(s, { hour: '2-digit', minute: '2-digit', hour12: false }),
        end: e ? bkkFmt(e, { hour: '2-digit', minute: '2-digit', hour12: false }) : '',
        all_day: appt.all_day, mode: appt.mode, location: appt.location ?? '',
        assignee: appt.assignee ?? '', contact_name: appt.contact_name ?? '', contact_phone: appt.contact_phone ?? '', notes: appt.notes ?? '',
      }
    }
    return {
      kind: 'setup' as ApptRow['kind'], title: '', company_id: '', status: 'scheduled' as ApptRow['status'],
      date: dayKey(new Date()),
      start: '10:00', end: '11:00', all_day: false, mode: 'onsite' as ApptRow['mode'],
      location: '', assignee: '', contact_name: '', contact_phone: '', notes: '',
    }
  })()
  const [f, setF] = useState(init)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (patch: Partial<typeof init>) => setF({ ...f, ...patch })

  // Auto-fill contact from chosen client
  function pickCompany(id: string) {
    const c = companies.find(x => x.id === id)
    set({ company_id: id, contact_name: c?.contact_person ?? f.contact_name, contact_phone: c?.contact_phone ?? f.contact_phone })
  }

  async function save() {
    if (!f.title.trim()) { setError('Please enter a title.'); return }
    if (!f.date) { setError('Please choose a date.'); return }
    const resolvedStart = f.start || '00:00'
    if (!f.all_day && f.end && f.end <= resolvedStart) { setError('End time must be after the start time. Overnight appointments (past midnight) are not supported — use "All day" instead.'); return }
    setBusy(true); setError('')
    try {
      // All-day events anchor to NOON Bangkok (explicit +07:00) rather than the creator's
      // local midnight, so the stored instant lands squarely on the intended calendar day
      // regardless of who created it or where they're viewing from.
      const start_at = f.all_day
        ? new Date(`${f.date}T12:00:00+07:00`).toISOString()
        : new Date(`${f.date}T${f.start || '00:00'}:00+07:00`).toISOString()
      const end_at = !f.all_day && f.end ? new Date(`${f.date}T${f.end}:00+07:00`).toISOString() : null
      const client = companies.find(c => c.id === f.company_id)
      // CAL-BUG-01: client_name has no input of its own — it's derived purely
      // from the selected company, so this used to write `null` whenever
      // f.company_id is empty ('— none —', also the state for any appointment
      // stored with company_id = null from the start). That silently
      // destroyed a free-text client name — a shape the type explicitly
      // allows independent of company_id — on any save that touched nothing
      // but the status or notes. Preserve the existing value when no company
      // is (or was ever) linked.
      const client_name = client?.name ?? appt?.client_name ?? null
      await call('upsert_appointment', {
        appointment: {
          id: appt?.id, kind: f.kind, title: f.title.trim(), company_id: f.company_id || null,
          client_name, start_at, end_at, all_day: f.all_day, mode: f.mode,
          status: f.status, location: f.location, assignee: f.assignee, contact_name: f.contact_name,
          contact_phone: f.contact_phone, notes: f.notes,
        },
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to save') } finally { setBusy(false) }
  }
  async function del() {
    if (!appt || !confirm('Delete this appointment?')) return
    setBusy(true)
    try { await call('delete_appointment', { appointment_id: appt.id }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); setBusy(false) }
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="flex items-center gap-2 mb-4">
        <CalIcon className="h-5 w-5 text-amber-400" />
        <h3 className="text-sm font-semibold text-white">{appt ? 'Edit Appointment' : 'New Appointment'}</h3>
      </div>
      <div className="space-y-3 max-h-[65vh] overflow-y-auto pr-1">
        <div>
          <label className="text-xs font-medium text-slate-400">Type</label>
          <div className="grid grid-cols-4 gap-1.5 mt-1.5">
            {(Object.keys(KIND_META) as ApptRow['kind'][]).map((k) => (
              <button key={k} onClick={() => set({ kind: k })}
                className={`text-xs h-8 rounded-lg border ${f.kind === k ? 'bg-amber-500 text-slate-950 border-amber-500 font-semibold' : 'bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-600'}`}>
                {KIND_META[k].label}
              </button>
            ))}
          </div>
        </div>
        <Field label="Title *"><input value={f.title} onChange={(e) => set({ title: e.target.value })} className={inputCls} placeholder="e.g. On-site setup & onboarding" autoFocus /></Field>
        <Field label="Client">
          <select value={f.company_id} onChange={(e) => pickCompany(e.target.value)} className={inputCls}>
            <option value="">— none —</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Date *"><input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} className={inputCls} /></Field>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input type="checkbox" checked={f.all_day} onChange={(e) => set({ all_day: e.target.checked })} className="accent-amber-500" />All day
            </label>
          </div>
        </div>
        {!f.all_day && (
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Start"><input type="time" value={f.start} onChange={(e) => set({ start: e.target.value })} className={inputCls} /></Field>
            <Field label="End"><input type="time" value={f.end} onChange={(e) => set({ end: e.target.value })} className={inputCls} /></Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Mode">
            <select value={f.mode} onChange={(e) => set({ mode: e.target.value as ApptRow['mode'] })} className={inputCls}>
              <option value="onsite">On-site</option><option value="remote">Remote</option><option value="phone">Phone</option>
            </select>
          </Field>
          <Field label="Status">
            <select value={f.status} onChange={(e) => set({ status: e.target.value as ApptRow['status'] })} className={inputCls}>
              <option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option>
            </select>
          </Field>
        </div>
        <Field label={f.mode === 'remote' ? 'Meeting link' : 'Location'}><input value={f.location} onChange={(e) => set({ location: e.target.value })} className={inputCls} placeholder={f.mode === 'remote' ? 'https://meet…' : 'Site address'} /></Field>
        <Field label="Assigned to (NNR)"><input value={f.assignee} onChange={(e) => set({ assignee: e.target.value })} className={inputCls} placeholder="Technician / staff name" /></Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Client contact"><input value={f.contact_name} onChange={(e) => set({ contact_name: e.target.value })} className={inputCls} placeholder="Contact person" /></Field>
          <Field label="Contact phone"><input value={f.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} className={inputCls} placeholder="08x-xxx-xxxx" /></Field>
        </div>
        <Field label="Notes"><textarea value={f.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} className={inputCls + ' h-auto py-2 resize-none'} placeholder="Scope, parts needed, reminders…" /></Field>
        {error && <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg px-3 py-2"><AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{error}</span></div>}
      </div>
      <div className="flex items-center gap-2 pt-4 mt-1 border-t border-slate-800">
        <button onClick={save} disabled={busy} className="flex items-center gap-1.5 px-3 h-9 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{appt ? 'Save' : 'Create'}
        </button>
        <button onClick={onClose} className="px-3 h-9 rounded-lg text-slate-400 hover:bg-slate-800 text-xs">Cancel</button>
        {appt && <button onClick={del} disabled={busy} className="ml-auto flex items-center gap-1.5 px-3 h-9 rounded-lg text-red-400 hover:bg-red-500/10 text-xs"><Trash2 className="h-3.5 w-3.5" />Delete</button>}
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label className="text-xs font-medium text-slate-400">{label}</label>{children}</div>
}

function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl w-full ${wide ? 'max-w-lg' : 'max-w-sm'}`}>
        <button onClick={onClose} className="absolute top-3 right-3 p-1 rounded text-slate-500 hover:text-white hover:bg-slate-800"><X className="h-4 w-4" /></button>
        {children}
      </div>
    </div>
  )
}
