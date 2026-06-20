import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import {
  ClipboardList, Loader2, X, Check, Trash2, Pencil,
  Plus, Send, PackageCheck, CircleCheck, ArrowRight, Clock, BedDouble, Ban, ChevronDown,
  Bell, BellOff, History, Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import {
  DEPARTMENTS, deptLabel,
  type Department, type KaizenProfile, type RrTemplate, type RrOrder, type RrOrderItem, type RrOrderStatus,
  type RrOrderType, type RrVariant, type RrEvent,
} from '@/types'
import type { RrItem } from '@/components/RRSettings'
import { RoomOrderView } from '@/components/RoomOrderView'
import { unitOne, DEFAULT_UNIT, type UnitNoun } from '@/lib/roomUnit'
import { resolveDeptRecipients } from '@/lib/rrNotify'
import { bangkokDate, parseDateOnlyBkk, bangkokDayOfWeek } from '@/lib/utils'
import { useRrFoAccess } from '@/hooks/useRrFoAccess'
import { useDepartments } from '@/hooks/useDepartments'

// ── helpers ──────────────────────────────────────────────────────────────────

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

function shiftDate(key: string, days: number): string {
  const d = parseDateOnlyBkk(key); d.setDate(d.getDate() + days); return bangkokDate(d)
}
/** Item for a template on a given date: weekday override, else the default. */
function itemFor(tpl: RrTemplate, date: string): string | null {
  const wd = WEEKDAY_KEYS[bangkokDayOfWeek(parseDateOnlyBkk(date))]
  return tpl.item_by_weekday?.[wd] || tpl.default_item || null
}
function fmtTime(ts: string | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })
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
  const { allOptions: allDepts } = useDepartments()
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
  const [templates, setTemplates] = useState<RrTemplate[]>([])
  const [orders, setOrders] = useState<RrOrder[]>([])
  const [rooms, setRooms] = useState<string[]>([])
  const [unit, setUnit] = useState<UnitNoun>(DEFAULT_UNIT) // configurable noun (Room / Hut / Resort …)
  const [mutes, setMutes] = useState<Set<string>>(new Set()) // template_ids muted by me
  const [loading, setLoading] = useState(true)
  const [placeTpl, setPlaceTpl] = useState<RrTemplate | null>(null) // template being ordered in the popup
  const today = bangkokDate()
  const tomorrow = shiftDate(today, 1)

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
    // RR-004: don't fetch board data until FO access check resolves — prevents unauthorized data exposure
    if (!companyId || rrFo.loading || !rrFo.allowed) return
    setLoading(true)
    const tpls = await supabase.from('kaizen_rr_templates').select('*')
      .eq('company_id', companyId).order('sort_order').order('created_at')
    if (tpls.error) { toast.error(tpls.error.message); setLoading(false); return }
    const tplList = (tpls.data as RrTemplate[]) ?? []
    setTemplates(tplList)

    // Orders are now placed on demand (click a template → popup → 'sent'); we no
    // longer auto-materialize 'pending' rows. The board shows today + tomorrow's
    // service dates together, so the date is carried per-order, not by a tab.
    const res = await supabase.from('kaizen_rr_orders')
      .select('*, items:kaizen_rr_order_items(*)')
      .eq('company_id', companyId).in('order_date', [today, tomorrow])
      .order('due_at', { ascending: true, nullsFirst: false })
    if (res.error) toast.error(res.error.message)
    setOrders((res.data as RrOrder[]) ?? [])
    setLoading(false)
  // RR-004: include rrFo state in deps so load re-runs once access is confirmed
  }, [companyId, today, tomorrow, rrFo.loading, rrFo.allowed])
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
      // Assigned people + the department's managers/super_admins (including managers
      // who cover this department via managed_departments).
      const esc = dept.replace(/"/g, '\\"')
      const [pickedRes, mgrRes] = await Promise.all([
        supabase.from('kaizen_profiles').select('id, role').eq('company_id', companyId).eq('is_active', true).in('id', picIds),
        supabase.from('kaizen_profiles').select('id, role').eq('company_id', companyId).eq('is_active', true)
          .in('role', ['manager', 'super_admin']).or(`department.eq."${esc}",managed_departments.cs.{"${esc}"}`),
      ])
      const byId = new Map<string, { id: string; role: string }>()
      ;[...(pickedRes.data ?? []), ...(mgrRes.data ?? [])].forEach((p) => byId.set(p.id, p as { id: string; role: string }))
      rows = Array.from(byId.values())
    } else {
      // Whole department — its members plus managers covering it via managed_departments.
      const esc = dept.replace(/"/g, '\\"')
      const { data } = await supabase.from('kaizen_profiles').select('id, role')
        .eq('company_id', companyId).eq('is_active', true)
        .or(`department.eq."${esc}",managed_departments.cs.{"${esc}"}`)
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

  // Whose turn is it? delivered → requesting side; sent/accepted → fulfilling side.
  const needsMyAction = useCallback((o: RrOrder) => {
    if (!profile) return false
    const onFulfill = canManage || profile.department === o.fulfill_department
    if (o.status === 'pending' || o.status === 'delivered') return onRequestSide(o)
    if (o.status === 'sent' || o.status === 'accepted') return onFulfill
    return false
  }, [profile, canManage, onRequestSide])

  const mine = orders.filter(needsMyAction)
  const rest = orders.filter((o) => !needsMyAction(o))

  // Templates this user may place an order for (request side). Managers can place
  // any; staff only their own department's routines (honouring pic_mode 'users').
  const canRequestTemplate = useCallback((tp: RrTemplate) => {
    if (!profile) return false
    if (canManage) return true
    if (profile.department !== tp.request_department) return false
    if (tp.pic_mode === 'users') return (tp.pic_ids ?? []).includes(profile.id)
    return true
  }, [profile, canManage])
  const menuTemplates = templates.filter((tp) => tp.active && canRequestTemplate(tp))

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
          mutes={mutes} onMuteToggle={loadMutes} canManage={canManage} onChanged={load} allDepts={allDepts} />
      ) : view === 'report' && canManage && companyId ? (
        <ReportView companyId={companyId} companyName={activeCompany?.org_title || activeCompany?.name || ''}
          generatedBy={profile?.full_name ?? ''} statusLabel={statusLabel} templates={templates} />
      ) : loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : templates.length === 0 ? (
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
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* ── Left: order menu — click a routine to place an order ── */}
          <section>
            <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
              {lang === 'th' ? 'สั่งออเดอร์' : 'Place an order'}
            </h2>
            {menuTemplates.length === 0 ? (
              <div className="text-center py-10 bg-white rounded-xl border border-gray-200 text-xs text-gray-400 px-4">
                {lang === 'th' ? 'ไม่มีงานประจำให้สั่งสำหรับแผนกของคุณ' : 'No routines to order for your department.'}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {menuTemplates.map((tp) => {
                  // "Ordered" once an active order exists for this routine today or tomorrow (the board's window).
                  const ordered = orders.some((o) => o.template_id === tp.id && o.status !== 'cancelled')
                  const name = lang === 'th' && tp.name_th ? tp.name_th : tp.name
                  return (
                    <button key={tp.id} onClick={() => setPlaceTpl(tp)}
                      title={`${deptLabel(tp.request_department, lang)} → ${deptLabel(tp.fulfill_department, lang)}${tp.due_time ? ` · ${hhmm(tp.due_time)}` : ''}`}
                      className="flex flex-col gap-0.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-left hover:border-[var(--brand-primary)]/50 hover:bg-gray-50 transition-colors">
                      <div className="flex items-start gap-1.5">
                        <ClipboardList className="h-3.5 w-3.5 flex-shrink-0 text-[var(--brand-primary)] mt-0.5" />
                        {/* Mobile: truncate to keep cards compact. Desktop: wrap so the full name is readable. */}
                        <p className="text-[13px] font-medium text-gray-900 flex-1 leading-tight truncate md:whitespace-normal md:overflow-visible">{name}</p>
                        {ordered
                          ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--brand-primary)] mt-0.5" />
                          : <Plus className="h-3.5 w-3.5 flex-shrink-0 text-gray-300 mt-0.5" />}
                      </div>
                      <p className="text-[10px] text-gray-400 truncate pl-5">
                        {deptLabel(tp.request_department, lang)} → {deptLabel(tp.fulfill_department, lang)}{tp.due_time ? ` · ${hhmm(tp.due_time)}` : ''}
                      </p>
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          {/* ── Right: orders already placed (today + tomorrow) ── */}
          <section>
            <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
              {lang === 'th' ? 'ออเดอร์ที่สั่งแล้ว' : 'Orders placed'}
            </h2>
            {orders.length === 0 ? (
              <div className="text-center py-10 bg-white rounded-xl border border-gray-200 text-xs text-gray-400 px-4">
                {lang === 'th' ? 'ยังไม่มีออเดอร์ — เลือกงานประจำทางซ้ายเพื่อสั่ง' : 'No orders yet — pick a routine on the left to start.'}
              </div>
            ) : (
              <div className="space-y-4">
                {mine.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-[var(--brand-primary)] mb-2">
                      {tr.rr.needsMyAction}<span className="ml-1.5 font-normal opacity-60">{mine.length}</span>
                    </p>
                    <div className="space-y-2">
                      {mine.map((o) => (
                        <OrderCard key={o.id} order={o} title={displayTitle(o)} template={tplOf(o)}
                          rooms={rooms} statusLabel={statusLabel} readOnly={false} canManage={canManage}
                          onRequestSide={onRequestSide(o)} muted={o.template_id ? mutes.has(o.template_id) : false}
                          onMuteToggle={loadMutes} notifyDept={notifyDept} onChanged={load} />
                      ))}
                    </div>
                  </div>
                )}
                {rest.length > 0 && (
                  <div>
                    {mine.length > 0 && (
                      <p className="text-xs font-semibold text-gray-500 mb-2">
                        {tr.rr.otherOrders}<span className="ml-1.5 font-normal opacity-60">{rest.length}</span>
                      </p>
                    )}
                    <div className="space-y-2">
                      {rest.map((o) => (
                        <OrderCard key={o.id} order={o} title={displayTitle(o)} template={tplOf(o)}
                          rooms={rooms} statusLabel={statusLabel} readOnly={false} canManage={canManage}
                          onRequestSide={onRequestSide(o)} muted={o.template_id ? mutes.has(o.template_id) : false}
                          onMuteToggle={loadMutes} notifyDept={notifyDept} onChanged={load} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {placeTpl && companyId && profile && (
        <PlaceOrderModal template={placeTpl} companyId={companyId} profile={profile}
          today={today} tomorrow={tomorrow} rooms={rooms} notifyDept={notifyDept}
          onClose={() => setPlaceTpl(null)} onPlaced={load} />
      )}
    </div>
  )
}

// ── place-order popup (click a routine → quantity / rooms + ready-by → sent) ───

function PlaceOrderModal({ template: tp, companyId, profile, today, tomorrow, rooms, notifyDept, onClose, onPlaced }: {
  template: RrTemplate
  companyId: string
  profile: KaizenProfile
  today: string
  tomorrow: string
  rooms: string[]
  notifyDept: (dept: Department, title: string, message: string,
    opts?: { templateId?: string | null; picMode?: string | null; picIds?: string[] | null; useDeptConfig?: boolean }) => Promise<void>
  onClose: () => void
  onPlaced: () => void
}) {
  const { t: tr, lang } = useLanguage()
  // Routine orders are placed ahead by default; staff can switch to Today in the picker.
  const [serviceDate, setServiceDate] = useState(tomorrow)
  const [qty, setQty] = useState('')
  const [time, setTime] = useState(hhmm(tp.due_time) || '12:00')
  const [note, setNote] = useState('')
  const [grid, setGrid] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const isBulk = tp.order_type === 'bulk'
  const hasVariants = tp.order_type === 'per_room_variants'
  const variants = tp.variants ?? null
  const name = lang === 'th' && tp.name_th ? tp.name_th : tp.name
  const unitOf = (n: number) => (tp.unit_label ? `${n} ${tp.unit_label}` : String(n))
  const dateLabel = (d: string) => new Date(d + 'T00:00:00+07:00').toLocaleDateString(
    lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' })

  async function place() {
    const order_date = serviceDate
    const item_label = itemFor(tp, order_date)
    let quantity: number
    let picked: string[] = []
    if (isBulk) {
      const n = Number(qty)
      if (!qty.trim() || !Number.isFinite(n) || n <= 0) { toast.error(tr.rr.quantityRequired); return }
      quantity = n
    } else {
      picked = Object.keys(grid)
      if (picked.length === 0) { toast.error(hasVariants ? tr.rr.noVariantRooms : tr.rr.roomsRequired); return }
      quantity = picked.length
    }
    setBusy(true)
    const nowIso = new Date().toISOString()
    const due_at = new Date(`${order_date}T${time || '12:00'}+07:00`).toISOString()
    // A previously-cancelled order still occupies the UNIQUE(template_id, order_date)
    // slot. The menu treats cancelled as "not ordered" and invites a re-order, so clear
    // the stale cancelled row first — otherwise the insert below collides and shows the
    // misleading "already ordered for that day" toast.
    await supabase.from('kaizen_rr_orders').delete()
      .eq('company_id', companyId).eq('template_id', tp.id)
      .eq('order_date', order_date).eq('status', 'cancelled')
    const { data: inserted, error } = await supabase.from('kaizen_rr_orders').insert({
      company_id: companyId, template_id: tp.id, order_date,
      title: tp.name, request_department: tp.request_department, fulfill_department: tp.fulfill_department,
      order_type: tp.order_type, item_label, unit_label: isBulk ? tp.unit_label : null,
      quantity, note: note.trim() || null, status: 'sent', due_at, sent_by: profile.id, sent_at: nowIso,
    }).select().single()
    if (error) {
      setBusy(false)
      toast.error(/duplicate|unique/i.test(error.message)
        ? (lang === 'th' ? 'งานประจำนี้ถูกสั่งสำหรับวันดังกล่าวแล้ว' : 'This routine is already ordered for that day.')
        : error.message)
      return
    }
    if (!isBulk) {
      const ins = await supabase.from('kaizen_rr_order_items').insert(
        picked.map((room) => ({
          order_id: inserted.id, company_id: companyId, room_no: room,
          item_label, variant: hasVariants ? (grid[room] || null) : null,
        })))
      if (ins.error) { setBusy(false); toast.error(ins.error.message); return }
    }
    const roomsWord = lang === 'th' ? 'ห้อง' : 'rooms'
    const qtyLabel = isBulk ? unitOf(quantity)
      : hasVariants ? `${variantBreakdown(picked.map((r) => ({ variant: grid[r] } as RrOrderItem)), variants, lang)} · ${picked.length} ${roomsWord}`
      : `${picked.length} ${roomsWord}`
    await supabase.from('kaizen_rr_events').insert({
      company_id: companyId, order_id: inserted.id, actor_id: profile.id, action: 'sent', detail: qtyLabel,
    })
    const itemSuffix = item_label ? ` — ${item_label}` : ''
    await notifyDept(tp.fulfill_department,
      lang === 'th' ? 'มีออเดอร์ประจำเข้ามาใหม่' : 'Routine order received',
      lang === 'th'
        ? `"${tp.name}"${itemSuffix} — ${qtyLabel} จากแผนก ${deptLabel(tp.request_department, lang)}`
        : `"${tp.name}"${itemSuffix} — ${qtyLabel} requested by ${deptLabel(tp.request_department, lang)}`,
      { templateId: tp.id, picMode: tp.pic_mode, picIds: tp.pic_ids, useDeptConfig: true })
    toast.success(tr.rr.orderSent)
    onPlaced()
    onClose()
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={busy ? undefined : onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">{name}</h3>
            <p className="text-[11px] text-gray-400">{lang === 'th' ? 'ส่งไปยัง' : 'To'} {deptLabel(tp.fulfill_department, lang)}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {/* Quantity (bulk) or room grid (per-room) */}
          {isBulk ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500">{tp.unit_label ? tr.rr.quantityUnit(tp.unit_label) : tr.rr.quantity}</label>
              <div className="flex items-center gap-2">
                <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric"
                  placeholder={tr.rr.quantityPh} className={inputCls + ' max-w-[120px]'} autoFocus />
                {tp.unit_label && <span className="text-sm text-gray-500">{tp.unit_label}</span>}
              </div>
            </div>
          ) : rooms.length > 0 ? (
            <RoomGrid rooms={rooms} grid={grid} setGrid={setGrid} variants={hasVariants ? variants : null} />
          ) : (
            <p className="text-xs text-amber-600">{lang === 'th' ? 'ยังไม่ได้ตั้งค่ารายการห้อง โปรดติดต่อผู้จัดการ' : 'No rooms configured — ask a manager to set up the room list.'}</p>
          )}

          {/* Ready-by date — replaces the old Today/Tomorrow tab */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-500">{lang === 'th' ? 'ต้องการก่อน' : 'Ready by'}</label>
            <div className="flex items-center gap-2 flex-wrap">
              {([[today, lang === 'th' ? 'วันนี้' : 'Today'], [tomorrow, lang === 'th' ? 'พรุ่งนี้' : 'Tomorrow']] as const).map(([d, label]) => (
                <button key={d} type="button" onClick={() => setServiceDate(d)}
                  className={`px-3 h-8 rounded-full border text-xs font-medium transition-colors ${
                    serviceDate === d ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                                      : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
                  {label}
                </button>
              ))}
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
                className="h-8 rounded-lg border border-gray-300 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40" />
            </div>
            {serviceDate !== today && serviceDate !== tomorrow && (
              <p className="text-[11px] text-gray-400">{dateLabel(serviceDate)}</p>
            )}
          </div>

          {/* Note */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-500">{lang === 'th' ? 'หมายเหตุ (ถ้ามี)' : 'Note (optional)'}</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr.rr.notePh} className={inputCls} />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 h-9 rounded-lg text-sm text-gray-500 hover:text-gray-700">
            {lang === 'th' ? 'ยกเลิก' : 'Cancel'}
          </button>
          <button onClick={place} disabled={busy}
            className="flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {lang === 'th' ? `ส่งไปยัง${deptLabel(tp.fulfill_department, lang)}` : `Send to ${deptLabel(tp.fulfill_department, lang)}`}
          </button>
        </div>
      </div>
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

  // Deliver-by label — the date is carried by the order itself (today / tomorrow service).
  const dayWord = o.order_date > bangkokDate() ? tr.rr.tomorrow : tr.rr.today
  const deliverLabel = dueLabel ? tr.rr.readyByOn(dueLabel, dayWord) : ''
  // "Late": delivered/confirmed after the due time.
  const lateAt = (ts: string | null) => !!(o.due_at && ts && new Date(ts).getTime() > new Date(o.due_at).getTime())
  const isLate = (o.status === 'delivered' || o.status === 'confirmed') &&
    (lateAt(o.delivered_at) || lateAt(o.confirmed_at))

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
      const roomsWord = lang === 'th' ? 'ห้อง' : 'rooms'
      const detail = hasVariants ? `${variantBreakdown(picked.map((r) => ({ variant: grid[r] } as RrOrderItem)), variants, lang)} · ${picked.length} ${roomsWord}` : `${picked.length} ${roomsWord}`
      // Update status first so a failed items insert can be safely retried without duplicating the status update.
      // update() releases busy internally; re-acquire it for the items insert below.
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
      setBusy(true)
      const ins = await supabase.from('kaizen_rr_order_items').insert(
        picked.map((room) => ({
          order_id: o.id, company_id: o.company_id, room_no: room,
          item_label: o.item_label, variant: hasVariants ? (grid[room] || null) : null,
        }))
      )
      setBusy(false)
      if (ins.error) { toast.error(ins.error.message); return }
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
    // Last room ticked → the whole order is delivered. Re-read the rooms from the
    // DB rather than the in-closure `items` snapshot, which can be stale when two
    // rooms are ticked in quick succession (the reload is async) and would then
    // miss the auto-promotion to 'delivered'.
    let allDone = false
    let dbRows: { delivered: boolean }[] | null = null
    if (delivered) {
      const { data: rows } = await supabase.from('kaizen_rr_order_items').select('delivered').eq('order_id', o.id)
      dbRows = rows
      allDone = !!rows && rows.length > 0 && rows.every((x) => x.delivered)
    }
    if (allDone) {
      const { error: e2 } = await supabase.from('kaizen_rr_orders').update({
        status: 'delivered', delivered_by: profile.id, delivered_at: now(),
      }).eq('id', o.id)
      if (e2) toast.error(e2.message)
      else {
        // RR-006: use DB row count rather than stale closure items.length
        const dbCount = dbRows?.length ?? items.length
        await logEvent('delivered', null)
        await notifyDept(o.request_department,
          lang === 'th' ? 'จัดส่งออเดอร์แล้ว' : 'Routine order delivered',
          lang === 'th'
            ? `"${o.title}"${itemSuffix} — ครบทั้ง ${dbCount} ห้อง โดยแผนก ${deptLabel(o.fulfill_department, lang)}`
            : `"${o.title}"${itemSuffix} — all ${dbCount} rooms done by ${deptLabel(o.fulfill_department, lang)}`,
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


  const actionBtnCls = 'flex items-center justify-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50'

  // PIC label for the meta line — only when specific people are named. With
  // whole-department mode it would just repeat the request dept ("Spa → … · Spa"),
  // so it's hidden in that case.
  const picLabel = picMode === 'users' && picNames.length > 0 ? picNames.join(', ') : ''

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
            {picLabel && <span className="flex items-center gap-0.5">· <Users className="h-3 w-3" /> {picLabel}</span>}
            {o.quantity != null && o.order_type === 'bulk' && <span>· {tr.rr.qty} {unitOf(o.quantity)}</span>}
            {isPerRoom && items.length > 0 && (
              <span className="flex items-center gap-0.5">· <BedDouble className="h-3 w-3" /> {tr.rr.roomsDone(deliveredCount, items.length)}</span>
            )}
          </p>
          {/* Delivery deadline */}
          {deliverLabel && (
            <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1 flex-wrap">
              <Clock className="h-3 w-3" />
              <span>{deliverLabel}</span>
            </p>
          )}
          {/* Variant breakdown summary on sent+ variant orders */}
          {hasVariants && items.length > 0 && (
            <p className="text-[11px] text-gray-400 mt-0.5">{variantBreakdown(items, variants, lang)}</p>
          )}
          {o.note && <p className="text-[11px] text-gray-400 mt-0.5">{o.note}</p>}
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
        {showTimeline && <OrderTimeline order={o} />}
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
    // Update status first so a failed items insert can be safely retried without duplicates.
    // update() releases busy internally; re-acquire it for the items insert below.
    await update(
      { status: 'sent', quantity: parsed.length, note: note.trim() || null, sent_by: profile.id, sent_at: now() },
      tr.rr.orderSent,
      { action: 'sent', detail: `${parsed.length} ${lang === 'th' ? 'ห้อง' : 'rooms'}` },
      // RR-005: useDeptConfig:true so the company's notification policy is applied (matches sendOrder)
      { dept: o.fulfill_department, useDeptConfig: true,
        title: lang === 'th' ? 'มีออเดอร์ประจำเข้ามาใหม่' : 'Routine order received',
        message: lang === 'th'
          ? `"${o.title}"${itemSuffix} — ${parsed.length} ห้อง จากแผนก ${deptLabel(o.request_department, lang)}`
          : `"${o.title}"${itemSuffix} — ${parsed.length} rooms, requested by ${deptLabel(o.request_department, lang)}` },
    )
    setBusy(true)
    const ins = await supabase.from('kaizen_rr_order_items').insert(
      parsed.map((r) => ({ order_id: o.id, company_id: o.company_id, room_no: r.room_no, item_label: r.item_label, variant: null }))
    )
    setBusy(false)
    if (ins.error) { toast.error(ins.error.message); return }
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

function OrderTimeline({ order: o }: { order: RrOrder }) {
  const { t: tr } = useLanguage()
  const [events, setEvents] = useState<(RrEvent & { actor?: { full_name: string } | null })[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  // The order's own columns are the source of truth for the lifecycle (who placed /
  // accepted / delivered / confirmed). Events add finer detail (per-room, reassign)
  // but may be absent — so the milestones below never depend on them.
  const actorIds = [o.sent_by, o.accepted_by, o.delivered_by, o.confirmed_by].filter(Boolean) as string[]
  useEffect(() => {
    let stale = false
    ;(async () => {
      setLoading(true)
      const [evRes, npRes] = await Promise.all([
        supabase.from('kaizen_rr_events')
          .select('*, actor:kaizen_profiles!kaizen_rr_events_actor_id_fkey(full_name)')
          .eq('order_id', o.id).order('created_at', { ascending: true }),
        actorIds.length
          ? supabase.from('kaizen_profiles').select('id, full_name').in('id', [...new Set(actorIds)])
          : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
      ])
      if (stale) return
      setEvents((evRes.data as (RrEvent & { actor?: { full_name: string } | null })[]) ?? [])
      const map: Record<string, string> = {}
      ;((npRes.data as { id: string; full_name: string }[]) ?? []).forEach((p) => { map[p.id] = p.full_name })
      setNames(map)
      setLoading(false)
    })()
    return () => { stale = true }
  }, [o.id, o.sent_by, o.accepted_by, o.delivered_by, o.confirmed_by, o.sent_at, o.accepted_at, o.delivered_at, o.confirmed_at]) // eslint-disable-line react-hooks/exhaustive-deps

  const actionLabel = (a: string): string => ({
    sent: tr.rr.evSent, accepted: tr.rr.evAccepted, delivered: tr.rr.evDelivered,
    confirmed: tr.rr.evConfirmed, cancelled: tr.rr.evCancelled, room_delivered: tr.rr.evRoomDelivered,
    pic_changed: tr.rr.evPicChanged,
  } as Record<string, string>)[a] ?? a

  const nm = (id: string | null) => (id && names[id]) || tr.rr.someone
  const qtyDetail = o.order_type === 'bulk' && o.quantity != null
    ? (o.unit_label ? `${o.quantity} ${o.unit_label}` : `${o.quantity}`) : ''

  // Milestones from the order columns (always reliable) …
  type Row = { key: string; at: string; text: string }
  const rows: Row[] = [
    o.sent_at && { key: 'sent', at: o.sent_at, text: `${nm(o.sent_by)} ${tr.rr.evSent}${qtyDetail ? ` · ${qtyDetail}` : ''}` },
    o.accepted_at && { key: 'accepted', at: o.accepted_at, text: `${nm(o.accepted_by)} ${tr.rr.evAccepted}` },
    o.delivered_at && { key: 'delivered', at: o.delivered_at, text: `${nm(o.delivered_by)} ${tr.rr.evDelivered}` },
    o.confirmed_at && { key: 'confirmed', at: o.confirmed_at, text: `${nm(o.confirmed_by)} ${tr.rr.evConfirmed}` },
  ].filter(Boolean) as Row[]
  // … plus the extra detail events the columns don't capture (per-room ticks, reassignments, cancellation).
  events.filter((e) => ['room_delivered', 'pic_changed', 'cancelled'].includes(e.action)).forEach((e) => {
    rows.push({ key: e.id, at: e.created_at, text: `${e.actor?.full_name || tr.rr.someone} ${actionLabel(e.action)}${e.detail ? ` ${e.detail}` : ''}` })
  })
  rows.sort((a, b) => a.at.localeCompare(b.at))

  if (loading) return <div className="mt-1.5 flex justify-center py-2"><Loader2 className="h-4 w-4 animate-spin text-gray-300" /></div>
  if (rows.length === 0) return <p className="mt-1.5 text-[11px] text-gray-400">{tr.rr.timelineEmpty}</p>

  return (
    <ul className="mt-1.5 space-y-1">
      {rows.map((row) => (
        <li key={row.key} className="text-[11px] text-gray-500 flex items-baseline gap-1.5">
          <span className="w-1 h-1 rounded-full bg-gray-300 flex-shrink-0 mt-1.5" />
          <span className="flex-1">{row.text}</span>
          <span className="text-gray-400 flex-shrink-0">{fmtTime(row.at)}</span>
        </li>
      ))}
    </ul>
  )
}

// ── templates view (managers) ────────────────────────────────────────────────

function TemplatesView({ companyId, templates, mutes, onMuteToggle, canManage, onChanged, allDepts }: {
  companyId: string; templates: RrTemplate[]
  mutes: Set<string>; onMuteToggle: () => void; canManage: boolean; onChanged: () => void
  allDepts: { value: string; label: string }[]
}) {
  const { t: tr, lang } = useLanguage()
  const { profile } = useAuth()
  const [editor, setEditor] = useState<RrTemplate | 'new' | null>(null)

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
                  {!tpl.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-400">{tr.rr.inactiveBadge}</span>}
                </div>
                <p className="text-[11px] text-gray-500 truncate mt-0.5 flex items-center gap-1">
                  {deptLabel(tpl.request_department, lang)}
                  <ArrowRight className="h-3 w-3" />
                  {deptLabel(tpl.fulfill_department, lang)}
                  <span>· {tr.rr.due} {(tpl.due_time || '').slice(0, 5)}</span>
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
          onClose={() => setEditor(null)} onSaved={() => { setEditor(null); onChanged() }} allDepts={allDepts} />
      )}
    </div>
  )
}

function TemplateEditor({ companyId, template, sortNext, onClose, onSaved, allDepts }: {
  companyId: string; template: RrTemplate | null; sortNext: number
  onClose: () => void; onSaved: () => void
  allDepts: { value: string; label: string }[]
}) {
  const { t: tr, lang } = useLanguage()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({
    name: template?.name ?? '', name_th: template?.name_th ?? '',
    request_department: template?.request_department ?? ('front_office' as Department),
    fulfill_department: template?.fulfill_department ?? ('restaurant' as Department),
    due_time: (template?.due_time ?? '12:00').slice(0, 5),
    order_type: (template?.order_type ?? 'bulk') as RrOrderType,
    active: template?.active ?? true,
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
    setBusy(true)
    const row = {
      company_id: companyId, name: f.name.trim(), name_th: f.name_th.trim() || null,
      request_department: f.request_department, fulfill_department: f.fulfill_department,
      order_type: f.order_type, due_time: f.due_time || '12:00',
      // A bulk routine is one item ordered in a quantity; the picked catalog item drives the
      // daily order's item label + unit (previously these were hardcoded null, so the picker
      // did nothing and every order was item-less/unit-less).
      default_item: catalogItems[0]?.label ?? null,
      catalog_items: catalogItems.length > 0 ? catalogItems : null,
      item_by_weekday: template?.item_by_weekday ?? null,
      active: f.active, sort_order: template?.sort_order ?? sortNext,
      unit_label: catalogItems[0]?.unit || null,
      variants: template?.variants ?? null,
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
                {allDepts.map((d) => <option key={d.value} value={d.value}>{deptLabel(d.value, lang)}</option>)}
              </select>
            </Field>
            <Field label={tr.rr.fulfillDept}>
              <select value={f.fulfill_department} onChange={(e) => set({ fulfill_department: e.target.value as Department })} className={inputCls}>
                {allDepts.map((d) => <option key={d.value} value={d.value}>{deptLabel(d.value, lang)}</option>)}
              </select>
            </Field>
          </div>

          <Field label={tr.rr.dueTime}>
            <input type="time" value={f.due_time} onChange={(e) => set({ due_time: e.target.value })} className={inputCls + ' max-w-[160px]'} />
          </Field>

          <Field label={lang === 'th' ? 'ประเภทออเดอร์' : 'Order type'}>
            <select value={f.order_type} onChange={(e) => set({ order_type: e.target.value as RrOrderType })} className={inputCls}>
              <option value="bulk">{lang === 'th' ? 'จำนวนรวม (Bulk)' : 'Quantity (bulk)'}</option>
              <option value="per_room">{lang === 'th' ? 'แยกตามห้อง (Per room)' : 'Per room'}</option>
              <option value="per_room_variants">{lang === 'th' ? 'แยกตามห้อง + ตัวเลือก (Variants)' : 'Per room with variants'}</option>
            </select>
          </Field>

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
                onUnitChange={(idx, unit) => setCatalogItems((prev) => prev.map((c, i) => i === idx ? { ...c, unit } : c))}
                lang={lang}
                deptLabel={deptLabel(f.fulfill_department, lang)}
              />
            )
          })()}

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

function DeptItemPicker({ items, catalogItems, onAdd, onRemove, onUnitChange, lang, deptLabel }: {
  items: import('@/components/RRSettings').RrItem[]
  catalogItems: { label: string; unit: string }[]
  onAdd: (label: string) => void
  onRemove: (index: number) => void
  onUnitChange: (index: number, unit: string) => void
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
              {/* Unit the order is counted in (e.g. gallon, bottle, pcs) — shown as "Quantity (gallon)" when ordering. */}
              <input
                value={item.unit}
                onChange={(e) => onUnitChange(i, e.target.value)}
                placeholder={lang === 'th' ? 'หน่วย' : 'unit'}
                className="w-24 h-8 rounded-md border border-gray-300 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40 flex-shrink-0"
              />
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
  const d = parseDateOnlyBkk(key)
  const dow = bangkokDayOfWeek(d) === 0 ? 6 : bangkokDayOfWeek(d) - 1 // Monday-first
  d.setDate(d.getDate() - dow)
  return bangkokDate(d)
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
  const [anchor, setAnchor] = useState(() => bangkokDate())
  const [rows, setRows] = useState<RrOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
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

  const fmtDay = (key: string) => new Date(key + 'T00:00:00+07:00').toLocaleDateString(
    lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' })
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

  function buildReportHtml() {
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
    const roomHtml = hasRoomData ? `
      <h2>${esc(lang === 'th' ? 'ใบสั่งห้อง' : 'Room orders')} <span style="font-weight:400;color:#888;font-size:12px">(${roomDays} ${esc(lang === 'th' ? 'วัน' : 'days')})</span></h2>
      <table style="max-width:420px"><thead><tr><th>${esc(lang === 'th' ? 'สถานะห้อง' : 'Room status')}</th><th style="text-align:right">${esc(tr.rr.reportTotal)}</th></tr></thead>
      <tbody>${(['checkin', 'occupied', 'empty', 'oo'] as const).map((s) => `<tr><td>${esc(roomStatusName(s))}</td><td style="text-align:right">${roomStatusCounts[s] ?? 0}</td></tr>`).join('')}</tbody></table>
      ${roomDeptKeys.map((dept) => `
        <h3 style="font-size:12px;margin:14px 0 4px;color:#444">${esc(deptLabel(dept, lang))}</h3>
        <table style="max-width:420px"><thead><tr><th>${esc(tr.rr.reportItem)}</th><th style="text-align:right">${esc(tr.rr.reportTotal)}</th><th style="text-align:right">${esc(lang === 'th' ? 'เสร็จ' : 'Done')}</th></tr></thead>
        <tbody>${roomItemsByDept[dept].map((it) => `<tr><td>${esc(it.item)}</td><td style="text-align:right">${it.total}</td><td style="text-align:right">${it.done}</td></tr>`).join('')}</tbody></table>`).join('')}` : ''
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(tr.rr.reportTitle)}</title>
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
      <p class="foot">${esc(tr.rr.reportGeneratedBy)}: ${esc(generatedBy)} · ${esc(tr.rr.reportGeneratedAt)}: ${new Date().toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { timeZone: 'Asia/Bangkok' })}</p>
      </body></html>`
  }

  function handlePreview() {
    setPreviewHtml(buildReportHtml())
  }

  function handlePrint() {
    iframeRef.current?.contentWindow?.print()
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
        <button onClick={handlePreview} disabled={loading || (rows.length === 0 && !hasRoomData)}
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

      {/* Report preview modal */}
      {previewHtml && (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'rgba(15,23,42,0.7)' }}>
          {/* Modal header */}
          <div className="flex items-center justify-between bg-white px-4 h-12 border-b border-gray-200 shadow-sm flex-shrink-0">
            <span className="text-sm font-semibold text-gray-700">{tr.rr.reportTitle} — {companyName}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={handlePrint}
                className="h-8 px-4 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-semibold hover:opacity-90 transition-opacity"
              >
                {tr.rr.reportPrint}
              </button>
              <button
                onClick={() => setPreviewHtml(null)}
                className="h-8 px-4 rounded-lg border border-gray-300 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                {lang === 'th' ? 'ปิด' : 'Close'}
              </button>
            </div>
          </div>
          {/* iframe preview */}
          <iframe
            ref={iframeRef}
            srcDoc={previewHtml}
            className="flex-1 w-full bg-white"
            title="Report Preview"
          />
        </div>
      )}
    </div>
  )
}
