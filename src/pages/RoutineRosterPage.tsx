import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import {
  ClipboardList, ChevronLeft, ChevronRight, Loader2, X, Check, Trash2, Pencil,
  Plus, Send, PackageCheck, CircleCheck, ArrowRight, Clock, BedDouble, Ban, ChevronDown,
  Bell, BellOff, History, Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import {
  DEPARTMENT_LABELS, deptLabel,
  type Department, type RrTemplate, type RrOrder, type RrOrderItem, type RrOrderStatus,
  type RrOrderType, type RrVariant, type RrEvent,
} from '@/types'
import type { RrItem } from '@/components/RRSettings'
import { RoomOrderView } from '@/components/RoomOrderView'
import { unitOne, DEFAULT_UNIT, type UnitNoun } from '@/lib/roomUnit'
import { resolveDeptRecipients } from '@/lib/rrNotify'
import { useRrFoAccess } from '@/hooks/useRrFoAccess'

// ── helpers ──────────────────────────────────────────────────────────────────

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const RUN_WD = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const WD_LABEL_EN: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' }
const WD_LABEL_TH: Record<string, string> = { mon: 'จ', tue: 'อ', wed: 'พ', thu: 'พฤ', fri: 'ศ', sat: 'ส', sun: 'อา' }
/** Does this template run on the given date? (run_weekdays null = every day) */
function runsOnDate(tp: RrTemplate, date: string): boolean {
  if (!tp.run_weekdays || tp.run_weekdays.length === 0) return true
  return tp.run_weekdays.includes(WEEKDAY_KEYS[new Date(date + 'T00:00:00').getDay()])
}

/** Local (not UTC) yyyy-mm-dd — the hotel runs on local time. */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function shiftDate(key: string, days: number): string {
  const d = new Date(key + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return dateKey(d)
}
/** Item for a template on a given date: weekday override, else the default. */
function itemFor(tpl: RrTemplate, date: string): string | null {
  const wd = WEEKDAY_KEYS[new Date(date + 'T00:00:00').getDay()]
  return tpl.item_by_weekday?.[wd] || tpl.default_item || null
}
function fmtTime(ts: string | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
/** "HH:MM" from a "HH:MM[:SS]" time string. */
function hhmm(t: string | null | undefined): string {
  return (t || '').slice(0, 5)
}
/** Variant breakdown like "V1×4 · V2×6 · V3×19" from order items. */
function variantBreakdown(items: RrOrderItem[], variants: RrVariant[] | null, lang: 'en' | 'th'): string {
  const counts = new Map<string, number>()
  for (const it of items) {
    const k = it.variant || '—'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const labelFor = (code: string) => {
    const v = variants?.find((x) => x.code === code)
    if (!v) return code
    return lang === 'th' ? (v.label_th || v.label || v.code) : (v.label || v.code)
  }
  return Array.from(counts.entries()).map(([code, n]) => `${labelFor(code)}×${n}`).join(' · ')
}

const STATUS_PILL: Record<RrOrderStatus, string> = {
  pending: 'bg-gray-100 text-gray-600 border-gray-200',
  sent: 'bg-blue-50 text-blue-700 border-blue-200',
  accepted: 'bg-amber-50 text-amber-700 border-amber-200',
  delivered: 'bg-teal-50 text-teal-700 border-teal-200',
  confirmed: 'bg-green-50 text-green-700 border-green-200',
  cancelled: 'bg-red-50 text-red-400 border-red-200',
}
const STATUS_DOT: Record<RrOrderStatus, string> = {
  pending: 'bg-gray-300', sent: 'bg-blue-500', accepted: 'bg-amber-500',
  delivered: 'bg-teal-500', confirmed: 'bg-green-500', cancelled: 'bg-red-300',
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40'

// ── page ─────────────────────────────────────────────────────────────────────

export function RoutineRosterPage() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { t: tr, lang } = useLanguage()
  const companyId = activeCompany?.id ?? null
  const canManage = profile?.role === 'super_admin' || profile?.role === 'manager'
  const rrFo = useRrFoAccess()

  const [view, setView] = useState<'board' | 'rooms' | 'templates' | 'report'>('board')
  const [fulfillingDepts, setFulfillingDepts] = useState<Set<string>>(new Set()) // depts used as a fulfilling dept in the room recipes
  // Managers + authorized Front Office can place/inspect; staff in a fulfilling department see their own fulfil board.
  const canRooms = canManage
    || (profile?.department === 'front_office' && rrFo.allowed)
    || (!!profile?.department && fulfillingDepts.has(profile.department))

  // Deep-link from the calendar's room-order chip: open the Room order tab at that date.
  const location = useLocation()
  const nav = location.state as { rrView?: string; roomDate?: string } | null
  useEffect(() => {
    if (nav?.rrView === 'rooms' && canRooms) setView('rooms')
  }, [nav?.rrView, canRooms])
  const [date, setDate] = useState(() => dateKey(new Date()))
  const [templates, setTemplates] = useState<RrTemplate[]>([])
  const [orders, setOrders] = useState<RrOrder[]>([])
  const [rooms, setRooms] = useState<string[]>([])
  const [unit, setUnit] = useState<UnitNoun>(DEFAULT_UNIT) // configurable noun (Room / Hut / Resort …)
  const [mutes, setMutes] = useState<Set<string>>(new Set()) // template_ids muted by me
  const [loading, setLoading] = useState(true)
  const today = dateKey(new Date())
  const tomorrow = shiftDate(today, 1)
  const readOnly = date !== today

  const statusLabel = (s: RrOrderStatus) =>
    ({ pending: tr.rr.pending, sent: tr.rr.sentStatus, accepted: tr.rr.acceptedStatus,
       delivered: tr.rr.deliveredStatus, confirmed: tr.rr.confirmedStatus, cancelled: tr.rr.cancelledStatus }[s])

  // Room locations for the active company (per-room grids).
  useEffect(() => {
    if (!companyId) return
    let stale = false
    supabase.from('kaizen_settings').select('value')
      .eq('company_id', companyId).eq('key', 'custom_locations').maybeSingle()
      .then(({ data }) => {
        if (stale) return
        const v = data?.value
        setRooms(Array.isArray(v) ? (v as string[]) : [])
      })
    supabase.from('kaizen_settings').select('value')
      .eq('company_id', companyId).eq('key', 'rr_room_config').maybeSingle()
      .then(({ data }) => {
        if (stale) return
        const u = (data?.value as { unit?: UnitNoun } | undefined)?.unit
        if (u) setUnit(u)
      })
    // Which departments actually fulfil room orders (for staff fulfil-board access).
    supabase.from('kaizen_settings').select('value')
      .eq('company_id', companyId).eq('key', 'rr_room_recipes').maybeSingle()
      .then(({ data }) => {
        if (stale) return
        const recipes = (data?.value as Record<string, { fulfill_department?: string }[]> | undefined) ?? {}
        const set = new Set<string>()
        Object.values(recipes).forEach((lines) => (lines ?? []).forEach((l) => { if (l.fulfill_department) set.add(l.fulfill_department) }))
        setFulfillingDepts(set)
      })
    return () => { stale = true }
  }, [companyId])

  // Which routines have *I* muted (for the bell toggle + notify filtering).
  const loadMutes = useCallback(async () => {
    if (!companyId || !profile) { setMutes(new Set()); return }
    const { data } = await supabase.from('kaizen_rr_mutes').select('template_id').eq('user_id', profile.id)
    setMutes(new Set(((data as { template_id: string }[]) ?? []).map((m) => m.template_id)))
  }, [companyId, profile])
  useEffect(() => { loadMutes() }, [loadMutes])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const tpls = await supabase.from('kaizen_rr_templates').select('*')
      .eq('company_id', companyId).order('sort_order').order('created_at')
    if (tpls.error) { toast.error(tpls.error.message); setLoading(false); return }
    const tplList = (tpls.data as RrTemplate[]) ?? []
    setTemplates(tplList)

    const fetchOrders = () => supabase.from('kaizen_rr_orders')
      .select('*, items:kaizen_rr_order_items(*)')
      .eq('company_id', companyId).eq('order_date', date)
      .order('due_at', { ascending: true, nullsFirst: false })
    let res = await fetchOrders()

    // Materialize pending orders for the selected SERVICE date when that date is
    // within the template's ordering reach: [today, today + lead_days]. So a
    // lead_days=1 routine's order for tomorrow's service appears tonight, and a
    // same-day routine appears only on its own day.
    // Upsert + ignoreDuplicates makes this race-safe across devices.
    const leadOf = (tp: RrTemplate) => Math.max(0, tp.lead_days ?? 0)
    const reach = (tp: RrTemplate) => shiftDate(today, leadOf(tp))
    if (date >= today) {
      const have = new Set(((res.data as RrOrder[]) ?? []).map((o) => o.template_id))
      const missing = tplList.filter((tp) => tp.active && !have.has(tp.id) && date <= reach(tp) && runsOnDate(tp, date))
      if (missing.length > 0) {
        const rows = missing.map((tp) => ({
          company_id: companyId, template_id: tp.id, order_date: date,
          title: tp.name, request_department: tp.request_department, fulfill_department: tp.fulfill_department,
          order_type: tp.order_type, item_label: itemFor(tp, date), status: 'pending',
          unit_label: tp.order_type === 'bulk' ? tp.unit_label : null,
          due_at: new Date(`${date}T${tp.due_time || '12:00'}`).toISOString(),
        }))
        const up = await supabase.from('kaizen_rr_orders')
          .upsert(rows, { onConflict: 'template_id,order_date', ignoreDuplicates: true })
        if (up.error) toast.error(up.error.message)
        res = await fetchOrders()
      }
    }
    if (res.error) toast.error(res.error.message)
    setOrders((res.data as RrOrder[]) ?? [])
    setLoading(false)
  }, [companyId, date, today])
  useEffect(() => { load() }, [load])

  // PIC-aware notification. Targets:
  //  • whole department (pic_mode 'department'), OR
  //  • the assigned PIC users + that department's managers (pic_mode 'users').
  // Always excludes the actor, and skips users who muted this routine — except
  // a staff PIC for that template is never skipped (they're responsible).
  const notifyDept = useCallback(async (
    dept: Department, title: string, message: string,
    opts?: { templateId?: string | null; picMode?: string | null; picIds?: string[] | null; useDeptConfig?: boolean },
  ) => {
    if (!companyId || !profile) return
    const picMode = opts?.picMode
    const picIds = (opts?.picIds ?? []).filter(Boolean)

    let rows: { id: string; role: string }[] = []
    if (opts?.useDeptConfig) {
      // Fulfilling-department alert — honour the shared notify policy
      // (Manager only / Whole dept / Specific staff; default = managers).
      rows = await resolveDeptRecipients(companyId, dept)
    } else if (picMode === 'users' && picIds.length > 0) {
      // Assigned people + the department's managers/super_admins.
      const [pickedRes, mgrRes] = await Promise.all([
        supabase.from('kaizen_profiles').select('id, role').eq('company_id', companyId).eq('is_active', true).in('id', picIds),
        supabase.from('kaizen_profiles').select('id, role').eq('company_id', companyId).eq('is_active', true)
          .eq('department', dept).in('role', ['manager', 'super_admin']),
      ])
      const byId = new Map<string, { id: string; role: string }>()
      ;[...(pickedRes.data ?? []), ...(mgrRes.data ?? [])].forEach((p) => byId.set(p.id, p as { id: string; role: string }))
      rows = Array.from(byId.values())
    } else {
      const { data } = await supabase.from('kaizen_profiles').select('id, role')
        .eq('company_id', companyId).eq('department', dept).eq('is_active', true)
      rows = (data as { id: string; role: string }[]) ?? []
    }

    // Resolve mutes for this template (skip muted users, but never an assigned staff PIC).
    let mutedSet = new Set<string>()
    if (opts?.templateId) {
      const { data } = await supabase.from('kaizen_rr_mutes').select('user_id').eq('template_id', opts.templateId)
      mutedSet = new Set(((data as { user_id: string }[]) ?? []).map((m) => m.user_id))
    }
    const picSet = new Set(picIds)
    const targets = rows.filter((p) => {
      if (p.id === profile.id) return false
      if (mutedSet.has(p.id)) {
        // A staff PIC for this routine is always notified despite their mute.
        return p.role === 'staff' && picSet.has(p.id)
      }
      return true
    })
    if (targets.length === 0) return
    await supabase.from('kaizen_notifications').insert(
      targets.map((p) => ({ user_id: p.id, title, message, notification_type: 'rr' }))
    )
  }, [companyId, profile])

  // Display name: prefer the template's Thai name when the UI is in Thai.
  const displayTitle = useCallback((o: RrOrder) => {
    if (lang === 'th') {
      const tpl = templates.find((tp) => tp.id === o.template_id)
      if (tpl?.name_th) return tpl.name_th
    }
    return o.title
  }, [lang, templates])

  const tplOf = useCallback((o: RrOrder) => templates.find((tp) => tp.id === o.template_id) ?? null, [templates])

  // Is the current user on the REQUEST side for this order? With pic_mode 'users',
  // a staff member only counts if they're an assigned PIC; managers always can act.
  const onRequestSide = useCallback((o: RrOrder) => {
    if (!profile) return false
    if (canManage) return true
    if (profile.department !== o.request_department) return false
    const tpl = tplOf(o)
    if (tpl?.pic_mode === 'users') return (tpl.pic_ids ?? []).includes(profile.id)
    return true
  }, [profile, canManage, tplOf])

  // Whose turn is it? pending/delivered → requesting side; sent/accepted → fulfilling side.
  const needsMyAction = useCallback((o: RrOrder) => {
    if (!profile || readOnly) return false
    const onFulfill = canManage || profile.department === o.fulfill_department
    if (o.status === 'pending' || o.status === 'delivered') return onRequestSide(o)
    if (o.status === 'sent' || o.status === 'accepted') return onFulfill
    return false
  }, [profile, canManage, readOnly, onRequestSide])

  const mine = orders.filter(needsMyAction)
  const rest = orders.filter((o) => !needsMyAction(o))

  // Prompt banner (today's board only): count pending orders to PLACE for the
  // next service date — i.e. lead_days>0 routines whose tomorrow order is pending
  // and the current user is on the request side.
  const [tomorrowToPlace, setTomorrowToPlace] = useState(0)
  useEffect(() => {
    if (!companyId || !profile) { setTomorrowToPlace(0); return }
    let stale = false
    supabase.from('kaizen_rr_orders').select('*').eq('company_id', companyId)
      .eq('order_date', tomorrow).eq('status', 'pending')
      .then(({ data }) => {
        if (stale) return
        const list = (data as RrOrder[]) ?? []
        const n = list.filter((o) => onRequestSide(o)).length
        setTomorrowToPlace(n)
      })
    return () => { stale = true }
  }, [companyId, profile, tomorrow, orders, templates, onRequestSide])
  const showBanner = !readOnly && date === today && tomorrowToPlace > 0

  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString(
    lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })

  // Front-office staff not on the authorized list can't access the Routine Roster.
  if (!rrFo.loading && !rrFo.allowed) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <ClipboardList className="h-8 w-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">{lang === 'th' ? 'คุณไม่มีสิทธิ์เข้าถึงตารางงานประจำ' : "You don't have access to the Routine Roster."}</p>
        <p className="text-xs text-gray-400 mt-1">{lang === 'th' ? 'โปรดติดต่อผู้จัดการเพื่อขอสิทธิ์' : 'Ask a manager to authorize your access.'}</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-[var(--brand-primary)]" />
          <h1 className="text-lg font-bold text-gray-900">{tr.rr.title}</h1>
        </div>
        <div className="flex rounded-lg border border-gray-300 overflow-x-auto max-w-full text-xs font-medium">
          {([...(['board'] as const), ...(canRooms ? (['rooms'] as const) : []), ...(canManage ? (['templates'] as const) : []), ...(canManage ? (['report'] as const) : [])]).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 h-8 whitespace-nowrap flex-shrink-0 transition-colors ${view === v ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {v === 'board' ? tr.rr.boardTab : v === 'rooms' ? (lang === 'th' ? `ใบสั่ง${unitOne(unit, lang)}` : `${unitOne(unit, lang)} order`) : v === 'templates' ? tr.rr.templatesTab : tr.rr.reportTab}
            </button>
          ))}
        </div>
      </div>

      {view === 'rooms' && canRooms && companyId ? (
        <RoomOrderView companyId={companyId} initialDate={nav?.roomDate}
          initialMode={nav?.rrView === 'rooms' && !(profile?.role === 'super_admin' || profile?.department === 'front_office') ? 'fulfil' : undefined} />
      ) : view === 'templates' && canManage && companyId ? (
        <TemplatesView companyId={companyId} templates={templates}
          mutes={mutes} onMuteToggle={loadMutes} canManage={canManage} onChanged={load} />
      ) : view === 'report' && canManage && companyId ? (
        <ReportView companyId={companyId} companyName={activeCompany?.org_title || activeCompany?.name || ''}
          generatedBy={profile?.full_name ?? ''} statusLabel={statusLabel} templates={templates} />
      ) : (
        <>
          {/* Date picker row: ◀ Today ▶ */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <button onClick={() => setDate(shiftDate(date, -1))}
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex-1 text-center">
              <p className="text-sm font-semibold text-gray-900">{dateLabel}</p>
              {readOnly ? (
                <button onClick={() => setDate(today)} className="text-[11px] text-[var(--brand-primary)] hover:underline">
                  {tr.rr.readOnlyHint} · {tr.rr.todayBtn} →
                </button>
              ) : date === tomorrow ? (
                <p className="text-[11px] text-gray-400">{tr.rr.tomorrowBtn}</p>
              ) : (
                <p className="text-[11px] text-gray-400">{tr.rr.todayBtn}</p>
              )}
            </div>
            <button onClick={() => setDate(shiftDate(date, 1))}
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Quick chips: Today · Tomorrow */}
          <div className="flex items-center gap-2 mb-4">
            {([['today', today, tr.rr.todayBtn], ['tomorrow', tomorrow, tr.rr.tomorrowBtn]] as const).map(([k, d, label]) => (
              <button key={k} onClick={() => setDate(d)}
                className={`px-3 h-7 rounded-full border text-xs font-medium transition-colors ${
                  date === d ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                             : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Prompt banner: orders to place for tomorrow */}
          {showBanner && (
            <button onClick={() => setDate(tomorrow)}
              className="w-full mb-4 flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-left hover:bg-amber-100/70 transition-colors">
              <span className="text-sm font-medium text-amber-800">{tr.rr.toPlaceForTomorrow(tomorrowToPlace)}</span>
              <ArrowRight className="h-4 w-4 text-amber-700 flex-shrink-0" />
            </button>
          )}

          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          ) : templates.length === 0 && orders.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-200 px-6">
              <ClipboardList className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">{tr.rr.noTemplates}</p>
              <p className="text-xs text-gray-400 mt-1">{tr.rr.noTemplatesHint}</p>
              {canManage && (
                <button onClick={() => setView('templates')} className="mt-3 text-sm text-[var(--brand-primary)] font-medium">
                  {tr.rr.setupTemplates}
                </button>
              )}
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-200 text-sm text-gray-400">{tr.rr.noOrders}</div>
          ) : (
            <div className="space-y-5">
              {mine.length > 0 && (
                <section>
                  <h2 className="text-base font-semibold text-[var(--brand-primary)] mb-2">
                    {tr.rr.needsMyAction}<span className="ml-2 text-sm font-normal opacity-60">{mine.length}</span>
                  </h2>
                  <div className="space-y-2">
                    {mine.map((o) => (
                      <OrderCard key={o.id} order={o} title={displayTitle(o)} template={tplOf(o)}
                        rooms={rooms} statusLabel={statusLabel} readOnly={readOnly} canManage={canManage}
                        onRequestSide={onRequestSide(o)} muted={o.template_id ? mutes.has(o.template_id) : false}
                        onMuteToggle={loadMutes} notifyDept={notifyDept} onChanged={load} />
                    ))}
                  </div>
                </section>
              )}
              {rest.length > 0 && (
                <section>
                  {mine.length > 0 && (
                    <h2 className="text-base font-semibold text-gray-500 mb-2">
                      {tr.rr.otherOrders}<span className="ml-2 text-sm font-normal opacity-60">{rest.length}</span>
                    </h2>
                  )}
                  <div className="space-y-2">
                    {rest.map((o) => (
                      <OrderCard key={o.id} order={o} title={displayTitle(o)} template={tplOf(o)}
                        rooms={rooms} statusLabel={statusLabel} readOnly={readOnly} canManage={canManage}
                        onRequestSide={onRequestSide(o)} muted={o.template_id ? mutes.has(o.template_id) : false}
                        onMuteToggle={loadMutes} notifyDept={notifyDept} onChanged={load} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── order card ───────────────────────────────────────────────────────────────

function OrderCard({ order: o, title, template: tpl, rooms, statusLabel, readOnly, canManage,
  onRequestSide, muted, onMuteToggle, notifyDept, onChanged }: {
  order: RrOrder
  title: string
  template: RrTemplate | null
  rooms: string[]
  statusLabel: (s: RrOrderStatus) => string
  readOnly: boolean
  canManage: boolean
  onRequestSide: boolean
  muted: boolean
  onMuteToggle: () => void
  notifyDept: (dept: Department, title: string, message: string,
    opts?: { templateId?: string | null; picMode?: string | null; picIds?: string[] | null; useDeptConfig?: boolean }) => Promise<void>
  onChanged: () => void
}) {
  const { t: tr, lang } = useLanguage()
  const { profile } = useAuth()
  const [busy, setBusy] = useState(false)
  const [qty, setQty] = useState(o.quantity != null ? String(o.quantity) : '')
  const [roomsText, setRoomsText] = useState('')
  const [note, setNote] = useState(o.note ?? '')
  const [expanded, setExpanded] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  // Per-room grid selection: room_no -> variant code ('' = no variant).
  const [grid, setGrid] = useState<Record<string, string>>({})

  const variants = tpl?.variants ?? null
  const hasVariants = o.order_type === 'per_room_variants'
  const isPerRoom = o.order_type === 'per_room' || o.order_type === 'per_room_variants'
  const picMode = tpl?.pic_mode ?? 'department'
  const picIds = tpl?.pic_ids ?? []

  const onRequest = onRequestSide
  const onFulfill = canManage || profile?.department === o.fulfill_department
  const items = (o.items ?? []).slice().sort((a, b) => a.room_no.localeCompare(b.room_no, undefined, { numeric: true }))
  const deliveredCount = items.filter((i) => i.delivered).length
  const deptArrow = `${deptLabel(o.request_department, lang)} → ${deptLabel(o.fulfill_department, lang)}`
  const dueLabel = o.due_at ? fmtTime(o.due_at) : ''
  const unitOf = (n: number) => (o.unit_label ? `${n} ${o.unit_label}` : String(n))
  // The per-room checklist is shown while delivering, and as a read-only recap after.
  const showChecklist = isPerRoom && items.length > 0 &&
    (o.status === 'accepted' || o.status === 'delivered' || o.status === 'confirmed') &&
    (expanded || (o.status === 'accepted' && onFulfill && !readOnly))
  const canTickRooms = !readOnly && onFulfill && o.status === 'accepted'

  // Order-window labels (lead_days > 0 routines).
  const leadDays = Math.max(0, tpl?.lead_days ?? 0)
  const dayWord = leadDays > 0 ? tr.rr.tomorrow : tr.rr.today
  const closeLabel = tpl?.order_close ? tr.rr.orderByOn(hhmm(tpl.order_close), tr.rr.today) : ''
  const deliverLabel = dueLabel ? tr.rr.deliverByOn(dueLabel, dayWord) : ''
  // "Order window passed": now is past order_close on the placing day and still pending.
  const windowPassed = (() => {
    if (o.status !== 'pending' || !tpl?.order_close || leadDays === 0) return false
    const placeDay = shiftDate(o.order_date, -leadDays) // the day the order should be placed
    const closeTs = new Date(`${placeDay}T${tpl.order_close}`).getTime()
    return Date.now() > closeTs
  })()
  // "Late": delivered/confirmed after the due time.
  const lateAt = (ts: string | null) => !!(o.due_at && ts && new Date(ts).getTime() > new Date(o.due_at).getTime())
  const isLate = (o.status === 'delivered' || o.status === 'confirmed') &&
    lateAt(o.delivered_at) || lateAt(o.confirmed_at)

  // PIC display: department label, or assigned people's names.
  const [picNames, setPicNames] = useState<string[]>([])
  useEffect(() => {
    if (picMode !== 'users' || picIds.length === 0) { setPicNames([]); return }
    let stale = false
    supabase.from('kaizen_profiles').select('full_name').in('id', picIds).then(({ data }) => {
      if (stale) return
      setPicNames(((data as { full_name: string }[]) ?? []).map((p) => p.full_name))
    })
    return () => { stale = true }
  }, [picMode, picIds.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const now = () => new Date().toISOString()
  const itemSuffix = o.item_label ? ` — ${o.item_label}` : ''

  // Acknowledgement-timeline writer.
  async function logEvent(action: string, detail: string | null) {
    if (!profile) return
    await supabase.from('kaizen_rr_events').insert({
      company_id: o.company_id, order_id: o.id, actor_id: profile.id, action, detail,
    })
  }

  async function update(patch: Partial<RrOrder>, okMsg: string, ev: { action: string; detail: string | null },
    notify?: { dept: Department; title: string; message: string; useDeptConfig?: boolean }) {
    if (!profile) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_rr_orders').update(patch).eq('id', o.id)
    if (error) { setBusy(false); toast.error(error.message); return }
    await logEvent(ev.action, ev.detail)
    setBusy(false)
    if (notify) await notifyDept(notify.dept, notify.title, notify.message,
      { templateId: o.template_id, picMode, picIds, useDeptConfig: notify.useDeptConfig })
    toast.success(okMsg)
    onChanged()
  }

  async function sendOrder() {
    if (!profile) return
    if (o.order_type === 'bulk') {
      const n = Number(qty)
      if (!qty.trim() || !Number.isFinite(n) || n <= 0) { toast.error(tr.rr.quantityRequired); return }
      await update(
        { status: 'sent', quantity: n, note: note.trim() || null, sent_by: profile.id, sent_at: now() },
        tr.rr.orderSent,
        { action: 'sent', detail: `${unitOf(n)}${itemSuffix}` },
        { dept: o.fulfill_department, useDeptConfig: true,
          title: lang === 'th' ? 'มีออเดอร์ประจำเข้ามาใหม่' : 'Routine order received',
          message: lang === 'th'
            ? `"${o.title}"${itemSuffix} — ${unitOf(n)} จากแผนก ${deptLabel(o.request_department, lang)}`
            : `"${o.title}"${itemSuffix} — ${unitOf(n)} requested by ${deptLabel(o.request_department, lang)}` },
      )
    } else if (isPerRoom) {
      // Room grid: keys present in `grid` are the selected rooms; value is the variant code.
      const picked = Object.keys(grid)
      if (picked.length === 0) { toast.error(hasVariants ? tr.rr.noVariantRooms : tr.rr.roomsRequired); return }
      setBusy(true)
      const ins = await supabase.from('kaizen_rr_order_items').insert(
        picked.map((room) => ({
          order_id: o.id, company_id: o.company_id, room_no: room,
          item_label: o.item_label, variant: hasVariants ? (grid[room] || null) : null,
        }))
      )
      if (ins.error) { setBusy(false); toast.error(ins.error.message); return }
      setBusy(false)
      const roomsWord = lang === 'th' ? 'ห้อง' : 'rooms'
      const detail = hasVariants ? `${variantBreakdown(picked.map((r) => ({ variant: grid[r] } as RrOrderItem)), variants, lang)} · ${picked.length} ${roomsWord}` : `${picked.length} ${roomsWord}`
      await update(
        { status: 'sent', quantity: picked.length, note: note.trim() || null, sent_by: profile.id, sent_at: now() },
        tr.rr.orderSent,
        { action: 'sent', detail },
        { dept: o.fulfill_department, useDeptConfig: true,
          title: lang === 'th' ? 'มีออเดอร์ประจำเข้ามาใหม่' : 'Routine order received',
          message: lang === 'th'
            ? `"${o.title}"${itemSuffix} — ${picked.length} ห้อง จากแผนก ${deptLabel(o.request_department, lang)}`
            : `"${o.title}"${itemSuffix} — ${picked.length} rooms, requested by ${deptLabel(o.request_department, lang)}` },
      )
    }
  }

  async function acceptOrder() {
    await update(
      { status: 'accepted', accepted_by: profile!.id, accepted_at: now() },
      tr.rr.orderAccepted,
      { action: 'accepted', detail: null },
      { dept: o.request_department,
        title: lang === 'th' ? 'รับออเดอร์แล้ว' : 'Routine order accepted',
        message: lang === 'th'
          ? `"${o.title}"${itemSuffix} รับงานโดยแผนก ${deptLabel(o.fulfill_department, lang)}`
          : `"${o.title}"${itemSuffix} was accepted by ${deptLabel(o.fulfill_department, lang)}` },
    )
  }

  async function markDelivered() {
    await update(
      { status: 'delivered', delivered_by: profile!.id, delivered_at: now() },
      tr.rr.orderDelivered,
      { action: 'delivered', detail: null },
      { dept: o.request_department,
        title: lang === 'th' ? 'จัดส่งออเดอร์แล้ว' : 'Routine order delivered',
        message: lang === 'th'
          ? `"${o.title}"${itemSuffix} จัดส่งโดยแผนก ${deptLabel(o.fulfill_department, lang)}`
          : `"${o.title}"${itemSuffix} was delivered by ${deptLabel(o.fulfill_department, lang)}` },
    )
  }

  async function confirmReceived() {
    await update(
      { status: 'confirmed', confirmed_by: profile!.id, confirmed_at: now() },
      tr.rr.orderConfirmed,
      { action: 'confirmed', detail: null },
      { dept: o.fulfill_department, useDeptConfig: true,
        title: lang === 'th' ? 'ยืนยันการรับออเดอร์แล้ว' : 'Routine order confirmed',
        message: lang === 'th'
          ? `"${o.title}"${itemSuffix} ยืนยันการรับโดยแผนก ${deptLabel(o.request_department, lang)}`
          : `"${o.title}"${itemSuffix} receipt was confirmed by ${deptLabel(o.request_department, lang)}` },
    )
  }

  async function cancelOrder() {
    if (!confirm(tr.rr.confirmCancelOrder)) return
    await update({ status: 'cancelled' }, tr.rr.orderCancelled, { action: 'cancelled', detail: null })
  }

  async function deleteOrder() {
    if (!confirm(lang === 'th' ? 'ลบออเดอร์นี้? (สำหรับงานประจำที่ยังเปิดอยู่ ระบบอาจสร้างใหม่)' : 'Delete this order? (For an active routine it may regenerate — turn the template off to stop it.)')) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_rr_orders').delete().eq('id', o.id)
    setBusy(false)
    if (error) { toast.error(error.message); return }
    toast.success(lang === 'th' ? 'ลบแล้ว' : 'Order deleted')
    onChanged()
  }

  async function toggleRoom(it: RrOrderItem) {
    if (!profile || !canTickRooms || busy) return
    const delivered = !it.delivered
    setBusy(true)
    const { error } = await supabase.from('kaizen_rr_order_items').update({
      delivered, delivered_by: delivered ? profile.id : null, delivered_at: delivered ? now() : null,
    }).eq('id', it.id)
    if (error) { setBusy(false); toast.error(error.message); return }
    if (delivered) await logEvent('room_delivered', it.room_no)
    // Last room ticked → the whole order is delivered.
    const allDone = delivered && items.every((x) => (x.id === it.id ? delivered : x.delivered))
    if (allDone) {
      const { error: e2 } = await supabase.from('kaizen_rr_orders').update({
        status: 'delivered', delivered_by: profile.id, delivered_at: now(),
      }).eq('id', o.id)
      if (e2) toast.error(e2.message)
      else {
        await logEvent('delivered', null)
        await notifyDept(o.request_department,
          lang === 'th' ? 'จัดส่งออเดอร์แล้ว' : 'Routine order delivered',
          lang === 'th'
            ? `"${o.title}"${itemSuffix} — ครบทั้ง ${items.length} ห้อง โดยแผนก ${deptLabel(o.fulfill_department, lang)}`
            : `"${o.title}"${itemSuffix} — all ${items.length} rooms done by ${deptLabel(o.fulfill_department, lang)}`,
          { templateId: o.template_id, picMode, picIds })
        toast.success(tr.rr.orderDelivered)
      }
    }
    setBusy(false)
    onChanged()
  }

  async function toggleMute() {
    if (!profile || !tpl) return
    setBusy(true)
    const { error } = muted
      ? await supabase.from('kaizen_rr_mutes').delete().eq('user_id', profile.id).eq('template_id', tpl.id)
      : await supabase.from('kaizen_rr_mutes').insert({ company_id: o.company_id, user_id: profile.id, template_id: tpl.id })
    setBusy(false)
    if (error) { toast.error(tr.rr.muteToggleFailed); return }
    onMuteToggle()
  }

  // Timestamps line — only what happened.
  const stamps = [
    o.sent_at && `${tr.rr.sentAt} ${fmtTime(o.sent_at)}`,
    o.accepted_at && `${tr.rr.acceptedAt} ${fmtTime(o.accepted_at)}`,
    o.delivered_at && `${tr.rr.deliveredAt} ${fmtTime(o.delivered_at)}`,
    o.confirmed_at && `${tr.rr.confirmedAt} ${fmtTime(o.confirmed_at)}`,
  ].filter(Boolean).join(' · ')

  const actionBtnCls = 'flex items-center justify-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50'

  // PIC label for the meta line.
  const picLabel = picMode === 'users'
    ? (picNames.length > 0 ? picNames.join(', ') : tr.rr.personInCharge)
    : deptLabel(o.request_department, lang)

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-3">
      <div className="flex items-start gap-3">
        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1.5 ${STATUS_DOT[o.status]}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900">{title}</p>
            {o.item_label && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-gray-600">{o.item_label}</span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${STATUS_PILL[o.status]}`}>{statusLabel(o.status)}</span>
            {isLate && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-500">{tr.rr.lateTag}</span>}
          </div>
          <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-1 flex-wrap">
            <span>{deptArrow}</span>
            <span className="flex items-center gap-0.5">· <Users className="h-3 w-3" /> {picLabel}</span>
            {o.quantity != null && o.order_type === 'bulk' && <span>· {tr.rr.qty} {unitOf(o.quantity)}</span>}
            {isPerRoom && items.length > 0 && (
              <span className="flex items-center gap-0.5">· <BedDouble className="h-3 w-3" /> {tr.rr.roomsDone(deliveredCount, items.length)}</span>
            )}
          </p>
          {/* Order window + delivery deadline */}
          {(closeLabel || deliverLabel) && (
            <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1 flex-wrap">
              <Clock className="h-3 w-3" />
              <span>{[closeLabel, deliverLabel].filter(Boolean).join(' · ')}</span>
              {windowPassed && <span className="text-amber-600">· {tr.rr.windowPassed}</span>}
            </p>
          )}
          {/* Variant breakdown summary on sent+ variant orders */}
          {hasVariants && items.length > 0 && (
            <p className="text-[11px] text-gray-400 mt-0.5">{variantBreakdown(items, variants, lang)}</p>
          )}
          {o.note && <p className="text-[11px] text-gray-400 mt-0.5">{o.note}</p>}
          {stamps && <p className="text-[11px] text-gray-400 mt-1">{stamps}</p>}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {/* Mute bell — managers / super_admin only */}
          {canManage && tpl && (
            <button onClick={toggleMute} disabled={busy} title={muted ? tr.rr.unmuteRoutine : tr.rr.muteRoutine}
              className={`p-1.5 -m-1 rounded-lg hover:bg-gray-100 ${muted ? 'text-amber-500' : 'text-gray-400 hover:text-gray-600'}`}>
              {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
            </button>
          )}
          {/* Delete order — managers / super_admin only */}
          {canManage && (
            <button onClick={deleteOrder} disabled={busy} title={lang === 'th' ? 'ลบออเดอร์' : 'Delete order'}
              className="p-1.5 -m-1 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          {/* expand toggle for finished per-room checklists */}
          {isPerRoom && items.length > 0 && (o.status === 'delivered' || o.status === 'confirmed') && (
            <button onClick={() => setExpanded((v) => !v)} title={tr.rr.roomChecklist}
              className="p-1.5 -m-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100">
              <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* pending → requester fills quantity / room grid and sends */}
      {!readOnly && o.status === 'pending' && onRequest && (
        <div className="mt-3 pl-5 space-y-2">
          {o.order_type === 'bulk' ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500">{o.unit_label ? tr.rr.quantityUnit(o.unit_label) : tr.rr.quantity}</label>
              <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric" placeholder={tr.rr.quantityPh} className={inputCls + ' max-w-[160px]'} />
            </div>
          ) : rooms.length > 0 ? (
            <RoomGrid rooms={rooms} grid={grid} setGrid={setGrid} variants={hasVariants ? variants : null} />
          ) : (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500">{tr.rr.rooms}</label>
              <textarea value={roomsText} onChange={(e) => setRoomsText(e.target.value)} rows={4}
                placeholder={tr.rr.roomsPh} className={inputCls + ' h-auto py-2 resize-none'} />
              <p className="text-[11px] text-gray-400">{tr.rr.roomsHint}</p>
            </div>
          )}
          {/* Fallback text grid path: if no room list, parse the textarea on send. */}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr.rr.notePh} className={inputCls} />
          <button onClick={rooms.length > 0 || o.order_type === 'bulk' ? sendOrder : sendOrderFromText} disabled={busy} className={actionBtnCls}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{tr.rr.sendOrder}
          </button>
        </div>
      )}

      {/* sent → fulfilling dept accepts */}
      {!readOnly && o.status === 'sent' && onFulfill && (
        <div className="mt-3 pl-5">
          <button onClick={acceptOrder} disabled={busy} className={actionBtnCls}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{tr.rr.acceptOrder}
          </button>
        </div>
      )}

      {/* accepted bulk → mark delivered */}
      {!readOnly && o.status === 'accepted' && o.order_type === 'bulk' && onFulfill && (
        <div className="mt-3 pl-5">
          <button onClick={markDelivered} disabled={busy} className={actionBtnCls}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}{tr.rr.markDelivered}
          </button>
        </div>
      )}

      {/* per-room checklist (deliver ticks while accepted; recap when expanded later) */}
      {showChecklist && (
        <div className="mt-3 pl-5">
          <p className="text-xs font-semibold text-gray-500 mb-1.5">{tr.rr.roomChecklist}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {items.map((it) => {
              const v = it.variant ? variants?.find((x) => x.code === it.variant) : null
              const vLabel = v ? (lang === 'th' ? (v.label_th || v.label) : v.label) : it.variant
              return (
                <button key={it.id} onClick={() => toggleRoom(it)} disabled={!canTickRooms || busy}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    it.delivered ? 'border-teal-200 bg-teal-50' : 'border-gray-200 bg-white'
                  } ${canTickRooms ? 'hover:border-gray-300 cursor-pointer' : 'cursor-default'}`}>
                  <span className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                    it.delivered ? 'bg-teal-500 border-teal-500' : 'border-gray-300'}`}>
                    {it.delivered && <Check className="h-3 w-3 text-white" />}
                  </span>
                  <span className="text-sm font-medium text-gray-800">{it.room_no}</span>
                  {vLabel && <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200 flex-shrink-0">{vLabel}</span>}
                  {it.item_label && !vLabel && <span className="text-[11px] text-gray-500 truncate">{it.item_label}</span>}
                  {it.delivered_at && <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0">{fmtTime(it.delivered_at)}</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* delivered → requester confirms receipt */}
      {!readOnly && o.status === 'delivered' && onRequest && (
        <div className="mt-3 pl-5">
          <button onClick={confirmReceived} disabled={busy} className={actionBtnCls.replace('bg-[var(--brand-primary)]', 'bg-green-600')}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleCheck className="h-4 w-4" />}{tr.rr.confirmReceived}
          </button>
        </div>
      )}

      {/* manager-only cancel while the chain is still running */}
      {!readOnly && canManage && !['confirmed', 'cancelled'].includes(o.status) && (
        <div className="mt-2 pl-5">
          <button onClick={cancelOrder} disabled={busy}
            className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-600">
            <Ban className="h-3 w-3" />{tr.rr.cancelOrder}
          </button>
        </div>
      )}

      {/* acknowledgement timeline */}
      <div className="mt-2 pl-5">
        <button onClick={() => setShowTimeline((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-medium text-gray-400 hover:text-gray-600">
          <History className="h-3 w-3" />{tr.rr.timeline}
          <ChevronDown className={`h-3 w-3 transition-transform ${showTimeline ? 'rotate-180' : ''}`} />
        </button>
        {showTimeline && <OrderTimeline orderId={o.id} />}
      </div>
    </div>
  )

  // Fallback: parse the free-text rooms textarea (when no room list is configured).
  async function sendOrderFromText() {
    if (!profile) return
    const parsed = roomsText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((tok) => {
      const m = tok.match(/^([^:]+?)\s*:\s*(.+)$/)
      return m ? { room_no: m[1].trim(), item_label: m[2].trim() } : { room_no: tok, item_label: null as string | null }
    })
    if (parsed.length === 0) { toast.error(tr.rr.roomsRequired); return }
    setBusy(true)
    const ins = await supabase.from('kaizen_rr_order_items').insert(
      parsed.map((r) => ({ order_id: o.id, company_id: o.company_id, room_no: r.room_no, item_label: r.item_label, variant: null }))
    )
    if (ins.error) { setBusy(false); toast.error(ins.error.message); return }
    setBusy(false)
    await update(
      { status: 'sent', quantity: parsed.length, note: note.trim() || null, sent_by: profile.id, sent_at: now() },
      tr.rr.orderSent,
      { action: 'sent', detail: `${parsed.length} ${lang === 'th' ? 'ห้อง' : 'rooms'}` },
      { dept: o.fulfill_department,
        title: lang === 'th' ? 'มีออเดอร์ประจำเข้ามาใหม่' : 'Routine order received',
        message: lang === 'th'
          ? `"${o.title}"${itemSuffix} — ${parsed.length} ห้อง จากแผนก ${deptLabel(o.request_department, lang)}`
          : `"${o.title}"${itemSuffix} — ${parsed.length} rooms, requested by ${deptLabel(o.request_department, lang)}` },
    )
  }
}

// ── room grid (per-room send) ─────────────────────────────────────────────────

function RoomGrid({ rooms, grid, setGrid, variants }: {
  rooms: string[]
  grid: Record<string, string>
  setGrid: React.Dispatch<React.SetStateAction<Record<string, string>>>
  variants: RrVariant[] | null
}) {
  const { t: tr, lang } = useLanguage()
  const selected = Object.keys(grid)
  const codes = (variants ?? []).map((v) => v.code)
  const labelFor = (code: string) => {
    const v = variants?.find((x) => x.code === code)
    return v ? (lang === 'th' ? (v.label_th || v.label || v.code) : (v.label || v.code)) : code
  }

  function toggle(room: string) {
    setGrid((prev) => {
      const next = { ...prev }
      if (room in next) {
        if (variants && codes.length > 0) {
          // Cycle to next variant; wrap from last → unselected.
          const cur = next[room]
          const i = codes.indexOf(cur)
          if (i < codes.length - 1) next[room] = codes[i + 1]
          else delete next[room]
        } else {
          delete next[room]
        }
      } else {
        next[room] = variants && codes.length > 0 ? codes[0] : ''
      }
      return next
    })
  }

  // Summary like "V1×4 · V2×6 · 29 rooms".
  const summary = (() => {
    if (variants && codes.length > 0) {
      const counts = new Map<string, number>()
      selected.forEach((r) => counts.set(grid[r], (counts.get(grid[r]) ?? 0) + 1))
      const parts = codes.filter((c) => counts.get(c)).map((c) => `${labelFor(c)}×${counts.get(c)}`).join(' · ')
      return tr.rr.roomGridSummary(parts || '—', selected.length)
    }
    return `${selected.length} ${lang === 'th' ? 'ห้อง' : (selected.length === 1 ? 'room' : 'rooms')}`
  })()

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-gray-500">{tr.rr.pickRooms}</label>
        {selected.length > 0 && (
          <button onClick={() => setGrid({})} className="text-[11px] text-gray-400 hover:text-gray-600">{tr.rr.clearRooms}</button>
        )}
      </div>
      <p className="text-[11px] text-gray-400">{tr.rr.tapToAssign}</p>
      <div className="flex flex-wrap gap-1.5 max-h-56 overflow-y-auto p-0.5">
        {rooms.map((room) => {
          const on = room in grid
          return (
            <button key={room} type="button" onClick={() => toggle(room)}
              className={`px-2 h-8 rounded-lg border text-xs font-medium transition-colors flex items-center gap-1 ${
                on ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                   : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
              {room}
              {on && variants && grid[room] && (
                <span className="text-[10px] px-1 rounded bg-white/25">{labelFor(grid[room])}</span>
              )}
            </button>
          )
        })}
      </div>
      <p className="text-[11px] font-medium text-gray-600">{summary}</p>
    </div>
  )
}

// ── order acknowledgement timeline ────────────────────────────────────────────

function OrderTimeline({ orderId }: { orderId: string }) {
  const { t: tr } = useLanguage()
  const [events, setEvents] = useState<(RrEvent & { actor?: { full_name: string } | null })[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stale = false
    ;(async () => {
      setLoading(true)
      const { data } = await supabase.from('kaizen_rr_events')
        .select('*, actor:kaizen_profiles!kaizen_rr_events_actor_id_fkey(full_name)')
        .eq('order_id', orderId).order('created_at', { ascending: false })
      if (stale) return
      setEvents((data as (RrEvent & { actor?: { full_name: string } | null })[]) ?? [])
      setLoading(false)
    })()
    return () => { stale = true }
  }, [orderId])

  const actionLabel = (a: string): string => ({
    sent: tr.rr.evSent, accepted: tr.rr.evAccepted, delivered: tr.rr.evDelivered,
    confirmed: tr.rr.evConfirmed, cancelled: tr.rr.evCancelled, room_delivered: tr.rr.evRoomDelivered,
    pic_changed: tr.rr.evPicChanged,
  } as Record<string, string>)[a] ?? a

  if (loading) return <div className="mt-1.5 flex justify-center py-2"><Loader2 className="h-4 w-4 animate-spin text-gray-300" /></div>
  if (events.length === 0) return <p className="mt-1.5 text-[11px] text-gray-400">{tr.rr.timelineEmpty}</p>

  return (
    <ul className="mt-1.5 space-y-1">
      {events.map((e) => {
        const who = e.actor?.full_name || tr.rr.someone
        const verb = actionLabel(e.action)
        const what = e.action === 'room_delivered' && e.detail
          ? `${who} ${verb} ${e.detail}`
          : `${who} ${verb}${e.detail ? ` ${e.detail}` : ''}`
        return (
          <li key={e.id} className="text-[11px] text-gray-500 flex items-baseline gap-1.5">
            <span className="w-1 h-1 rounded-full bg-gray-300 flex-shrink-0 mt-1.5" />
            <span className="flex-1">{what}</span>
            <span className="text-gray-400 flex-shrink-0">{fmtTime(e.created_at)}</span>
          </li>
        )
      })}
    </ul>
  )
}

// ── templates view (managers) ────────────────────────────────────────────────

function TemplatesView({ companyId, templates, mutes, onMuteToggle, canManage, onChanged }: {
  companyId: string; templates: RrTemplate[]
  mutes: Set<string>; onMuteToggle: () => void; canManage: boolean; onChanged: () => void
}) {
  const { t: tr, lang } = useLanguage()
  const { profile } = useAuth()
  const [editor, setEditor] = useState<RrTemplate | 'new' | null>(null)

  const orderTypeLabel = (t: RrOrderType) =>
    t === 'per_room_variants' ? tr.rr.perRoomVariantsShort : t === 'per_room' ? tr.rr.perRoomShort : tr.rr.bulkShort

  async function toggleActive(tpl: RrTemplate) {
    const { error } = await supabase.from('kaizen_rr_templates').update({ active: !tpl.active }).eq('id', tpl.id)
    if (error) toast.error(error.message); else onChanged()
  }

  async function toggleMute(tpl: RrTemplate) {
    if (!profile) return
    const isMuted = mutes.has(tpl.id)
    const { error } = isMuted
      ? await supabase.from('kaizen_rr_mutes').delete().eq('user_id', profile.id).eq('template_id', tpl.id)
      : await supabase.from('kaizen_rr_mutes').insert({ company_id: companyId, user_id: profile.id, template_id: tpl.id })
    if (error) { toast.error(tr.rr.muteToggleFailed); return }
    onMuteToggle()
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={() => setEditor('new')}
          className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-2 rounded-lg">
          <Plus className="h-4 w-4" />{tr.rr.addTemplate}
        </button>
      </div>
      {templates.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200 px-6">
          <ClipboardList className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">{tr.rr.noTemplates}</p>
          <p className="text-xs text-gray-400 mt-1">{tr.rr.noTemplatesHint}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((tpl) => (
            <div key={tpl.id} className={`flex items-center gap-3 bg-white border border-gray-200 rounded-xl p-3 ${tpl.active ? '' : 'opacity-60'}`}>
              <button onClick={() => toggleActive(tpl)} title={tpl.active ? tr.rr.activeLabel : tr.rr.inactiveBadge}
                className={`w-9 h-5 rounded-full flex-shrink-0 transition-colors relative ${tpl.active ? 'bg-[var(--brand-primary)]' : 'bg-gray-300'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${tpl.active ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-gray-900 truncate">{lang === 'th' && tpl.name_th ? tpl.name_th : tpl.name}</p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-gray-600">
                    {orderTypeLabel(tpl.order_type)}
                  </span>
                  {(tpl.lead_days ?? 0) > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-600">{tr.rr.leadDayBefore}</span>}
                  {!tpl.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-400">{tr.rr.inactiveBadge}</span>}
                </div>
                <p className="text-[11px] text-gray-500 truncate mt-0.5 flex items-center gap-1">
                  {deptLabel(tpl.request_department, lang)}
                  <ArrowRight className="h-3 w-3" />
                  {deptLabel(tpl.fulfill_department, lang)}
                  <span>· {tr.rr.due} {(tpl.due_time || '').slice(0, 5)}</span>
                  {tpl.run_weekdays && tpl.run_weekdays.length > 0 && tpl.run_weekdays.length < 7 && (
                    <span>· {RUN_WD.filter((d) => tpl.run_weekdays!.includes(d)).map((d) => (lang === 'th' ? WD_LABEL_TH : WD_LABEL_EN)[d]).join(' ')}</span>
                  )}
                  {tpl.default_item && <span>· {tpl.default_item}</span>}
                </p>
              </div>
              {canManage && (
                <button onClick={() => toggleMute(tpl)} title={mutes.has(tpl.id) ? tr.rr.unmuteRoutine : tr.rr.muteRoutine}
                  className={`p-1.5 -m-1 rounded-lg hover:bg-gray-100 flex-shrink-0 ${mutes.has(tpl.id) ? 'text-amber-500' : 'text-gray-400 hover:text-gray-600'}`}>
                  {mutes.has(tpl.id) ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                </button>
              )}
              <button onClick={() => setEditor(tpl)} title={tr.rr.editTemplate}
                className="p-1.5 -m-1 rounded-lg text-gray-400 hover:text-[var(--brand-primary)] hover:bg-gray-100 flex-shrink-0 transition-colors">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {editor && (
        <TemplateEditor companyId={companyId} template={editor === 'new' ? null : editor} sortNext={templates.length}
          onClose={() => setEditor(null)} onSaved={() => { setEditor(null); onChanged() }} />
      )}
    </div>
  )
}

function TemplateEditor({ companyId, template, sortNext, onClose, onSaved }: {
  companyId: string; template: RrTemplate | null; sortNext: number
  onClose: () => void; onSaved: () => void
}) {
  const { t: tr, lang } = useLanguage()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({
    name: template?.name ?? '', name_th: template?.name_th ?? '',
    request_department: template?.request_department ?? ('front_office' as Department),
    fulfill_department: template?.fulfill_department ?? ('restaurant' as Department),
    due_time: (template?.due_time ?? '12:00').slice(0, 5),
    run_weekdays: (template?.run_weekdays && template.run_weekdays.length > 0) ? template.run_weekdays : [...RUN_WD],
    active: template?.active ?? true,
    lead_days: template?.lead_days ?? 0,
    order_open: hhmm(template?.order_open) || '20:00',
    order_close: hhmm(template?.order_close) || '22:00',
    remind_at: hhmm(template?.remind_at),
    pic_mode: (template?.pic_mode ?? 'department') as 'department' | 'users',
    pic_ids: template?.pic_ids ?? [],
  })
  const [picCandidates, setPicCandidates] = useState<{ id: string; full_name: string; role: string; job_title: string | null }[]>([])
  const [rrItems, setRrItems] = useState<RrItem[]>([])
  const [catalogItems, setCatalogItems] = useState<{ label: string; unit: string }[]>(template?.catalog_items ?? [])
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }))

  // Load RR item catalog from settings once.
  useEffect(() => {
    let stale = false
    supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_items').maybeSingle()
      .then(({ data }) => {
        if (stale) return
        setRrItems(Array.isArray(data?.value) ? (data!.value as RrItem[]) : [])
      })
    return () => { stale = true }
  }, [companyId])
  // PIC candidates = active staff/managers in the REQUESTING department, minus Owner.
  useEffect(() => {
    let stale = false
    supabase.from('kaizen_profiles').select('id, full_name, role, job_title')
      .eq('company_id', companyId).eq('is_active', true).is('deleted_at', null)
      .eq('department', f.request_department)
      .in('role', ['staff', 'manager'])
      .order('role', { ascending: false }).order('full_name')
      .then(({ data }) => {
        if (stale) return
        setPicCandidates(((data as { id: string; full_name: string; role: string; job_title: string | null }[]) ?? [])
          .filter((p) => p.job_title !== 'Owner'))
      })
    return () => { stale = true }
  }, [companyId, f.request_department])

  async function save() {
    if (!f.name.trim()) { toast.error(tr.rr.nameRequired); return }
    if (f.request_department === f.fulfill_department) { toast.error(tr.rr.sameDeptError); return }
    const cleanPics = f.pic_ids.filter((id) => picCandidates.some((c) => c.id === id))
    if (f.pic_mode === 'users' && cleanPics.length === 0) { toast.error(tr.rr.picNoneSelected); return }
    if (f.run_weekdays.length === 0) { toast.error(lang === 'th' ? 'เลือกอย่างน้อยหนึ่งวัน' : 'Select at least one day'); return }
    setBusy(true)
    const row = {
      company_id: companyId, name: f.name.trim(), name_th: f.name_th.trim() || null,
      request_department: f.request_department, fulfill_department: f.fulfill_department,
      order_type: 'bulk' as RrOrderType, due_time: f.due_time || '12:00',
      default_item: null,
      catalog_items: catalogItems.length > 0 ? catalogItems : null,
      item_by_weekday: null,
      run_weekdays: f.run_weekdays.length === 7 ? null : f.run_weekdays,
      active: f.active, sort_order: template?.sort_order ?? sortNext,
      unit_label: null,
      lead_days: f.lead_days,
      order_open: f.lead_days > 0 ? (f.order_open || null) : null,
      order_close: f.lead_days > 0 ? (f.order_close || null) : null,
      remind_at: f.remind_at || null,
      variants: null,
      pic_mode: f.pic_mode,
      pic_ids: f.pic_mode === 'users' ? cleanPics : null,
    }
    const res = template
      ? await supabase.from('kaizen_rr_templates').update(row).eq('id', template.id)
      : await supabase.from('kaizen_rr_templates').insert(row)
    setBusy(false)
    if (res.error) toast.error(res.error.message)
    else { toast.success(template ? tr.rr.templateSaved : tr.rr.templateAdded); onSaved() }
  }

  async function remove() {
    if (!template || !confirm(tr.rr.confirmDeleteTemplate)) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_rr_templates').delete().eq('id', template.id)
    setBusy(false)
    if (error) toast.error(error.message)
    else { toast.success(tr.rr.templateDeleted); onSaved() }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">{template ? tr.rr.editTemplate : tr.rr.newTemplate}</h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <Field label={`${tr.rr.name} *`}>
            <input value={f.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder={tr.rr.namePh} autoFocus />
          </Field>
          <Field label={tr.rr.nameTh}>
            <input value={f.name_th} onChange={(e) => set({ name_th: e.target.value })} className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.rr.requestDept}>
              <select value={f.request_department} onChange={(e) => set({ request_department: e.target.value as Department })} className={inputCls}>
                {(Object.keys(DEPARTMENT_LABELS) as Department[]).map((d) => <option key={d} value={d}>{deptLabel(d, lang)}</option>)}
              </select>
            </Field>
            <Field label={tr.rr.fulfillDept}>
              <select value={f.fulfill_department} onChange={(e) => set({ fulfill_department: e.target.value as Department })} className={inputCls}>
                {(Object.keys(DEPARTMENT_LABELS) as Department[]).map((d) => <option key={d} value={d}>{deptLabel(d, lang)}</option>)}
              </select>
            </Field>
          </div>

          <Field label={tr.rr.dueTime}>
            <input type="time" value={f.due_time} onChange={(e) => set({ due_time: e.target.value })} className={inputCls + ' max-w-[160px]'} />
          </Field>

          {/* Run on which days — controls how often the routine generates an order */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500">{lang === 'th' ? 'ทำในวัน' : 'Runs on'}</label>
              <button type="button"
                onClick={() => set({ run_weekdays: f.run_weekdays.length === 7 ? [] : [...RUN_WD] })}
                className="text-[11px] font-medium text-[var(--brand-primary)] hover:underline">
                {f.run_weekdays.length === 7 ? (lang === 'th' ? 'ล้างทั้งหมด' : 'Clear') : (lang === 'th' ? 'ทุกวัน' : 'Every day')}
              </button>
            </div>
            <div className="flex gap-1">
              {RUN_WD.map((d) => {
                const on = f.run_weekdays.includes(d)
                return (
                  <button key={d} type="button"
                    onClick={() => set({ run_weekdays: on ? f.run_weekdays.filter((x) => x !== d) : [...f.run_weekdays, d] })}
                    className={`flex-1 h-8 rounded-lg text-xs font-medium border transition-colors ${on ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]' : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'}`}>
                    {(lang === 'th' ? WD_LABEL_TH : WD_LABEL_EN)[d]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Department item catalog — add items with unit */}
          {(() => {
            const deptItems = rrItems.filter((it) => it.department === f.fulfill_department)
            if (deptItems.length === 0) return null
            return (
              <DeptItemPicker
                items={deptItems}
                catalogItems={catalogItems}
                onAdd={(label) => setCatalogItems((prev) => [...prev, { label, unit: '' }])}
                onRemove={(idx) => setCatalogItems((prev) => prev.filter((_, i) => i !== idx))}
                lang={lang}
                deptLabel={deptLabel(f.fulfill_department, lang)}
              />
            )
          })()}

          {/* Order-ahead scheduling */}
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.rr.leadDays}>
              <select value={String(f.lead_days)} onChange={(e) => set({ lead_days: Number(e.target.value) })} className={inputCls}>
                <option value="0">{tr.rr.leadSameDay}</option>
                <option value="1">{tr.rr.leadDayBefore}</option>
              </select>
            </Field>
            <Field label={tr.rr.remindAt}>
              <input type="time" value={f.remind_at} onChange={(e) => set({ remind_at: e.target.value })} className={inputCls} />
            </Field>
          </div>
          {f.lead_days > 0 && (
            <div className="grid grid-cols-2 gap-2.5">
              <Field label={tr.rr.orderOpen}>
                <input type="time" value={f.order_open} onChange={(e) => set({ order_open: e.target.value })} className={inputCls} />
              </Field>
              <Field label={tr.rr.orderClose}>
                <input type="time" value={f.order_close} onChange={(e) => set({ order_close: e.target.value })} className={inputCls} />
              </Field>
            </div>
          )}

          {/* Person in charge (request side) */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-500">{tr.rr.personInCharge}</label>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs font-medium">
              {(['department', 'users'] as const).map((m) => (
                <button key={m} type="button" onClick={() => set({ pic_mode: m })}
                  className={`flex-1 px-3 h-8 transition-colors ${f.pic_mode === m ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                  {m === 'department' ? tr.rr.picWholeDept : tr.rr.picSpecificPeople}
                </button>
              ))}
            </div>
            {f.pic_mode === 'users' && (
              <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-50">
                {picCandidates.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">{tr.rr.picSelectPeople}</p>}
                {picCandidates.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-50">
                    <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--brand-primary)]"
                      checked={f.pic_ids.includes(p.id)}
                      onChange={() => set({ pic_ids: f.pic_ids.includes(p.id) ? f.pic_ids.filter((x) => x !== p.id) : [...f.pic_ids, p.id] })} />
                    <span className="text-xs text-gray-800 flex-1">{p.full_name}</span>
                    {p.role === 'manager' && <span className="text-[10px] text-gray-400">{tr.roles.manager}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} className="accent-[var(--brand-primary)]" />
            {tr.rr.activeLabel}
          </label>
        </div>
        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200">
          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{tr.rr.save}
          </button>
          <button onClick={onClose} className="px-3 h-9 rounded-lg text-gray-500 hover:bg-gray-100 text-sm">{tr.rr.cancel}</button>
          {template && (
            <button onClick={remove} disabled={busy} className="ml-auto flex items-center gap-1.5 px-3 h-9 rounded-lg text-red-500 hover:bg-red-50 text-sm">
              <Trash2 className="h-4 w-4" />{tr.rr.delete}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-gray-500">{label}</label>{children}</div>
}

// ── Dept item picker — add catalog items ──────────────────────────────────────

function DeptItemPicker({ items, catalogItems, onAdd, onRemove, lang, deptLabel }: {
  items: import('@/components/RRSettings').RrItem[]
  catalogItems: { label: string; unit: string }[]
  onAdd: (label: string) => void
  onRemove: (index: number) => void
  lang: 'en' | 'th'
  deptLabel: string
}) {
  const [pick, setPick] = useState('')

  useEffect(() => { setPick('') }, [deptLabel])

  function handleAdd() {
    if (!pick) return
    if (!catalogItems.some((c) => c.label === pick)) onAdd(pick)
    setPick('')
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3 space-y-2">
      <p className="text-[11px] font-medium text-gray-500">
        {lang === 'th' ? 'รายการจากแผนก' : 'Items from'} {deptLabel}
      </p>
      <div className="flex gap-2">
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="flex-1 h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40 bg-white"
        >
          <option value="">{lang === 'th' ? '— เลือกรายการ —' : '— Select item —'}</option>
          {items.map((it, i) => {
            const label = it.code ? `${it.code} — ${it.description}` : it.description
            return (
              <option key={i} value={label} disabled={catalogItems.some((c) => c.label === label)}>
                {it.code ? `${it.code}  ${it.description}` : it.description}
              </option>
            )
          })}
        </select>
        <button
          type="button"
          disabled={!pick}
          onClick={handleAdd}
          className="h-9 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium disabled:opacity-40 flex-shrink-0"
        >
          {lang === 'th' ? 'เพิ่ม' : 'Add'}
        </button>
      </div>
      {catalogItems.length > 0 && (
        <div className="space-y-1.5 pt-1 border-t border-gray-200 mt-2">
          {catalogItems.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="flex-1 text-xs text-gray-700 truncate">{item.label}</span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="h-8 px-2.5 rounded-md text-red-500 text-xs font-medium hover:bg-red-50 flex-shrink-0"
              >
                {lang === 'th' ? 'ลบ' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Generate Report — period summary of requested items, for Accounting ──────

function startOfWeek(key: string): string {
  const d = new Date(key + 'T00:00:00')
  const dow = d.getDay() === 0 ? 6 : d.getDay() - 1 // Monday-first
  d.setDate(d.getDate() - dow)
  return dateKey(d)
}

function ReportView({ companyId, companyName, generatedBy, statusLabel, templates }: {
  companyId: string
  companyName: string
  generatedBy: string
  statusLabel: (s: RrOrderStatus) => string
  templates: RrTemplate[]
}) {
  const { t: tr, lang } = useLanguage()
  const [mode, setMode] = useState<'daily' | 'weekly'>('daily')
  const [anchor, setAnchor] = useState(() => dateKey(new Date()))
  const [rows, setRows] = useState<RrOrder[]>([])
  const [loading, setLoading] = useState(true)
  // Room-order data for the same period.
  const [roomLines, setRoomLines] = useState<{ item: string | null; fulfill_department: string; status: string }[]>([])
  const [roomStatusCounts, setRoomStatusCounts] = useState<Record<string, number>>({})
  const [roomDays, setRoomDays] = useState(0)

  const from = mode === 'daily' ? anchor : startOfWeek(anchor)
  const to = mode === 'daily' ? anchor : shiftDate(startOfWeek(anchor), 6)

  useEffect(() => {
    let stale = false
    ;(async () => {
      setLoading(true)
      const { data, error } = await supabase.from('kaizen_rr_orders')
        .select('*, items:kaizen_rr_order_items(*)')
        .eq('company_id', companyId).neq('status', 'cancelled')
        .gte('order_date', from).lte('order_date', to)
        .order('order_date').order('due_at', { ascending: true, nullsFirst: false })
      if (stale) return
      if (error) toast.error(error.message)
      setRows((data as RrOrder[]) ?? [])
      setLoading(false)
    })()
    return () => { stale = true }
  }, [companyId, from, to])

  // Room-order aggregation for the period: submitted orders → status breakdown + per-dept items.
  useEffect(() => {
    let stale = false
    ;(async () => {
      const { data: orders } = await supabase.from('kaizen_rr_room_orders')
        .select('id, room_statuses').eq('company_id', companyId).eq('status', 'submitted')
        .gte('order_date', from).lte('order_date', to)
      const oList = (orders as { id: string; room_statuses: Record<string, string> | null }[]) ?? []
      const sc: Record<string, number> = { checkin: 0, occupied: 0, empty: 0, oo: 0 }
      oList.forEach((o) => Object.values(o.room_statuses ?? {}).forEach((s) => { if (sc[s] !== undefined) sc[s]++ }))
      let lines: { item: string | null; fulfill_department: string; status: string }[] = []
      if (oList.length > 0) {
        const { data } = await supabase.from('kaizen_rr_room_lines')
          .select('item, fulfill_department, status').in('room_order_id', oList.map((o) => o.id))
          .eq('active', true).in('approval_status', ['approved', 'auto'])
        lines = (data as typeof lines) ?? []
      }
      if (stale) return
      setRoomStatusCounts(sc)
      setRoomLines(lines)
      setRoomDays(oList.length)
    })()
    return () => { stale = true }
  }, [companyId, from, to])

  const variantsOf = (o: RrOrder) => templates.find((tp) => tp.id === o.template_id)?.variants ?? null
  // Quantity of an order: bulk = quantity; per-room = number of rooms.
  const qtyOf = (o: RrOrder) => o.order_type === 'bulk' ? (o.quantity ?? 0) : (o.items?.length ?? 0)
  // Displayed qty: bulk shows the unit; per-room shows the room count.
  const qtyText = (o: RrOrder) => o.order_type === 'bulk' && o.unit_label ? `${o.quantity ?? 0} ${o.unit_label}` : String(qtyOf(o))
  // Variant breakdown for per-room-with-variants orders (else '—').
  const variantText = (o: RrOrder) => o.order_type === 'per_room_variants' && o.items?.length
    ? variantBreakdown(o.items, variantsOf(o), lang) : '—'

  // Totals per item label (falls back to the routine title).
  const summary = rows.reduce<Record<string, number>>((acc, o) => {
    const k = o.item_label || o.title
    acc[k] = (acc[k] ?? 0) + qtyOf(o)
    return acc
  }, {})

  const fmtDay = (key: string) => new Date(key + 'T00:00:00').toLocaleDateString(
    lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  const periodLabel = mode === 'daily' ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`

  // Room-order aggregation: items per department (with delivered count) + status names.
  const roomItemsTmp: Record<string, Record<string, { total: number; done: number }>> = {}
  roomLines.forEach((l) => {
    const item = (l.item && l.item.trim()) || '—'
    const byItem = (roomItemsTmp[l.fulfill_department] ||= {})
    const cell = (byItem[item] ||= { total: 0, done: 0 })
    cell.total++
    if (l.status === 'done') cell.done++
  })
  const roomItemsByDept: Record<string, { item: string; total: number; done: number }[]> = {}
  Object.entries(roomItemsTmp).forEach(([dept, items]) => {
    roomItemsByDept[dept] = Object.entries(items).map(([item, v]) => ({ item, ...v })).sort((a, b) => b.total - a.total)
  })
  const roomDeptKeys = (Object.keys(roomItemsByDept) as Department[]).sort((a, b) => deptLabel(a, lang).localeCompare(deptLabel(b, lang)))
  const hasRoomData = roomDays > 0
  const roomStatusName = (s: string) => lang === 'th'
    ? ({ checkin: 'เช็คอิน', occupied: 'มีผู้เข้าพัก', empty: 'ว่าง', oo: 'งดใช้งาน' } as Record<string, string>)[s] ?? s
    : ({ checkin: 'Check-in', occupied: 'Occupied', empty: 'Empty', oo: 'Out of order' } as Record<string, string>)[s] ?? s

  function printReport() {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const rowsHtml = rows.map((o) => `
      <tr>
        <td>${esc(fmtDay(o.order_date))}</td>
        <td>${esc(o.title)}</td>
        <td>${esc(o.item_label ?? '—')}</td>
        <td style="text-align:right">${esc(qtyText(o))}</td>
        <td>${esc(variantText(o))}</td>
        <td>${esc(deptLabel(o.request_department, lang))}</td>
        <td>${esc(deptLabel(o.fulfill_department, lang))}</td>
        <td>${esc(statusLabel(o.status))}</td>
      </tr>`).join('')
    const summaryHtml = Object.entries(summary).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td style="text-align:right">${v}</td></tr>`).join('')
    const routineHtml = rows.length > 0 ? `
      <table><thead><tr>
        <th>${esc(tr.rr.reportDate)}</th><th>${esc(tr.rr.reportRoutine)}</th><th>${esc(tr.rr.reportItem)}</th>
        <th style="text-align:right">${esc(tr.rr.reportQty)}</th><th>${esc(tr.rr.reportVariants)}</th><th>${esc(tr.rr.reportFrom)}</th>
        <th>${esc(tr.rr.reportTo)}</th><th>${esc(tr.rr.reportStatus)}</th>
      </tr></thead><tbody>${rowsHtml}</tbody></table>
      <h2>${esc(tr.rr.reportSummary)}</h2>
      <table style="max-width:380px"><thead><tr><th>${esc(tr.rr.reportItem)}</th><th style="text-align:right">${esc(tr.rr.reportTotal)}</th></tr></thead>
      <tbody>${summaryHtml}</tbody></table>` : ''
    // Room-order section
    const roomHtml = hasRoomData ? `
      <h2>${esc(lang === 'th' ? 'ใบสั่งห้อง' : 'Room orders')} <span style="font-weight:400;color:#888;font-size:12px">(${roomDays} ${esc(lang === 'th' ? 'วัน' : 'days')})</span></h2>
      <table style="max-width:420px"><thead><tr><th>${esc(lang === 'th' ? 'สถานะห้อง' : 'Room status')}</th><th style="text-align:right">${esc(tr.rr.reportTotal)}</th></tr></thead>
      <tbody>${(['checkin', 'occupied', 'empty', 'oo'] as const).map((s) => `<tr><td>${esc(roomStatusName(s))}</td><td style="text-align:right">${roomStatusCounts[s] ?? 0}</td></tr>`).join('')}</tbody></table>
      ${roomDeptKeys.map((dept) => `
        <h3 style="font-size:12px;margin:14px 0 4px;color:#444">${esc(deptLabel(dept, lang))}</h3>
        <table style="max-width:420px"><thead><tr><th>${esc(tr.rr.reportItem)}</th><th style="text-align:right">${esc(tr.rr.reportTotal)}</th><th style="text-align:right">${esc(lang === 'th' ? 'เสร็จ' : 'Done')}</th></tr></thead>
        <tbody>${roomItemsByDept[dept].map((it) => `<tr><td>${esc(it.item)}</td><td style="text-align:right">${it.total}</td><td style="text-align:right">${it.done}</td></tr>`).join('')}</tbody></table>`).join('')}` : ''
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(tr.rr.reportTitle)}</title>
      <style>
        body{font-family:'Sarabun','Helvetica Neue',sans-serif;font-size:13px;color:#111;padding:32px;max-width:800px;margin:0 auto}
        h1{font-size:18px;margin:0 0 2px} .sub{color:#666;font-size:12px;margin-bottom:18px}
        table{width:100%;border-collapse:collapse;margin-bottom:24px}
        th{background:#f3f4f6;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#555}
        th,td{border:1px solid #e5e7eb;padding:6px 10px}
        h2{font-size:14px;margin:18px 0 8px}
        .foot{color:#888;font-size:11px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:8px}
        @media print{body{padding:0}}
      </style></head><body>
      <h1>${esc(companyName)} — ${esc(tr.rr.reportTitle)}</h1>
      <p class="sub">${esc(tr.rr.reportPeriod)}: ${esc(periodLabel)} · ${esc(tr.rr.reportForAccounting)}</p>
      ${routineHtml}
      ${roomHtml}
      <p class="foot">${esc(tr.rr.reportGeneratedBy)}: ${esc(generatedBy)} · ${esc(tr.rr.reportGeneratedAt)}: ${new Date().toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB')}</p>
      <script>window.onload = () => window.print()</` + `script></body></html>`)
    w.document.close()
  }

  return (
    <div className="space-y-4">
      {/* Period controls */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3 flex-wrap">
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs font-medium">
          {(['daily', 'weekly'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-3 h-8 transition-colors ${mode === m ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {m === 'daily' ? tr.rr.reportDaily : tr.rr.reportWeekly}
            </button>
          ))}
        </div>
        <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)}
          className="h-8 rounded-lg border border-gray-300 px-2 text-sm" />
        <span className="text-xs text-gray-500 flex-1 min-w-[120px]">{periodLabel}</span>
        <button onClick={printReport} disabled={loading || (rows.length === 0 && !hasRoomData)}
          className="h-8 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-semibold disabled:opacity-40">
          {tr.rr.reportPrint}
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : (rows.length === 0 && !hasRoomData) ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200 text-sm text-gray-400">{tr.rr.reportNoData}</div>
      ) : (
        <>
          {rows.length > 0 && (
          <>
          {/* Orders table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="text-left px-3 py-2 font-semibold">{tr.rr.reportDate}</th>
                  <th className="text-left px-3 py-2 font-semibold">{tr.rr.reportRoutine}</th>
                  <th className="text-left px-3 py-2 font-semibold">{tr.rr.reportItem}</th>
                  <th className="text-right px-3 py-2 font-semibold">{tr.rr.reportQty}</th>
                  <th className="text-left px-3 py-2 font-semibold">{tr.rr.reportVariants}</th>
                  <th className="text-left px-3 py-2 font-semibold">{tr.rr.reportFrom}</th>
                  <th className="text-left px-3 py-2 font-semibold">{tr.rr.reportTo}</th>
                  <th className="text-left px-3 py-2 font-semibold">{tr.rr.reportStatus}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDay(o.order_date)}</td>
                    <td className="px-3 py-2 font-medium text-gray-900">{o.title}</td>
                    <td className="px-3 py-2 text-gray-600">{o.item_label ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-gray-900 font-medium">{qtyText(o)}</td>
                    <td className="px-3 py-2 text-gray-600">{variantText(o)}</td>
                    <td className="px-3 py-2 text-gray-600">{deptLabel(o.request_department, lang)}</td>
                    <td className="px-3 py-2 text-gray-600">{deptLabel(o.fulfill_department, lang)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-medium ${STATUS_PILL[o.status]}`}>{statusLabel(o.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Summary by item */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">{tr.rr.reportSummary}</h3>
            <div className="divide-y divide-gray-100">
              {Object.entries(summary).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between py-1.5 text-sm">
                  <span className="text-gray-600">{k}</span>
                  <span className="font-semibold text-gray-900">{v}</span>
                </div>
              ))}
            </div>
          </div>
          </>
          )}

          {/* ── Room orders ── */}
          {hasRoomData && (
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-gray-900">{lang === 'th' ? 'ใบสั่งห้อง' : 'Room orders'}</h3>
                <span className="text-[11px] text-gray-400">{roomDays} {lang === 'th' ? 'วัน' : roomDays === 1 ? 'day' : 'days'}</span>
              </div>

              {/* Room-status breakdown */}
              <div className="flex flex-wrap gap-2">
                {(['checkin', 'occupied', 'empty', 'oo'] as const).map((s) => (
                  <div key={s} className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1">
                    <span className={`h-2 w-2 rounded-full ${s === 'oo' ? 'bg-red-400' : s === 'empty' ? 'bg-gray-400' : s === 'occupied' ? 'bg-blue-400' : 'bg-green-400'}`} />
                    <span className="text-xs text-gray-600">{roomStatusName(s)}</span>
                    <span className="text-xs font-semibold text-gray-900">{roomStatusCounts[s] ?? 0}</span>
                  </div>
                ))}
              </div>

              {/* Items prepared, per department */}
              {roomDeptKeys.map((dept) => (
                <div key={dept}>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{deptLabel(dept, lang)}</p>
                  <div className="divide-y divide-gray-100">
                    {roomItemsByDept[dept].map((it) => (
                      <div key={it.item} className="flex items-center justify-between py-1.5 text-sm">
                        <span className="text-gray-600">{it.item}</span>
                        <span className="text-gray-900">
                          <span className="font-semibold">{it.total}</span>
                          <span className="text-[11px] text-gray-400 ml-2">{it.done}/{it.total} {lang === 'th' ? 'เสร็จ' : 'done'}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
