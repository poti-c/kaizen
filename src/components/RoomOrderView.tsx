import { useState, useEffect, useCallback } from 'react'
import {
  Loader2, X, Check, Plus, Trash2, Send, ChevronLeft, ChevronRight,
  Truck, ListChecks, ArrowRight, DoorOpen, DoorClosed, CheckCircle2, ShieldCheck, Clock, AlertTriangle, RotateCcw, History, ChevronDown, Eye,
} from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { DEPARTMENTS, deptLabel, type Department } from '@/types'
import type { RrItem } from '@/components/RRSettings'
import type { RoomCategory, RoomType, Room } from '@/components/RoomSetupSettings'
import { DEFAULT_UNIT, unitOne, unitMany, type UnitNoun } from '@/lib/roomUnit'
import { resolveDeptRecipients } from '@/lib/rrNotify'
import { bangkokDate, parseDateOnlyBkk, bangkokDayOfWeek } from '@/lib/utils'
import type { RecipeLine, RoomRecipes, LineType } from '@/components/RoomRecipesSettings'
import { ItemField } from '@/components/RoomRecipesSettings'

const DEPT_OPTIONS = DEPARTMENTS.filter((d) => d.value !== 'top_management')
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const DEPT_BADGE: Record<string, string> = {
  restaurant: 'bg-orange-50 text-orange-700 border-orange-200',
  kitchen: 'bg-amber-50 text-amber-700 border-amber-200',
  house_keeping: 'bg-teal-50 text-teal-700 border-teal-200',
  front_office: 'bg-blue-50 text-blue-700 border-blue-200',
  engineering: 'bg-purple-50 text-purple-700 border-purple-200',
}
const deptBadge = (d: string) => DEPT_BADGE[d] || 'bg-gray-100 text-gray-600 border-gray-200'

function shiftDate(key: string, days: number): string {
  const d = parseDateOnlyBkk(key); d.setDate(d.getDate() + days); return bangkokDate(d)
}
function buildingOf(no: string): string {
  const m = no.trim().match(/^([A-Za-z]+)/); return m ? m[1].toUpperCase() : '—'
}
const roomSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

// ── special-request approval config + escalation ───────────────────────────────

interface ApprovalConfig {
  require: boolean     // master gate: do special requests need manager approval at all?
  enabled: boolean     // auto-release un-approved requests at the cutoff
  mode: 'clock' | 'before_serving'
  clock_time: string   // HH:MM on the service date
  hours_before: number // hours before serving time
}
const DEFAULT_APPROVAL: ApprovalConfig = { require: true, enabled: true, mode: 'clock', clock_time: '16:00', hours_before: 2 }

async function loadApprovalConfig(companyId: string): Promise<ApprovalConfig> {
  const { data } = await supabase.from('kaizen_settings').select('value')
    .eq('company_id', companyId).eq('key', 'rr_special_approval').maybeSingle()
  return { ...DEFAULT_APPROVAL, ...((data?.value as Partial<ApprovalConfig>) ?? {}) }
}

/** Cutoff timestamp (ms) for a special line, or null when it can't be computed. */
function cutoffTs(servingAt: string | null, date: string, cfg: ApprovalConfig): number | null {
  // 'before_serving' needs a serving time; when one isn't set, fall back to the clock
  // cutoff so the auto-release safety net still fires (otherwise the special could sit
  // pending forever and silently vanish from the fulfilling department's board).
  // Anchor the wall-clock cutoff to Asia/Bangkok (+07:00) so it fires at the
  // hotel's local time regardless of the viewer's device timezone.
  if (cfg.mode === 'before_serving' && servingAt) {
    return new Date(`${date}T${servingAt}:00+07:00`).getTime() - cfg.hours_before * 3600_000
  }
  return new Date(`${date}T${(cfg.clock_time || '16:00')}:00+07:00`).getTime()
}

// Default "prep by" buffer: a preparer should be done this many minutes before serving_at.
// Overridable per company via rr_room_config.prep_buffer_min.
const DEFAULT_PREP_BUFFER_MIN = 30

/** "HH:MM" minus N minutes, wrapping within a day. Returns '' for blank/invalid input. */
function minusMinutes(hhmm: string | null, mins: number): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return ''
  let t = h * 60 + m - mins
  t = ((t % 1440) + 1440) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** Notify the company's managers / super-admins (excluding the actor). */
async function notifyManagers(companyId: string, actorId: string | undefined, title: string, message: string) {
  const { data } = await supabase.from('kaizen_profiles').select('id')
    .eq('company_id', companyId).eq('is_active', true).in('role', ['manager', 'super_admin'])
  const ids = ((data as { id: string }[]) ?? []).map((p) => p.id).filter((id) => id !== actorId)
  if (ids.length === 0) return
  await supabase.from('kaizen_notifications').insert(
    ids.map((id) => ({ user_id: id, title, message, notification_type: 'rr' })))
}


/**
 * Notify each fulfilling department that a room order was placed, using the
 * per-department recipient config (whole department, or specific staff — to cover
 * for a manager on holiday). Only counts active, board-visible lines.
 */
async function notifyFulfillers(companyId: string, orderId: string, date: string, actorId: string | undefined, lang: string, sinceTs?: string | null) {
  let q = supabase.from('kaizen_rr_room_lines')
    .select('fulfill_department, prepare_department').eq('room_order_id', orderId).eq('active', true).in('approval_status', ['approved', 'auto'])
  // On a re-submit (edit), only notify departments that gained NEW lines since the last
  // submit — so an edit doesn't re-blast every department with the full order count.
  if (sinceTs) q = q.gt('created_at', sinceTs)
  const { data: lineRows } = await q
  // Work a dept must actively start now: single-stage lines it fulfils + handoff lines it
  // prepares. Plus a separate heads-up for the deliverer of a handoff (item still being made).
  const work = new Map<string, number>()
  const incoming = new Map<string, number>()
  for (const l of (lineRows as { fulfill_department: string; prepare_department: string | null }[]) ?? []) {
    if (l.prepare_department) {
      work.set(l.prepare_department, (work.get(l.prepare_department) ?? 0) + 1)
      incoming.set(l.fulfill_department, (incoming.get(l.fulfill_department) ?? 0) + 1)
    } else {
      work.set(l.fulfill_department, (work.get(l.fulfill_department) ?? 0) + 1)
    }
  }
  if (work.size === 0 && incoming.size === 0) return

  const rows: { user_id: string; title: string; message: string; notification_type: string }[] = []
  const seenWork = new Set<string>()      // de-dupe a person who covers multiple work depts
  const seenIncoming = new Set<string>()
  for (const [dept, n] of work) {
    const recipients = await resolveDeptRecipients(companyId, dept)
    const title = lang === 'th' ? 'ออเดอร์ห้องใหม่' : 'New room order'
    const message = lang === 'th'
      ? `มีงาน ${n} รายการสำหรับวันที่ ${date} โปรดตรวจสอบบอร์ดของแผนก`
      : `${n} item${n === 1 ? '' : 's'} to prepare for ${date} — check your department board.`
    for (const p of recipients) {
      if (p.id === actorId || seenWork.has(p.id)) continue
      seenWork.add(p.id)
      rows.push({ user_id: p.id, title, message, notification_type: 'rr' })
    }
  }
  for (const [dept, n] of incoming) {
    const recipients = await resolveDeptRecipients(companyId, dept)
    const title = lang === 'th' ? 'มีงานจัดส่งกำลังมา' : 'Deliveries incoming'
    const message = lang === 'th'
      ? `${n} รายการสำหรับวันที่ ${date} กำลังถูกเตรียมโดยอีกแผนก แล้วจะส่งให้คุณจัดส่ง`
      : `${n} item${n === 1 ? '' : 's'} for ${date} ${n === 1 ? 'is' : 'are'} being prepared by another dept — you'll deliver once ready.`
    for (const p of recipients) {
      if (p.id === actorId || seenIncoming.has(p.id)) continue
      seenIncoming.add(p.id)
      rows.push({ user_id: p.id, title, message, notification_type: 'rr' })
    }
  }
  if (rows.length > 0) await supabase.from('kaizen_notifications').insert(rows)
}

/**
 * Tell the department that currently HOLDS a handoff line that it's been cancelled
 * (its room was emptied / removed after work had begun) so prepped food isn't wasted.
 * Grouped by dept with a count. No-op when there's nothing to report.
 */
async function notifyHandoffCancellations(
  companyId: string, actorId: string | undefined, lang: string,
  cancels: { dept: string; room: string }[],
) {
  if (cancels.length === 0) return
  const counts = new Map<string, number>()
  for (const c of cancels) counts.set(c.dept, (counts.get(c.dept) ?? 0) + 1)
  const rows: { user_id: string; title: string; message: string; notification_type: string }[] = []
  const seen = new Set<string>()
  for (const [dept, n] of counts) {
    const recipients = await resolveDeptRecipients(companyId, dept)
    const title = lang === 'th' ? 'ออเดอร์ห้องถูกยกเลิก' : 'Room order cancelled'
    const message = lang === 'th'
      ? `${n} รายการที่กำลังดำเนินการถูกยกเลิก (ห้องถูกปิด/นำออก) — ไม่ต้องเตรียม/จัดส่ง`
      : `${n} in-progress item${n === 1 ? '' : 's'} cancelled (room emptied/removed) — no need to prepare or deliver ${n === 1 ? 'it' : 'them'}.`
    for (const p of recipients) {
      if (p.id === actorId || seen.has(p.id)) continue
      seen.add(p.id)
      rows.push({ user_id: p.id, title, message, notification_type: 'rr' })
    }
  }
  if (rows.length > 0) await supabase.from('kaizen_notifications').insert(rows)
}

/** Append an entry to a room order's change history. */
async function logRoomEvent(companyId: string, orderId: string, date: string, actorId: string | undefined, action: string, detail: string | null) {
  await supabase.from('kaizen_rr_room_events')
    .insert({ company_id: companyId, room_order_id: orderId, order_date: date, actor_id: actorId ?? null, action, detail })
}

interface RoomEvent { id: string; action: string; detail: string | null; created_at: string; actorName: string }

function fmtEventTime(ts: string, lang: string): string {
  return new Date(ts).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })
}
/** Human phrase for a history event. */
function eventLabel(e: RoomEvent, lang: string): string {
  const d = e.detail ?? ''
  switch (e.action) {
    case 'submitted': return lang === 'th' ? 'ส่งใบสั่ง' : 'placed the order'
    case 'resubmitted': return lang === 'th' ? 'ส่งใบสั่งอีกครั้ง' : 're-submitted the order'
    case 'room_saved': {
      // detail is "<roomNo> · <statusKey>" (older rows may carry an English label — shown as-is).
      const [room, st] = d.split(' · ')
      const known = (['checkin', 'occupied', 'empty', 'oo'] as RoomStatus[]).includes(st as RoomStatus)
      const stLabel = known ? statusLabel(st as RoomStatus, lang) : (st ?? '')
      return lang === 'th' ? `แก้ไข ${room} · ${stLabel}` : `edited ${room} · ${stLabel}`
    }
    case 'emptied_rest': return lang === 'th' ? `ตั้ง ${d} ห้องเป็นว่าง` : `set ${d} rooms to Empty`
    case 'order_received': return lang === 'th' ? `รับงาน (${deptLabel(d as Department, lang)})` : `acknowledged (${deptLabel(d as Department, lang)})`
    case 'prepared': return lang === 'th' ? `เตรียมเสร็จ · ${d}` : `prepared · ${d}`
    case 'approved': return lang === 'th' ? `อนุมัติ ${d}` : `approved ${d}`
    case 'rejected': return lang === 'th' ? `ปฏิเสธ ${d}` : `rejected ${d}`
    default: return e.action
  }
}

/**
 * Lazily auto-release any pending special requests whose approval cutoff has
 * passed (submitted orders only). Returns the number auto-released. Mirrors how
 * the board materializes orders on view — no scheduled job required.
 */
async function escalateOverdueSpecials(companyId: string, date: string, cfg: ApprovalConfig, lang: string): Promise<number> {
  if (!cfg.enabled) return 0
  const { data } = await supabase.from('kaizen_rr_room_lines')
    .select('id, serving_at, slot, item, kaizen_rr_room_orders!inner(status)')
    .eq('company_id', companyId).eq('order_date', date).eq('source', 'special').eq('active', true).eq('approval_status', 'pending')
  const now = Date.now()
  const overdue = ((data as unknown as { id: string; serving_at: string | null; kaizen_rr_room_orders: { status: string } | { status: string }[] }[]) ?? [])
    .filter((l) => { const o = Array.isArray(l.kaizen_rr_room_orders) ? l.kaizen_rr_room_orders[0] : l.kaizen_rr_room_orders; return o?.status === 'submitted' })
    .filter((l) => { const c = cutoffTs(l.serving_at, date, cfg); return c != null && now > c })
    .map((l) => l.id)
  if (overdue.length === 0) return 0
  // Atomic release: only flip rows still 'pending' and act solely on the ones THIS call
  // changed, so concurrent loads don't double-notify.
  const { data: released } = await supabase.from('kaizen_rr_room_lines')
    .update({ approval_status: 'auto' }).in('id', overdue).eq('approval_status', 'pending')
    .select('id, fulfill_department')
  const rows = (released as { id: string; fulfill_department: string }[]) ?? []
  if (rows.length === 0) return 0
  const n = rows.length
  const title = lang === 'th' ? 'ออเดอร์ห้อง — ปล่อยคำขอพิเศษอัตโนมัติ' : 'Room order — special requests auto-released'
  const message = lang === 'th'
    ? `คำขอพิเศษ ${n} รายการสำหรับวันที่ ${date} ไม่ได้รับการอนุมัติก่อนกำหนด จึงถูกส่งไปยังแผนกผู้ดำเนินการแล้ว`
    : `${n} special request${n === 1 ? '' : 's'} for ${date} ${n === 1 ? 'was' : 'were'} not approved before the cutoff and ${n === 1 ? 'has' : 'have'} been sent to the fulfilling departments.`
  await notifyManagers(companyId, undefined, title, message)
  // Also alert the fulfilling departments — the released items now appear on their board.
  const deptNotify: { user_id: string; title: string; message: string; notification_type: string }[] = []
  const seen = new Set<string>()
  for (const dept of [...new Set(rows.map((r) => r.fulfill_department))]) {
    for (const p of await resolveDeptRecipients(companyId, dept)) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      deptNotify.push({ user_id: p.id, title, message, notification_type: 'rr' })
    }
  }
  if (deptNotify.length > 0) await supabase.from('kaizen_notifications').insert(deptNotify)
  return n
}

/** Occupancy status of a room for a given service date — drives default line activation. */
type RoomStatus = 'checkin' | 'occupied' | 'empty' | 'oo'

function statusLabel(s: RoomStatus, lang: string): string {
  if (lang === 'th') return { checkin: 'เช็คอิน', occupied: 'มีผู้เข้าพัก', empty: 'ว่าง', oo: 'งดใช้งาน' }[s]
  return { checkin: 'Check-in', occupied: 'Occupied', empty: 'Empty', oo: 'Out of order' }[s]
}
/** Is this an arrival/one-time setup line (skipped when the room is already occupied)? */
function isArrivalLine(slot: string): boolean {
  return /fruit|minibar|มินิบาร์|ผลไม้/i.test(slot)
}
/** Default active state of a line under a given room status. */
function lineActiveFor(status: RoomStatus, slot: string): boolean {
  if (status === 'empty' || status === 'oo') return false
  if (status === 'occupied') return !isArrivalLine(slot)
  return true // check-in: everything active
}

/** One editable line in the room sheet. */
interface SheetLine {
  id: string
  slot: string
  item: string
  fulfill_department: Department          // final deliverer (single-stage: the only dept)
  prepare_department: Department | null   // preparer for two-stage handoff; null = single-stage
  serving_at: string
  line_type: LineType
  source: 'default' | 'special'
  note: string
  active: boolean
}

/** Resolve a category's recipe to concrete sheet lines for a given service date + status. */
function seedLines(recipe: RecipeLine[], date: string, status: RoomStatus = 'checkin'): SheetLine[] {
  const wd = WEEKDAY_KEYS[bangkokDayOfWeek(parseDateOnlyBkk(date))]
  return recipe.map((l) => ({
    id: l.id,
    slot: l.slot,
    item: (l.by_weekday && l.by_weekday[wd]?.trim()) ? l.by_weekday[wd] : l.item,
    fulfill_department: l.fulfill_department,
    prepare_department: l.prepare_department ?? null,
    serving_at: l.serving_at,
    line_type: l.line_type,
    source: 'default' as const,
    note: '',
    active: lineActiveFor(status, l.slot),
  }))
}
function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `l_${Math.floor(performance.now() * 1000)}`
}

interface DbLine {
  id: string; room_no: string; slot: string | null; item: string | null
  fulfill_department: string; prepare_department: string | null; serving_at: string | null; line_type: string
  source: string; note: string | null; active: boolean | null
}

// ── wrapper: picks Place-order (requester) vs Fulfil (department) mode ──────────

export function RoomOrderView({ companyId, initialDate, initialMode }: { companyId: string; initialDate?: string; initialMode?: 'build' | 'fulfil' }) {
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const canManage = profile?.role === 'super_admin' || profile?.role === 'manager'
  const myDept = (profile?.department ?? null) as Department | null
  const isRequester = canManage || myDept === 'front_office'

  const [mode, setMode] = useState<'build' | 'fulfil' | 'approvals'>(initialMode ?? (isRequester ? 'build' : 'fulfil'))
  const [fulfilDept, setFulfilDept] = useState<Department>(myDept && myDept !== 'front_office' ? myDept : 'restaurant')
  const [assignedDepts, setAssignedDepts] = useState<Department[]>([]) // depts actually used as a fulfilling dept in the recipes
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [requireApproval, setRequireApproval] = useState(true) // master gate from settings
  const [unit, setUnit] = useState<UnitNoun>(DEFAULT_UNIT)

  // Load the unit noun + the set of departments that recipes actually route work to.
  useEffect(() => {
    if (!companyId) return
    let stale = false
    Promise.all([
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_room_config').maybeSingle(),
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_room_recipes').maybeSingle(),
    ]).then(([cfgRes, recRes]) => {
      if (stale) return
      const u = (cfgRes.data?.value as { unit?: UnitNoun } | undefined)?.unit
      if (u) setUnit(u)
      const recipes = (recRes.data?.value as RoomRecipes) ?? {}
      const set = new Set<Department>()
      // Both roles route work to a department's board: the deliverer and, for handoff
      // lines, the preparer (e.g. Kitchen needs a board even if it only ever prepares).
      Object.values(recipes).forEach((lines) => (lines ?? []).forEach((l) => {
        set.add(l.fulfill_department)
        if (l.prepare_department) set.add(l.prepare_department)
      }))
      const list = DEPT_OPTIONS.map((d) => d.value).filter((v) => set.has(v)) // canonical order, only assigned
      setAssignedDepts(list)
      setFulfilDept((cur) => list.includes(cur) ? cur : (myDept && list.includes(myDept) ? myDept : (list[0] ?? cur)))
    })
    return () => { stale = true }
  }, [companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load the approval policy (require?) for everyone; managers also auto-release overdue specials + count pending.
  const refreshPending = useCallback(async () => {
    if (!companyId) return
    const cfg = await loadApprovalConfig(companyId)
    setRequireApproval(cfg.require)
    if (!canManage || !cfg.require) { setPendingApprovals(0); return }
    // Orders are placed for tomorrow by default, and a 'before_serving' cutoff for
    // tomorrow can lapse while it's still today — so escalate/count BOTH days, not
    // just today, otherwise tomorrow's overdue specials never auto-release.
    const today = bangkokDate()
    const tomorrow = shiftDate(today, 1)
    await Promise.all([
      escalateOverdueSpecials(companyId, today, cfg, lang),
      escalateOverdueSpecials(companyId, tomorrow, cfg, lang),
    ])
    const { count } = await supabase.from('kaizen_rr_room_lines')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).in('order_date', [today, tomorrow]).eq('source', 'special').eq('active', true).eq('approval_status', 'pending')
    setPendingApprovals(count ?? 0)
  }, [companyId, canManage, lang])
  useEffect(() => { refreshPending() }, [refreshPending])
  // If approval is turned off while sitting on the Approvals tab, fall back to Place order.
  useEffect(() => { if (!requireApproval && mode === 'approvals') setMode('build') }, [requireApproval, mode])

  // Non-requester staff only ever see their own department's fulfil board.
  if (!isRequester) return <RoomFulfilBoard companyId={companyId} dept={myDept ?? 'restaurant'} unit={unit} initialDate={initialDate} />

  return (
    <div className="space-y-4">
      {/* Mode switch — requesters/managers can place orders, inspect any dept's board, and approve specials */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs font-medium">
          <button onClick={() => setMode('build')} className={`px-3 h-8 ${mode === 'build' ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
            {lang === 'th' ? 'สร้างใบสั่ง' : 'Place order'}
          </button>
          <button onClick={() => setMode('fulfil')} className={`px-3 h-8 ${mode === 'fulfil' ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
            {lang === 'th' ? 'งานแผนก' : 'Fulfil'}
          </button>
          {canManage && requireApproval && (
            <button onClick={() => setMode('approvals')} className={`px-3 h-8 flex items-center gap-1 ${mode === 'approvals' ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {lang === 'th' ? 'อนุมัติ' : 'Approvals'}
              {pendingApprovals > 0 && <span className={`text-[10px] font-bold px-1.5 rounded-full ${mode === 'approvals' ? 'bg-white text-[var(--brand-primary)]' : 'bg-amber-500 text-white'}`}>{pendingApprovals}</span>}
            </button>
          )}
        </div>
        {mode === 'fulfil' && (assignedDepts.length > 0 ? (
          <select value={fulfilDept} onChange={(e) => setFulfilDept(e.target.value as Department)}
            className="h-8 rounded-lg border border-gray-300 px-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
            {assignedDepts.map((d) => <option key={d} value={d}>{deptLabel(d, lang)}</option>)}
          </select>
        ) : (
          <span className="text-xs text-gray-400">{lang === 'th' ? 'ยังไม่มีแผนกผู้ดำเนินการในสูตร' : 'No departments assigned in recipes yet'}</span>
        ))}
      </div>
      {mode === 'build' ? <RoomOrderBuild companyId={companyId} unit={unit} requireApproval={requireApproval} initialDate={initialDate} />
        : mode === 'fulfil' ? <RoomFulfilBoard companyId={companyId} dept={fulfilDept} unit={unit} initialDate={initialDate} />
        : <RoomApprovalsView companyId={companyId} onChanged={refreshPending} />}
    </div>
  )
}

// ── build view (requesting side: grid → room sheet → submit) ────────────────────

function RoomOrderBuild({ companyId, unit, requireApproval, initialDate }: { companyId: string; unit: UnitNoun; requireApproval: boolean; initialDate?: string }) {
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const canManage = profile?.role === 'super_admin' || profile?.role === 'manager'
  // Only Top Management and Front Office actually PLACE room orders. Other managers
  // (e.g. a fulfilling-dept manager like Restaurant) can view the order but not change it.
  const canPlace = profile?.role === 'super_admin' || profile?.department === 'front_office'
  const one = unitOne(unit, lang)
  const many = unitMany(unit, lang)

  const today = bangkokDate()
  const [date, setDate] = useState(() => initialDate ?? shiftDate(today, 1)) // default: tomorrow (placed evening before)

  const [categories, setCategories] = useState<RoomCategory[]>([])
  const [types, setTypes] = useState<RoomType[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [recipes, setRecipes] = useState<RoomRecipes>({})
  const [orderId, setOrderId] = useState<string | null>(null)
  const [orderStatus, setOrderStatus] = useState<'draft' | 'submitted' | null>(null)
  const [submittedAt, setSubmittedAt] = useState<string | null>(null)
  const [submittedByName, setSubmittedByName] = useState<string | null>(null)
  const [savedRooms, setSavedRooms] = useState<Record<string, SheetLine[]>>({})
  const [roomStatuses, setRoomStatuses] = useState<Record<string, RoomStatus>>({})
  const [blankRooms, setBlankRooms] = useState<string[]>([]) // submit-time validation: rooms with no order
  const [blankPrompt, setBlankPrompt] = useState<string[] | null>(null) // unassigned-rooms confirm dialog
  const [confirmReset, setConfirmReset] = useState(false)
  const [events, setEvents] = useState<RoomEvent[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [openRoom, setOpenRoom] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [cfgRes, recipesRes, orderRes] = await Promise.all([
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_room_config').maybeSingle(),
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_room_recipes').maybeSingle(),
      supabase.from('kaizen_rr_room_orders').select('*').eq('company_id', companyId).eq('order_date', date).maybeSingle(),
    ])
    const cfg = cfgRes.data?.value as { categories?: RoomCategory[]; types?: RoomType[]; rooms?: Room[] } | undefined
    setCategories((cfg?.categories ?? []).slice().sort((a, b) => a.order - b.order))
    setTypes(cfg?.types ?? [])
    setRooms((cfg?.rooms ?? []).slice().sort((a, b) => roomSort(a.no, b.no)))
    setRecipes((recipesRes.data?.value as RoomRecipes) ?? {})

    const order = orderRes.data as { id: string; status: 'draft' | 'submitted'; submitted_at: string | null; submitted_by: string | null; room_statuses?: Record<string, RoomStatus> } | null
    setOrderId(order?.id ?? null)
    setOrderStatus(order?.status ?? null)
    setSubmittedAt(order?.submitted_at ?? null)
    setRoomStatuses(order?.room_statuses ?? {})
    setBlankRooms([])
    setBlankPrompt(null)

    if (order?.submitted_by) {
      const { data: sub } = await supabase.from('kaizen_profiles').select('full_name').eq('id', order.submitted_by).maybeSingle()
      setSubmittedByName((sub as { full_name: string } | null)?.full_name ?? null)
    } else {
      setSubmittedByName(null)
    }

    if (order) {
      const { data: lines } = await supabase.from('kaizen_rr_room_lines').select('*').eq('room_order_id', order.id)
      const byRoom: Record<string, SheetLine[]> = {}
      for (const l of (lines as DbLine[]) ?? []) {
        (byRoom[l.room_no] ||= []).push({
          id: l.id, slot: l.slot ?? '', item: l.item ?? '', fulfill_department: l.fulfill_department as Department,
          prepare_department: (l.prepare_department as Department | null) ?? null,
          serving_at: l.serving_at ?? '', line_type: (l.line_type as LineType) ?? 'delivery',
          source: (l.source as 'default' | 'special') ?? 'default', note: l.note ?? '', active: l.active ?? true,
        })
      }
      setSavedRooms(byRoom)
      await loadEvents(order.id)
    } else {
      setSavedRooms({})
      setEvents([])
    }
    setLoading(false)
  }, [companyId, date]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  // Load the change history for an order, resolving actor names.
  const loadEvents = useCallback(async (oid: string) => {
    const { data } = await supabase.from('kaizen_rr_room_events')
      .select('id, action, detail, created_at, actor_id').eq('room_order_id', oid).order('created_at', { ascending: false })
    const list = (data as { id: string; action: string; detail: string | null; created_at: string; actor_id: string | null }[]) ?? []
    const ids = [...new Set(list.map((e) => e.actor_id).filter(Boolean))] as string[]
    const names: Record<string, string> = {}
    if (ids.length > 0) {
      const { data: profs } = await supabase.from('kaizen_profiles').select('id, full_name').in('id', ids)
      ;((profs as { id: string; full_name: string }[]) ?? []).forEach((p) => { names[p.id] = p.full_name })
    }
    setEvents(list.map((e) => ({ id: e.id, action: e.action, detail: e.detail, created_at: e.created_at,
      actorName: e.actor_id ? (names[e.actor_id] ?? '—') : (lang === 'th' ? 'ระบบ' : 'System') })))
  }, [lang])

  const items = useItems(companyId)

  const typeOf = (code: string) => types.find((t) => t.code === code)
  const catOf = (code: string) => { const t = typeOf(code); return t ? categories.find((c) => c.id === t.category) : undefined }
  const recipeForRoom = (r: Room): RecipeLine[] => { const t = typeOf(r.type); return t ? (recipes[t.category] ?? []) : [] }
  const statusForRoom = (no: string): RoomStatus => roomStatuses[no] ?? 'checkin'
  const linesForRoom = (r: Room): SheetLine[] => savedRooms[r.no] ?? seedLines(recipeForRoom(r), date, statusForRoom(r.no))

  async function ensureOrder(): Promise<{ id: string; status: 'draft' | 'submitted' } | null> {
    if (orderId) return { id: orderId, status: orderStatus ?? 'draft' }
    // Reuse an existing order for this date if one exists — NEVER downgrade a
    // submitted order back to draft (an edit after submit must stay submitted so
    // the change flows straight to the fulfilling departments).
    const { data: existing } = await supabase.from('kaizen_rr_room_orders')
      .select('id, status').eq('company_id', companyId).eq('order_date', date).maybeSingle()
    if (existing) {
      const ex = existing as { id: string; status: 'draft' | 'submitted' }
      setOrderId(ex.id); setOrderStatus(ex.status)
      return { id: ex.id, status: ex.status }
    }
    const { data, error } = await supabase.from('kaizen_rr_room_orders')
      .insert({ company_id: companyId, order_date: date, status: 'draft' })
      .select('id').single()
    if (error) {
      // Another writer created the order for this date concurrently (partial
      // unique index, status <> 'cancelled'). Recover by reading their row
      // instead of failing this user's save.
      if ((error as { code?: string }).code === '23505') {
        const { data: raced } = await supabase.from('kaizen_rr_room_orders')
          .select('id, status').eq('company_id', companyId).eq('order_date', date)
          .neq('status', 'cancelled').maybeSingle()
        if (raced) {
          const rx = raced as { id: string; status: 'draft' | 'submitted' }
          setOrderId(rx.id); setOrderStatus(rx.status)
          return { id: rx.id, status: rx.status }
        }
      }
      toast.error(error.message); return null
    }
    setOrderId(data.id); setOrderStatus('draft')
    return { id: data.id, status: 'draft' }
  }

  function lineRow(oid: string, roomNo: string, room: Room, l: SheetLine) {
    const cat = catOf(room.type)
    return {
      room_order_id: oid, company_id: companyId, order_date: date,
      room_no: roomNo, room_type: room.type, category: cat?.id ?? null,
      slot: l.slot || null, item: l.item || null, fulfill_department: l.fulfill_department,
      prepare_department: l.prepare_department ?? null,
      serving_at: l.serving_at || null, line_type: l.line_type, source: l.source,
      note: l.note || null, active: l.active,
      approval_status: l.source === 'special' && requireApproval ? 'pending' : 'approved',
    }
  }

  async function saveRoom(roomNo: string, lines: SheetLine[], status: RoomStatus) {
    if (busy) return false
    setBusy(true)
    const orderResult = await ensureOrder(); if (!orderResult) { setBusy(false); return false } const oid = orderResult.id
    const room = rooms.find((r) => r.no === roomNo)!
    const clean = lines.filter((l) => l.item.trim() || l.slot.trim())
    const nextStatuses = { ...roomStatuses, [roomNo]: status }
    // Reconcile rather than delete+reinsert: existing rows are UPDATED in place so their
    // fulfilment/approval state (status, delivered/acknowledged stamps, approval_status)
    // survives an edit to an already-submitted order. Only genuinely new lines are inserted,
    // and only lines the requester removed are deleted.
    const { data: existingRows } = await supabase.from('kaizen_rr_room_lines')
      .select('id, active, item, slot, serving_at, fulfill_department, prepare_department, status, source, approval_status, note')
      .eq('room_order_id', oid).eq('room_no', roomNo)
    type ExistingRow = { id: string; active: boolean | null; item: string | null; slot: string | null; serving_at: string | null; fulfill_department: string; prepare_department: string | null; status: string; source: string; approval_status: string; note: string | null }
    const cancels: { dept: string; room: string }[] = [] // handoff lines deactivated mid-flight
    const prevMap = new Map(((existingRows as ExistingRow[]) ?? []).map((r) => [r.id, r]))
    const prevActive = new Map(((existingRows as ExistingRow[]) ?? []).map((r) => [r.id, r.active !== false]))
    const existingIds = new Set(prevActive.keys())
    const keptIds = new Set<string>()
    const inserts: ReturnType<typeof lineRow>[] = []
    for (const l of clean) {
      if (existingIds.has(l.id)) {
        keptIds.add(l.id)
        const patch: Record<string, unknown> = {
          slot: l.slot || null, item: l.item || null, fulfill_department: l.fulfill_department,
          prepare_department: l.prepare_department ?? null,
          serving_at: l.serving_at || null, line_type: l.line_type, note: l.note || null, active: l.active,
        }
        // Edited special-request lines go back to pending so the new content is re-approved.
        const prev = prevMap.get(l.id)
        if (prev?.source === 'special') {
          const contentChanged = prev.item !== (l.item || null) || prev.slot !== (l.slot || null) ||
            prev.serving_at !== (l.serving_at || null) || prev.fulfill_department !== l.fulfill_department ||
            prev.prepare_department !== (l.prepare_department ?? null) ||
            prev.note !== (l.note || null)
          if (contentChanged) patch.approval_status = l.source === 'special' && requireApproval ? 'pending' : 'approved'
        }
        // Re-activating a line that had been switched off must return it to the board as
        // FRESH — otherwise a previously-delivered line reappears already ticked/done.
        // (An active line that stays active keeps its fulfilment state; we only reset on a
        //  genuine off->on transition.)
        if (l.active && prevActive.get(l.id) === false) {
          patch.status = 'pending'; patch.delivered_by = null; patch.delivered_at = null
          patch.acknowledged_by = null; patch.acknowledged_at = null
          patch.approval_status = l.source === 'special' && requireApproval ? 'pending' : 'approved'
          // Bump created_at so this freshly-resurrected line counts as NEW work on the
          // next re-submit — notifyFulfillers filters by created_at > last-submit time,
          // and the row otherwise keeps its original (pre-submit) timestamp and would be
          // silently skipped, leaving the fulfilling dept with un-notified work.
          patch.created_at = new Date().toISOString()
        } else if (l.active && prev && (prev.fulfill_department !== l.fulfill_department || prev.prepare_department !== (l.prepare_department ?? null))) {
          // RR-002: an already-active line re-routed to a DIFFERENT fulfilling (or preparing)
          // department must also bump created_at, so the newly-responsible department is picked
          // up by notifyFulfillers on this re-submit. Without it the re-routed row keeps its old
          // timestamp and the new department is never told it has work to do.
          patch.created_at = new Date().toISOString()
        }
        // Handoff line switched OFF after work began → alert whoever currently holds it.
        if (prev && prevActive.get(l.id) && !l.active && prev.prepare_department && prev.status !== 'done' && prev.status !== 'pending') {
          cancels.push({ dept: prev.status === 'ready' ? prev.fulfill_department : prev.prepare_department, room: roomNo })
        }
        const { error } = await supabase.from('kaizen_rr_room_lines').update(patch).eq('id', l.id)
        if (error) { setBusy(false); toast.error(error.message); return false }
      } else {
        inserts.push(lineRow(oid, roomNo, room, l))
      }
    }
    const toDelete = [...existingIds].filter((id) => !keptIds.has(id))
    // A removed handoff line that was already in progress also needs a cancellation alert.
    for (const id of toDelete) {
      const prev = prevMap.get(id)
      if (prev && prevActive.get(id) && prev.prepare_department && prev.status !== 'done' && prev.status !== 'pending') {
        cancels.push({ dept: prev.status === 'ready' ? prev.fulfill_department : prev.prepare_department, room: roomNo })
      }
    }
    if (toDelete.length > 0) {
      const { error } = await supabase.from('kaizen_rr_room_lines').delete().in('id', toDelete)
      if (error) { setBusy(false); toast.error(error.message); return false }
    }
    if (inserts.length > 0) {
      const { error } = await supabase.from('kaizen_rr_room_lines').insert(inserts)
      if (error) { setBusy(false); toast.error(error.message); return false }
    }
    const { error: e2 } = await supabase.from('kaizen_rr_room_orders').update({ room_statuses: nextStatuses }).eq('id', oid)
    if (e2) { setBusy(false); toast.error(e2.message); return false }
    // Store the raw status KEY (not an English label) so the History panel can localize it.
    await logRoomEvent(companyId, oid, date, profile?.id, 'room_saved', `${roomNo} · ${status}`)
    // Alert any dept left holding a now-cancelled handoff item (only matters once submitted).
    if (orderResult.status === 'submitted' && cancels.length > 0) await notifyHandoffCancellations(companyId, profile?.id, lang, cancels)
    // Re-read this room's rows so local state carries the real DB ids (prevents a second
    // edit from re-inserting the just-added lines as duplicates).
    const { data: fresh } = await supabase.from('kaizen_rr_room_lines').select('*').eq('room_order_id', oid).eq('room_no', roomNo)
    const freshLines: SheetLine[] = ((fresh as DbLine[]) ?? []).map((l) => ({
      id: l.id, slot: l.slot ?? '', item: l.item ?? '', fulfill_department: l.fulfill_department as Department,
      prepare_department: (l.prepare_department as Department | null) ?? null,
      serving_at: l.serving_at ?? '', line_type: (l.line_type as LineType) ?? 'delivery',
      source: (l.source as 'default' | 'special') ?? 'default', note: l.note ?? '', active: l.active ?? true,
    }))
    setSavedRooms((prev) => ({ ...prev, [roomNo]: freshLines }))
    setRoomStatuses(nextStatuses)
    setBlankRooms((p) => p.filter((n) => n !== roomNo))
    await loadEvents(oid)
    setBusy(false)
    return true
  }

  // Rooms the user never touched (no saved lines AND no explicit status) → get check-in defaults.
  const untouchedRooms = () => rooms.filter((r) => !savedRooms[r.no] && !roomStatuses[r.no])

  // Rooms that would be submitted with NO order — zero active items and not marked Empty/Out of order.
  const findBlankRooms = (): string[] => rooms.filter((r) => {
    const st = statusForRoom(r.no)
    if (st === 'empty' || st === 'oo') return false // intentionally has no order
    const lines = savedRooms[r.no] ?? seedLines(recipeForRoom(r), date, st)
    return !lines.some((l) => l.active && (l.item.trim() || l.slot.trim()))
  }).map((r) => r.no)

  async function submit() {
    if (busy) return
    setBusy(true)
    const blanks = findBlankRooms()
    if (blanks.length > 0) {
      setBusy(false)
      // Surface the unassigned rooms and let the user choose: go back & assign, or mark them Empty.
      setBlankRooms(blanks)
      setBlankPrompt(blanks)
      return
    }
    setBlankRooms([])
    await performSubmit(roomStatuses)
  }

  // Mark the still-unassigned rooms as Empty, then submit (chosen from the blank-rooms dialog).
  async function emptyBlanksAndSubmit() {
    if (busy) return
    setBusy(true)
    const blanks = blankPrompt ?? []
    const orderResult = await ensureOrder(); if (!orderResult) { setBusy(false); return } const oid = orderResult.id
    const next = { ...roomStatuses }
    blanks.forEach((no) => { next[no] = 'empty' })
    const { error } = await supabase.from('kaizen_rr_room_orders').update({ room_statuses: next }).eq('id', oid)
    if (error) { setBusy(false); toast.error(error.message); return }
    await logRoomEvent(companyId, oid, date, profile?.id, 'emptied_rest', String(blanks.length))
    setRoomStatuses(next)
    setBlankRooms([])
    setBlankPrompt(null)
    setBusy(false)
    await performSubmit(next)
  }

  async function performSubmit(statuses: Record<string, RoomStatus>) {
    if (!profile) { setBusy(false); toast.error(lang === 'th' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'Session expired — please sign in again'); return }
    // RO-001: do NOT read the busy React state here — callers own the busy lifecycle
    // and setBusy(false) is not synchronous, so reading it here returns a stale true.
    setBusy(true)
    const orderResult = await ensureOrder(); if (!orderResult) { setBusy(false); return } const oid = orderResult.id
    // Materialize defaults for any room not explicitly saved or statused.
    const untouched = rooms.filter((r) => !savedRooms[r.no] && !statuses[r.no])
    const rows = untouched.flatMap((r) => seedLines(recipeForRoom(r), date).filter((l) => l.item.trim() || l.slot.trim()).map((l) => lineRow(oid, r.no, r, l)))
    if (rows.length > 0) {
      const { error } = await supabase.from('kaizen_rr_room_lines').insert(rows)
      if (error) { setBusy(false); toast.error(error.message); return }
    }
    const wasSubmitted = orderResult.status === 'submitted'
    const prevSubmittedAt = submittedAt // the previous submit time (for "what's new" on re-submit)
    const { error: e2 } = await supabase.from('kaizen_rr_room_orders')
      .update({ status: 'submitted', submitted_by: profile.id, submitted_at: new Date().toISOString() }).eq('id', oid)
    if (e2) { setBusy(false); toast.error(e2.message); return }
    await logRoomEvent(companyId, oid, date, profile.id, wasSubmitted ? 'resubmitted' : 'submitted', null)
    // Alert managers if special requests are awaiting approval for this date.
    const { count } = await supabase.from('kaizen_rr_room_lines')
      .select('id', { count: 'exact', head: true })
      .eq('room_order_id', oid).eq('source', 'special').eq('active', true).eq('approval_status', 'pending')
    if ((count ?? 0) > 0) {
      await notifyManagers(companyId, profile?.id,
        lang === 'th' ? 'ออเดอร์ห้อง — มีคำขอพิเศษรออนุมัติ' : 'Room order — special requests need approval',
        lang === 'th'
          ? `มีคำขอพิเศษ ${count} รายการสำหรับวันที่ ${date} รอการอนุมัติจากคุณ`
          : `${count} special request${count === 1 ? '' : 's'} for ${date} need your approval.`)
    }
    // Notify the fulfilling departments: on first submit, all of them; on a re-submit, only
    // departments that gained new lines since the previous submit (so edits still reach a
    // newly-involved department without re-blasting everyone).
    await notifyFulfillers(companyId, oid, date, profile.id, lang, wasSubmitted ? prevSubmittedAt : null)
    setBusy(false)
    toast.success(lang === 'th' ? 'ส่งใบสั่งห้องแล้ว' : 'Room order submitted')
    load()
  }

  // Wipe everything for this date and start over.
  async function resetAll() {
    setConfirmReset(false)
    setBusy(true)
    if (orderId) {
      const { error } = await supabase.from('kaizen_rr_room_orders').delete().eq('id', orderId)
      if (error) { setBusy(false); toast.error(error.message); return }
    }
    setBusy(false)
    toast.success(lang === 'th' ? 'ล้างแล้ว' : 'Reset')
    load()
  }

  // Mark every still-untouched room as Empty (no items) in one go.
  async function emptyRest() {
    if (busy) return
    const targets = untouchedRooms()
    if (targets.length === 0) { toast.info(lang === 'th' ? 'ไม่มีห้องที่ยังไม่ได้ตั้งค่า' : `No untouched ${many.toLowerCase()} left`); return }
    setBusy(true)  // RO-003: set busy before the first await to block concurrent clicks
    const orderResult = await ensureOrder(); if (!orderResult) { setBusy(false); return } const oid = orderResult.id
    const next = { ...roomStatuses }
    targets.forEach((r) => { next[r.no] = 'empty' })
    const { error } = await supabase.from('kaizen_rr_room_orders').update({ room_statuses: next }).eq('id', oid)
    setBusy(false)
    if (error) { toast.error(error.message); return }
    await logRoomEvent(companyId, oid, date, profile?.id, 'emptied_rest', String(targets.length))
    setRoomStatuses(next)
    setBlankRooms((p) => p.filter((n) => !targets.some((t) => t.no === n)))
    await loadEvents(oid)
    toast.success(lang === 'th' ? `ตั้งค่า ${targets.length} ${one} เป็นว่างแล้ว` : `${targets.length} ${(targets.length === 1 ? one : many).toLowerCase()} set to Empty`)
  }

  const buildings = Array.from(new Set(rooms.map((r) => buildingOf(r.no)))).sort()
  const orderedRoomNos = rooms.map((r) => r.no)
  const nextRoom = (no: string) => { const i = orderedRoomNos.indexOf(no); return i >= 0 && i < orderedRoomNos.length - 1 ? orderedRoomNos[i + 1] : null }

  const dateLabel = parseDateOnlyBkk(date).toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB',
    { timeZone: 'Asia/Bangkok', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  const savedCount = Object.keys(savedRooms).length

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>

  if (rooms.length === 0) return (
    <div className="text-center py-16 bg-white rounded-xl border border-gray-200 px-6">
      <DoorOpen className="h-8 w-8 text-gray-300 mx-auto mb-2" />
      <p className="text-sm text-gray-500">{lang === 'th' ? `ยังไม่ได้ตั้งค่า${one}` : `No ${many.toLowerCase()} configured yet.`}</p>
      <p className="text-xs text-gray-400 mt-1">{lang === 'th' ? `เพิ่ม${one}ใน ตั้งค่า → Routine Roster → การตั้งค่า${one}` : `Add ${many.toLowerCase()} in Settings → Routine Roster → ${one} Setup.`}</p>
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Date row */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setDate(shiftDate(date, -1))} className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400"><ChevronLeft className="h-4 w-4" /></button>
        <div className="flex-1 text-center">
          <p className="text-sm font-semibold text-gray-900">{dateLabel}</p>
          <p className="text-[11px] text-gray-400">{lang === 'th' ? 'วันเช็คอิน' : 'Check-in date'}{date === shiftDate(today, 1) ? ` · ${lang === 'th' ? 'พรุ่งนี้' : 'tomorrow'}` : date === today ? ` · ${lang === 'th' ? 'วันนี้' : 'today'}` : ''}</p>
        </div>
        <button onClick={() => setDate(shiftDate(date, 1))} className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400"><ChevronRight className="h-4 w-4" /></button>
      </div>

      {/* Status banner */}
      {orderStatus === 'submitted' ? (
        <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          <span>
            {lang === 'th' ? 'ส่งแล้ว' : 'Submitted'}{submittedByName ? (lang === 'th' ? ` โดย ${submittedByName}` : ` by ${submittedByName}`) : ''}{submittedAt ? ` · ${new Date(submittedAt).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })}` : ''}
          </span>
          <span className="ml-auto text-[11px] text-green-700">{lang === 'th' ? 'แก้ไขแล้วกดส่งอีกครั้งได้' : 'Edit & re-submit anytime'}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <span className="font-medium">{lang === 'th' ? 'ฉบับร่าง' : 'Draft'}</span>
          <span className="text-[12px] text-amber-700">· {lang === 'th' ? `แก้ไข ${savedCount} ${one} · ที่เหลือใช้ค่าเริ่มต้น` : `${savedCount} ${(savedCount === 1 ? one : many).toLowerCase()} edited · the rest use defaults`}</span>
        </div>
      )}

      {/* Change history — who placed / re-submitted / edited and when */}
      {events.length > 0 && (
        <div>
          <button onClick={() => setShowHistory((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-[var(--brand-primary)]">
            <History className="h-3.5 w-3.5" />{lang === 'th' ? 'ประวัติการเปลี่ยนแปลง' : 'History'} ({events.length})
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
          </button>
          {showHistory && (
            <div className="mt-1.5 rounded-xl border border-gray-200 bg-white divide-y divide-gray-50 max-h-56 overflow-y-auto">
              {events.map((e) => (
                <div key={e.id} className="px-3 py-2 text-[12px] flex items-start gap-2">
                  <span className="text-gray-400 w-[88px] flex-shrink-0">{fmtEventTime(e.created_at, lang)}</span>
                  <span className="text-gray-700"><span className="font-medium text-gray-900">{e.actorName}</span> {eventLabel(e, lang)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Room grid by building */}
      {buildings.map((b) => {
        const list = rooms.filter((r) => buildingOf(r.no) === b)
        return (
          <div key={b}>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">{lang === 'th' ? 'อาคาร' : 'Building'} {b}</p>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {list.map((r) => {
                const saved = savedRooms[r.no]
                const specials = (saved ?? []).filter((l) => l.source === 'special').length
                const cat = catOf(r.type)
                const rs = roomStatuses[r.no]
                const stCls = rs === 'oo' ? 'bg-red-50 text-red-600' : rs === 'empty' ? 'bg-gray-100 text-gray-500' : rs === 'occupied' ? 'bg-blue-50 text-blue-600' : ''
                return (
                  <button key={r.no} onClick={() => setOpenRoom(r.no)}
                    className={`relative flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left transition-all hover:shadow-sm ${saved ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                    <span className="text-sm font-semibold text-gray-800">{r.no}</span>
                    <span className="text-[10px] text-gray-400 truncate w-full" title={cat?.name}>{r.type}</span>
                    {rs && rs !== 'checkin' && <span className={`mt-0.5 text-[9px] px-1 rounded ${stCls}`}>{statusLabel(rs, lang)}</span>}
                    {specials > 0 && <span className="absolute top-1 right-1 text-[9px] font-bold px-1 rounded-full bg-amber-500 text-white">+{specials}</span>}
                    {saved && specials === 0 && <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--brand-primary)]" />}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* Validation: rooms that would be submitted with no order */}
      {blankRooms.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-red-700">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {lang === 'th'
              ? `มี ${blankRooms.length} ${one} ที่ยังไม่ได้สั่ง`
              : `${blankRooms.length} ${(blankRooms.length === 1 ? one : many).toLowerCase()} ${blankRooms.length === 1 ? 'has' : 'have'} no order placed`}
          </p>
          <p className="text-[12px] text-red-600 mt-0.5">
            {lang === 'th' ? 'แตะเพื่อเปิดและสั่ง หรือทำเครื่องหมายว่าง/งดใช้งาน' : 'Tap a ' + one.toLowerCase() + ' to place an order, or mark it Empty / Out of order.'}
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {blankRooms.map((no) => (
              <button key={no} onClick={() => setOpenRoom(no)}
                className="text-[11px] font-medium px-2 h-6 rounded-md bg-white border border-red-300 text-red-600 hover:bg-red-100">
                {no}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions — only order-placers (Top Management / Front Office) can change the order.
          The three buttons share the row equally (flex-1) so they always fit on one line
          regardless of screen width; labels shrink to icon-friendly sizes on narrow screens. */}
      <div className="flex items-stretch gap-2 pt-2 border-t border-gray-100">
        {canPlace && (<>
          <button onClick={submit} disabled={busy}
            className="flex-1 min-w-0 flex items-center justify-center gap-1 bg-[var(--brand-primary)] text-white text-xs sm:text-sm font-semibold px-2 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" /> : <Send className="h-4 w-4 flex-shrink-0 hidden sm:block" />}
            <span className="truncate">{orderStatus === 'submitted' ? (lang === 'th' ? 'ส่งอีกครั้ง' : 'Re-submit') : (lang === 'th' ? 'ส่งใบสั่ง' : 'Submit order')}</span>
          </button>
          <button onClick={emptyRest} disabled={busy}
            className="flex-1 min-w-0 flex items-center justify-center gap-1 border border-gray-300 text-gray-600 hover:bg-gray-50 text-xs sm:text-sm font-medium px-2 h-9 rounded-lg disabled:opacity-50">
            <DoorClosed className="h-4 w-4 flex-shrink-0 hidden sm:block" /><span className="truncate">{lang === 'th' ? 'ที่เหลือ = ว่าง' : 'Empty the rest'}</span>
          </button>
          {/* Reset DELETEs the whole order (lines + history cascade), so it must be
              gated to order-placers too — a view-only fulfilling-dept manager must not
              be able to destroy a submitted order. RLS is tightened to match. */}
          <button onClick={() => setConfirmReset(true)} disabled={busy}
            className="flex-1 min-w-0 flex items-center justify-center gap-1 border border-gray-300 text-red-500 hover:bg-red-50 text-xs sm:text-sm font-medium px-2 h-9 rounded-lg disabled:opacity-50">
            <RotateCcw className="h-4 w-4 flex-shrink-0 hidden sm:block" /><span className="truncate">{lang === 'th' ? 'ล้าง' : 'Reset'}</span>
          </button>
        </>)}
      </div>
      {!canPlace && (
        <div className="flex items-center gap-1.5 pt-1 text-[12px] text-gray-400">
          <Eye className="h-3.5 w-3.5 flex-shrink-0" />
          {lang === 'th' ? 'มุมมองอย่างเดียว — เฉพาะแผนกต้อนรับและผู้บริหารระดับสูงสามารถสั่งได้' : 'View only — orders are placed by Front Office or Top Management.'}
        </div>
      )}

      {openRoom && (() => {
        const room = rooms.find((r) => r.no === openRoom)!
        return (
          <RoomSheet
            room={room} cat={catOf(room.type)} items={items} lang={lang} unit={unit}
            initial={linesForRoom(room)} initialStatus={statusForRoom(room.no)}
            busy={busy} canManage={canManage} readOnly={!canPlace}
            nextRoomNo={nextRoom(openRoom)}
            onClose={() => setOpenRoom(null)}
            onSave={async (lines, status, goNext) => {
              const ok = await saveRoom(openRoom!, lines, status)
              if (ok) { if (goNext && nextRoom(openRoom!)) setOpenRoom(nextRoom(openRoom!)); else setOpenRoom(null) }
            }}
          />
        )
      })()}

      {/* Reset confirmation dialog */}
      {confirmReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setConfirmReset(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <RotateCcw className="h-5 w-5 text-red-500 flex-shrink-0" />
                <h3 className="text-base font-bold text-gray-900">
                  {lang === 'th' ? 'ล้างใบสั่งทั้งหมด?' : 'Reset all orders?'}
                </h3>
              </div>
              <p className="text-sm text-gray-500">
                {lang === 'th'
                  ? 'การดำเนินการนี้จะลบรายการสั่งของทุกห้องในวันนี้ทั้งหมด ไม่สามารถกู้คืนได้'
                  : 'This will clear every room order for this date. This action cannot be undone.'}
              </p>
            </div>
            <div className="flex items-center gap-2 px-5 py-4 bg-gray-50 border-t border-gray-100">
              <button onClick={() => setConfirmReset(false)} disabled={busy}
                className="flex-1 h-10 rounded-lg border border-gray-300 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                {lang === 'th' ? 'ยกเลิก' : 'Cancel'}
              </button>
              <button onClick={resetAll} disabled={busy}
                className="flex-1 h-10 rounded-lg bg-red-500 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50 flex items-center justify-center gap-1.5">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                {lang === 'th' ? 'ล้างทั้งหมด' : 'Reset all'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unassigned-rooms confirmation: assign them, or mark Empty and submit */}
      {blankPrompt && blankPrompt.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setBlankPrompt(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0" />
                <h3 className="text-base font-bold text-gray-900">
                  {lang === 'th'
                    ? `${blankPrompt.length} ${one} ยังไม่ได้สั่ง`
                    : `${blankPrompt.length} ${(blankPrompt.length === 1 ? one : many).toLowerCase()} not assigned`}
                </h3>
              </div>
              <p className="text-sm text-gray-500">
                {lang === 'th'
                  ? `${one}เหล่านี้จะถูกส่งโดยไม่มีรายการ คุณต้องการสั่งก่อน หรือทำเครื่องหมายว่าง?`
                  : `These ${(blankPrompt.length === 1 ? one : many).toLowerCase()} would be submitted with no order. Assign them first, or mark them as Empty?`}
              </p>
              <div className="flex flex-wrap gap-1 mt-3 max-h-32 overflow-y-auto">
                {blankPrompt.map((no) => (
                  <span key={no} className="text-[11px] font-medium px-2 h-6 inline-flex items-center rounded-md bg-amber-50 border border-amber-200 text-amber-700">{no}</span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 px-5 py-4 bg-gray-50 border-t border-gray-100">
              <button onClick={() => setBlankPrompt(null)} disabled={busy}
                className="flex-1 h-10 rounded-lg border border-gray-300 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                {lang === 'th' ? 'กลับไปสั่ง' : 'Go back & assign'}
              </button>
              <button onClick={emptyBlanksAndSubmit} disabled={busy}
                className="flex-1 h-10 rounded-lg bg-[var(--brand-primary)] text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <DoorClosed className="h-4 w-4" />}
                {lang === 'th' ? 'ทำเครื่องหมายว่างและส่ง' : 'Mark Empty & submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── per-room sheet ───────────────────────────────────────────────────────────

function RoomSheet({ room, cat, items, lang, unit, initial, initialStatus, busy, readOnly, nextRoomNo, onClose, onSave }: {
  room: Room
  cat: RoomCategory | undefined
  items: RrItem[]
  lang: 'en' | 'th'
  unit: UnitNoun
  initial: SheetLine[]
  initialStatus: RoomStatus
  busy: boolean
  canManage: boolean
  readOnly?: boolean
  nextRoomNo: string | null
  onClose: () => void
  onSave: (lines: SheetLine[], status: RoomStatus, goNext: boolean) => void
}) {
  const one = unitOne(unit, lang)
  const [lines, setLines] = useState<SheetLine[]>(initial)
  const [status, setStatus] = useState<RoomStatus>(initialStatus)
  // reseed when navigating to a different room
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLines(initial); setStatus(initialStatus) }, [room.no])

  function patch(id: string, fields: Partial<SheetLine>) {
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, ...fields } : l))
  }
  function remove(id: string) { setLines((prev) => prev.filter((l) => l.id !== id)) }
  function addSpecial() {
    setLines((prev) => [...prev, { id: newId(), slot: '', item: '', fulfill_department: DEPT_OPTIONS[0]?.value ?? 'restaurant', prepare_department: null, serving_at: '', line_type: 'delivery', source: 'special', note: '', active: status !== 'empty' && status !== 'oo' }])
  }
  // Changing the room status re-applies the default active preset to every line.
  function applyStatus(s: RoomStatus) {
    setStatus(s)
    setLines((prev) => prev.map((l) => l.source === 'special' ? l : { ...l, active: lineActiveFor(s, l.slot) }))
  }

  const defaults = lines.filter((l) => l.source === 'default')
  const specials = lines.filter((l) => l.source === 'special')
  const STATUSES: RoomStatus[] = ['checkin', 'occupied', 'empty', 'oo']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-gray-900">{room.no} <span className="text-sm font-normal text-gray-500">· {cat?.name ?? room.type}</span></h3>
            <p className="text-xs text-gray-400 mt-0.5">{room.type}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>

        {/* Room status — drives which default lines are active */}
        <div className="px-5 pt-3 flex-shrink-0">
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs font-medium">
            {STATUSES.map((s) => (
              <button key={s} onClick={() => applyStatus(s)} disabled={readOnly}
                className={`flex-1 px-2 h-8 whitespace-nowrap transition-colors disabled:cursor-default ${status === s ? (s === 'oo' ? 'bg-red-500 text-white' : 'bg-[var(--brand-primary)] text-white') : `bg-white text-gray-600 ${readOnly ? '' : 'hover:bg-gray-50'}`}`}>
                {statusLabel(s, lang)}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-1">
            {status === 'checkin' ? (lang === 'th' ? 'เปิดทุกรายการสำหรับลูกค้าเช็คอินวันนี้' : 'All items on, for a guest checking in.')
              : status === 'occupied' ? (lang === 'th' ? 'ข้ามผลไม้ต้อนรับและมินิบาร์ (แขกพักต่อคืนถัดไป)' : 'Welcome fruit & minibar off — guest staying another night.')
              : status === 'empty' ? (lang === 'th' ? 'ห้องว่าง — ไม่มีรายการ' : 'Empty — no items.')
              : (lang === 'th' ? 'งดใช้งาน — ไม่มีรายการ' : 'Out of order — no items.')}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {defaults.map((l) => <LineRow key={l.id} line={l} items={items} lang={lang} onPatch={patch} onRemove={remove} onToggle={(on) => patch(l.id, { active: on })} readOnly={readOnly} />)}

          {(specials.length > 0 || !readOnly) && (
            <div className="pt-2">
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">{lang === 'th' ? 'คำขอพิเศษ' : 'Special requests'}</p>
              {specials.map((l) => <LineRow key={l.id} line={l} items={items} lang={lang} onPatch={patch} onRemove={remove} onToggle={(on) => patch(l.id, { active: on })} special readOnly={readOnly} />)}
              {!readOnly && (
                <button onClick={addSpecial}
                  className="w-full flex items-center justify-center gap-1.5 h-9 rounded-lg border border-dashed border-gray-200 text-sm text-gray-400 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors mt-1">
                  <Plus className="h-4 w-4" />{lang === 'th' ? 'เพิ่มคำขอพิเศษ' : 'Add special request'}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200 flex-shrink-0">
          {readOnly ? (
            <>
              <span className="flex items-center gap-1.5 text-[12px] text-gray-400"><Eye className="h-3.5 w-3.5" />{lang === 'th' ? 'มุมมองอย่างเดียว' : 'View only'}</span>
              <button onClick={onClose} className="px-3 h-9 rounded-lg text-gray-500 hover:bg-gray-100 text-sm ml-auto">{lang === 'th' ? 'ปิด' : 'Close'}</button>
            </>
          ) : (
            <>
              <button onClick={() => onSave(lines, status, false)} disabled={busy}
                className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? `บันทึก${one}` : `Save ${one.toLowerCase()}`}
              </button>
              {nextRoomNo && (
                <button onClick={() => onSave(lines, status, true)} disabled={busy}
                  className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50 disabled:opacity-50">
                  {lang === 'th' ? `บันทึกและไป${one}ถัดไป` : 'Save & next'} <ArrowRight className="h-3.5 w-3.5" />
                </button>
              )}
              <button onClick={onClose} className="px-3 h-9 rounded-lg text-gray-500 hover:bg-gray-100 text-sm ml-auto">{lang === 'th' ? 'ปิด' : 'Close'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function LineRow({ line: l, items, lang, onPatch, onRemove, onToggle, special, readOnly }: {
  line: SheetLine
  items: RrItem[]
  lang: 'en' | 'th'
  onPatch: (id: string, fields: Partial<SheetLine>) => void
  onRemove: (id: string) => void
  onToggle: (on: boolean) => void
  special?: boolean
  readOnly?: boolean
}) {
  // Both regular and special-request lines pick from the item's owning dept catalog —
  // for a handoff line that's the PREPARER (who makes it), else the single dept.
  const catalogDept = l.prepare_department ?? l.fulfill_department
  const deptItems = items.filter((it) => it.department === catalogDept)
  return (
    <div className={`rounded-lg border border-gray-100 p-2.5 space-y-2 transition-opacity ${l.active ? 'bg-gray-50/50' : 'bg-gray-100/40 opacity-55'}`}>
      <div className="flex items-center gap-2">
        <input type="checkbox" checked={l.active} onChange={(e) => onToggle(e.target.checked)} disabled={readOnly}
          title={lang === 'th' ? 'เปิด/ปิดรายการนี้' : 'Include this item'}
          className={`h-4 w-4 flex-shrink-0 accent-[var(--brand-primary)] ${readOnly ? 'cursor-default' : 'cursor-pointer'}`} />
        {special && !readOnly ? (
          <input value={l.slot} onChange={(e) => onPatch(l.id, { slot: e.target.value })}
            placeholder={lang === 'th' ? 'หัวข้อ' : 'Label e.g. Birthday cake'}
            className="flex-1 h-8 rounded-md border border-gray-200 px-2 text-sm font-medium bg-white focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40" />
        ) : (
          <span className="flex-1 text-sm font-medium text-gray-800">{l.slot || (special ? (lang === 'th' ? 'คำขอพิเศษ' : 'Special request') : '')}</span>
        )}
        {l.prepare_department ? (
          <span className="flex items-center gap-1 flex-shrink-0">
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${deptBadge(l.prepare_department)}`}>{deptLabel(l.prepare_department, lang)}</span>
            <ArrowRight className="h-3 w-3 text-gray-400" />
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${deptBadge(l.fulfill_department)}`}>{deptLabel(l.fulfill_department, lang)}</span>
          </span>
        ) : (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${deptBadge(l.fulfill_department)}`}>{deptLabel(l.fulfill_department, lang)}</span>
        )}
        {!readOnly && (
          <button onClick={() => onRemove(l.id)} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0"><Trash2 className="h-3.5 w-3.5" /></button>
        )}
      </div>

      {readOnly ? (
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-gray-600 pl-6">
          <span className="font-medium text-gray-800">{l.item || <span className="text-gray-300">{lang === 'th' ? '— ไม่ระบุ' : '— not set'}</span>}</span>
          {l.serving_at && <span className="text-gray-400">{lang === 'th' ? 'ภายใน' : 'by'} {l.serving_at}</span>}
          {special && l.note && <span className="text-gray-400">· {l.note}</span>}
        </div>
      ) : (
        <div className={`grid grid-cols-1 sm:grid-cols-2 gap-2 ${l.active ? '' : 'pointer-events-none'}`}>
          {special && (
            <select value={l.fulfill_department} onChange={(e) => onPatch(l.id, { fulfill_department: e.target.value as Department, item: '' })}
              className="h-8 rounded-md border border-gray-200 px-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40">
              {DEPT_OPTIONS.map((d) => <option key={d.value} value={d.value}>{deptLabel(d.value, lang)}</option>)}
            </select>
          )}
          <ItemField value={l.item} options={deptItems} lang={lang} onChange={(v) => onPatch(l.id, { item: v })} />
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-gray-400 flex-shrink-0">{lang === 'th' ? 'เวลา' : 'by'}</span>
            <input type="time" value={l.serving_at} onChange={(e) => onPatch(l.id, { serving_at: e.target.value })}
              className="h-8 w-full rounded-md border border-gray-200 px-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40" />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${l.line_type === 'checklist' ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-600'}`}>
          {l.line_type === 'checklist' ? <ListChecks className="h-3 w-3" /> : <Truck className="h-3 w-3" />}
          {l.line_type === 'checklist' ? (lang === 'th' ? 'เช็คลิสต์' : 'Checklist') : (lang === 'th' ? 'จัดส่ง' : 'Delivery')}
        </span>
        {special && !readOnly && (
          <input value={l.note} onChange={(e) => onPatch(l.id, { note: e.target.value })}
            placeholder={lang === 'th' ? 'หมายเหตุ' : 'note (optional)'}
            className="flex-1 h-7 rounded-md border border-gray-200 px-2 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40" />
        )}
      </div>
    </div>
  )
}

// ── fulfilment board (a department's morning view of its room-order lines) ──────

interface FulfilLine {
  id: string; room_no: string; slot: string | null; item: string | null
  fulfill_department: string; prepare_department: string | null
  serving_at: string | null; line_type: LineType; source: 'default' | 'special'
  note: string | null; status: 'pending' | 'acknowledged' | 'ready' | 'done'
  delivered_by: string | null; delivered_at: string | null
  prepared_by: string | null; prepared_at: string | null
}

function RoomFulfilBoard({ companyId, dept, unit, initialDate }: { companyId: string; dept: Department; unit: UnitNoun; initialDate?: string }) {
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const one = unitOne(unit, lang)
  const today = bangkokDate()
  const [date, setDate] = useState(initialDate ?? today) // fulfil happens on the service date
  const [groupBy, setGroupBy] = useState<'item' | 'room'>('item')
  const [lines, setLines] = useState<FulfilLine[]>([])
  const [names, setNames] = useState<Record<string, string>>({}) // deliverer/preparer id → name
  const [orderId, setOrderId] = useState<string | null>(null)
  const [orderExists, setOrderExists] = useState(false)
  const [submittedBy, setSubmittedBy] = useState<string | null>(null) // who placed the order (for delivered pings)
  const [prepBufferMin, setPrepBufferMin] = useState(DEFAULT_PREP_BUFFER_MIN) // serving_at minus this = "prep by" hint
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data: order } = await supabase.from('kaizen_rr_room_orders').select('id, status, submitted_by')
      .eq('company_id', companyId).eq('order_date', date).maybeSingle()
    const o = order as { id: string; status: string; submitted_by: string | null } | null
    if (!o || o.status !== 'submitted') { setOrderId(null); setLines([]); setOrderExists(false); setSubmittedBy(null); setLoading(false); return }
    setOrderId(o.id)
    setSubmittedBy(o.submitted_by ?? null)
    // Fire the auto-release safety net for the VIEWED date so an un-approved overdue special
    // surfaces on the fulfilling dept's board instead of silently staying hidden as 'pending'.
    const cfg = await loadApprovalConfig(companyId)
    if (cfg.require) await escalateOverdueSpecials(companyId, date, cfg, lang)
    // This dept sees a line if it DELIVERS it (fulfill_department) OR PREPARES it
    // (prepare_department, two-stage handoff). Two filtered queries merged by id — avoids
    // PostgREST .or() parsing issues with custom department labels that contain punctuation.
    const base = () => supabase.from('kaizen_rr_room_lines').select('*')
      .eq('room_order_id', o.id).eq('active', true).in('approval_status', ['approved', 'auto'])
    const [delRes, prepRes] = await Promise.all([
      base().eq('fulfill_department', dept),
      base().eq('prepare_department', dept),
    ])
    const merged = new Map<string, FulfilLine>()
    ;[...((delRes.data as FulfilLine[]) ?? []), ...((prepRes.data as FulfilLine[]) ?? [])].forEach((l) => merged.set(l.id, l))
    const list = [...merged.values()]
    setOrderExists(true)
    setLines(list)
    // Prep-by hint buffer (serving time − N minutes), configured with the recipes.
    const { data: bufRow } = await supabase.from('kaizen_settings').select('value')
      .eq('company_id', companyId).eq('key', 'rr_prep_buffer_min').maybeSingle()
    const buf = bufRow?.value as number | undefined
    setPrepBufferMin(typeof buf === 'number' && buf >= 0 ? buf : DEFAULT_PREP_BUFFER_MIN)
    const ids = [...new Set(list.flatMap((l) => [l.delivered_by, l.prepared_by]).filter(Boolean))] as string[]
    if (ids.length > 0) {
      const { data: profs } = await supabase.from('kaizen_profiles').select('id, full_name').in('id', ids)
      const m: Record<string, string> = {}
      ;((profs as { id: string; full_name: string }[]) ?? []).forEach((p) => { m[p.id] = p.full_name })
      setNames(m)
    } else setNames({})
    setLoading(false)
  }, [companyId, date, dept, lang])
  useEffect(() => { load() }, [load])

  // A line relates to THIS dept as either its preparer or its deliverer.
  const isPrep = (l: FulfilLine) => l.prepare_department === dept && l.fulfill_department !== dept
  const isHandoffDeliver = (l: FulfilLine) => !!l.prepare_department && l.fulfill_department === dept
  const isSingle = (l: FulfilLine) => !l.prepare_department && l.fulfill_department === dept
  // "Done" from this dept's perspective: a preparer is finished once the line is ready.
  const lineDone = (l: FulfilLine) => isPrep(l) ? (l.status === 'ready' || l.status === 'done') : l.status === 'done'

  const total = lines.length
  const doneCount = lines.filter(lineDone).length
  // The acknowledge gate governs single-stage lines only; handoff lines have their own stages.
  const singleLines = lines.filter(isSingle)
  const pendingCount = singleLines.filter((l) => l.status === 'pending').length
  const acknowledged = pendingCount === 0

  async function acknowledgeAll() {
    if (!orderId || !profile) return
    setBusy(true)
    const { data: affected, error } = await supabase.from('kaizen_rr_room_lines')
      .update({ status: 'acknowledged', acknowledged_by: profile.id, acknowledged_at: new Date().toISOString() })
      .eq('room_order_id', orderId).eq('fulfill_department', dept).eq('status', 'pending')
      .is('prepare_department', null) // single-stage only; handoff lines flow pending→ready→done
      .eq('active', true).in('approval_status', ['approved', 'auto']) // only board-visible lines
      .select('id')
    setBusy(false)
    if (error) { toast.error(error.message); return }
    if ((affected ?? []).length === 0) { load(); return } // already acknowledged
    await logRoomEvent(companyId, orderId, date, profile.id, 'order_received', dept)
    toast.success(lang === 'th' ? 'รับงานแล้ว' : 'Order received')
    load()
  }

  const itemText = (l: FulfilLine) => l.item?.trim() || l.slot?.trim() || (lang === 'th' ? 'รายการ' : 'item')

  // Tell the deliverer dept a handoff line is ready to pick up and deliver.
  async function notifyReady(l: FulfilLine) {
    if (!companyId) return
    const recipients = await resolveDeptRecipients(companyId, l.fulfill_department)
    const title = lang === 'th' ? 'พร้อมจัดส่ง' : 'Ready to deliver'
    const message = lang === 'th'
      ? `${itemText(l)} — ${one} ${l.room_no} พร้อมแล้ว (เตรียมโดย${deptLabel(dept, lang)})`
      : `${itemText(l)} — ${one} ${l.room_no} is ready to deliver (prepared by ${deptLabel(dept, lang)}).`
    const rows = recipients.filter((p) => p.id !== profile?.id)
      .map((p) => ({ user_id: p.id, title, message, notification_type: 'rr' }))
    if (rows.length > 0) await supabase.from('kaizen_notifications').insert(rows)
  }

  // Confirm to whoever placed the order that a handoff item reached the guest.
  async function notifyDelivered(l: FulfilLine) {
    if (!submittedBy || submittedBy === profile?.id) return
    const title = lang === 'th' ? 'จัดส่งแล้ว' : 'Delivered'
    const message = lang === 'th'
      ? `${itemText(l)} จัดส่งไปยัง${one} ${l.room_no} แล้ว`
      : `${itemText(l)} delivered to ${one} ${l.room_no}.`
    await supabase.from('kaizen_notifications').insert([{ user_id: submittedBy, title, message, notification_type: 'rr' }])
  }

  async function toggleLine(l: FulfilLine) {
    if (!profile || busy) return
    const at = new Date().toISOString()
    let patch: Partial<FulfilLine>
    let after: (() => Promise<void>) | null = null
    if (isPrep(l)) {
      if (l.status === 'done') return // already delivered downstream — preparer can't change it
      const toReady = l.status !== 'ready'
      patch = toReady
        ? { status: 'ready', prepared_by: profile.id, prepared_at: at }
        : { status: 'pending', prepared_by: null, prepared_at: null }
      if (toReady) after = async () => {
        await notifyReady(l)
        if (orderId) await logRoomEvent(companyId, orderId, date, profile.id, 'prepared', `${l.room_no} · ${itemText(l)}`)
      }
    } else if (isHandoffDeliver(l)) {
      if (l.status === 'pending') { toast.info(lang === 'th' ? 'ครัวกำลังเตรียม ยังส่งไม่ได้' : 'Still being prepared — not ready to deliver yet.'); return }
      const toDone = l.status !== 'done'
      patch = toDone
        ? { status: 'done', delivered_by: profile.id, delivered_at: at }
        : { status: 'ready', delivered_by: null, delivered_at: null }
      if (toDone) after = () => notifyDelivered(l)
    } else {
      const toDone = l.status !== 'done'
      patch = toDone
        ? { status: 'done', delivered_by: profile.id, delivered_at: at }
        : { status: 'acknowledged', delivered_by: null, delivered_at: null }
    }
    setBusy(true)
    const { error } = await supabase.from('kaizen_rr_room_lines').update(patch).eq('id', l.id)
    setBusy(false)
    if (error) { toast.error(error.message); return }
    if (profile.full_name && (patch.delivered_by === profile.id || patch.prepared_by === profile.id)) {
      setNames((m) => ({ ...m, [profile.id]: profile.full_name }))
    }
    setLines((prev) => prev.map((x) => x.id === l.id ? { ...x, ...patch } : x))
    if (after) await after()
  }

  const dateLabel = parseDateOnlyBkk(date).toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB',
    { timeZone: 'Asia/Bangkok', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  const itemKey = (l: FulfilLine) => (l.item?.trim() || l.slot?.trim() || '—')

  // Group lines
  const groups = new Map<string, FulfilLine[]>()
  if (groupBy === 'item') {
    for (const l of lines.slice().sort((a, b) => itemKey(a).localeCompare(itemKey(b)))) (groups.get(itemKey(l)) ?? groups.set(itemKey(l), []).get(itemKey(l)))!.push(l)
  } else {
    for (const l of lines.slice().sort((a, b) => roomSort(a.room_no, b.room_no))) (groups.get(l.room_no) ?? groups.set(l.room_no, []).get(l.room_no))!.push(l)
  }

  const tickLabel = (l: FulfilLine) => l.line_type === 'checklist'
    ? (lang === 'th' ? 'จัดเตรียม' : 'set up') : (lang === 'th' ? 'จัดส่ง' : 'deliver')

  // Whether this dept can act on the line right now, given its role + stage.
  const canTick = (l: FulfilLine) => {
    if (isPrep(l)) return l.status !== 'done'              // kitchen: until delivered downstream
    if (isHandoffDeliver(l)) return l.status === 'ready' || l.status === 'done' // restaurant: only once prepared
    return acknowledged                                    // single-stage: after "Order received"
  }
  // The action verb shown on an actionable, not-yet-done line.
  const actionLabel = (l: FulfilLine) => isPrep(l)
    ? (lang === 'th' ? 'พร้อม' : 'mark ready')
    : tickLabel(l)
  // Handoff delivery line still being prepared upstream.
  const awaitingPrep = (l: FulfilLine) => isHandoffDeliver(l) && l.status === 'pending'

  return (
    <div className="space-y-4">
      {/* Date + group toggle */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setDate(shiftDate(date, -1))} className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400"><ChevronLeft className="h-4 w-4" /></button>
        <div className="flex-1 text-center">
          <p className="text-sm font-semibold text-gray-900">{deptLabel(dept, lang)} · {dateLabel}</p>
          <p className="text-[11px] text-gray-400">{date === today ? (lang === 'th' ? 'วันนี้' : 'today') : ''}</p>
        </div>
        <button onClick={() => setDate(shiftDate(date, 1))} className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400"><ChevronRight className="h-4 w-4" /></button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : total === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200 text-sm text-gray-400">
          {orderExists
            ? (lang === 'th' ? `ไม่มีรายการสำหรับแผนกนี้วันนี้` : 'No items for this department today.')
            : (lang === 'th' ? `ยังไม่มีใบสั่ง${one}สำหรับวันนี้` : 'No submitted order for this date.')}
        </div>
      ) : (
        <>
          {/* Summary + actions */}
          <div className="flex items-center gap-2 flex-wrap rounded-xl border border-gray-200 bg-white px-4 py-3">
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">{doneCount}/{total} {lang === 'th' ? 'เสร็จ' : 'done'}</p>
              <p className="text-[11px] text-gray-400">{!acknowledged ? (lang === 'th' ? `${pendingCount} รอรับงาน` : `${pendingCount} awaiting acknowledgement`) : singleLines.length > 0 ? (lang === 'th' ? 'รับงานแล้ว' : 'Acknowledged') : ''}</p>
            </div>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs font-medium">
              <button onClick={() => setGroupBy('item')} className={`px-2.5 h-8 ${groupBy === 'item' ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600'}`}>{lang === 'th' ? 'ตามรายการ' : 'By item'}</button>
              <button onClick={() => setGroupBy('room')} className={`px-2.5 h-8 ${groupBy === 'room' ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600'}`}>{lang === 'th' ? `ตาม${one}` : `By ${one.toLowerCase()}`}</button>
            </div>
            {!acknowledged && (
              <button onClick={acknowledgeAll} disabled={busy} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-3 h-9 rounded-lg disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'รับงาน' : 'Order received'}
              </button>
            )}
          </div>

          {/* Groups */}
          <div className="space-y-2">
            {Array.from(groups.entries()).map(([key, gls]) => (
              <div key={key} className="rounded-xl border border-gray-200 bg-white p-3">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-sm font-semibold text-gray-900">{key}</p>
                  <span className="text-[11px] text-gray-400">×{gls.length}</span>
                  {groupBy === 'item' && gls[0] && (
                    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${gls[0].line_type === 'checklist' ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-600'}`}>
                      {gls[0].line_type === 'checklist' ? <ListChecks className="h-3 w-3" /> : <Truck className="h-3 w-3" />}
                      {gls[0].line_type === 'checklist' ? (lang === 'th' ? 'เช็คลิสต์' : 'Checklist') : (lang === 'th' ? 'จัดส่ง' : 'Delivery')}
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-gray-400">{gls.filter(lineDone).length}/{gls.length}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {gls.slice().sort((a, b) => groupBy === 'item' ? roomSort(a.room_no, b.room_no) : itemKey(a).localeCompare(itemKey(b))).map((l) => {
                    const primary = groupBy === 'item' ? l.room_no : itemKey(l)
                    const done = lineDone(l)
                    const tickable = canTick(l)
                    const preparing = awaitingPrep(l)
                    // Whose name + time to show once this dept's step is complete.
                    const stampId = isPrep(l) ? l.prepared_by : l.delivered_by
                    const stampAt = isPrep(l) ? l.prepared_at : l.delivered_at
                    const prepByHint = isPrep(l) && !done ? minusMinutes(l.serving_at, prepBufferMin) : ''
                    return (
                      <button key={l.id} onClick={() => {
                        if (tickable) toggleLine(l)
                        else if (preparing) toast.info(lang === 'th' ? 'ครัวกำลังเตรียม ยังส่งไม่ได้' : 'Still being prepared — not ready to deliver yet.')
                        else toast.info(lang === 'th' ? 'กรุณากด “รับงาน” ก่อนติ๊กรายการ' : 'Acknowledge “Order received” before ticking items.')
                      }} disabled={busy}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${done ? 'border-green-200 bg-green-50' : preparing ? 'border-amber-200 bg-amber-50/50' : 'border-gray-200 bg-gray-50/50'} ${tickable ? 'hover:border-gray-300 cursor-pointer' : 'opacity-80 cursor-not-allowed'}`}>
                        <span className={`h-4 w-4 rounded flex items-center justify-center flex-shrink-0 border ${done ? 'bg-green-500 border-green-500 text-white' : 'border-gray-300 bg-white'}`}>
                          {done && <Check className="h-3 w-3" />}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className={`text-sm ${done ? 'text-green-800 line-through' : 'text-gray-800'}`}>{primary}</span>
                          {l.source === 'special' && <span className="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-700 align-middle">{lang === 'th' ? 'พิเศษ' : 'special'}</span>}
                          {(l.serving_at || l.note || prepByHint) && (
                            <span className="block text-[11px] text-gray-400 truncate">
                              {prepByHint ? `${lang === 'th' ? 'เตรียมให้เสร็จภายใน' : 'prep by'} ${prepByHint}` : (l.serving_at ? `${lang === 'th' ? 'ภายใน' : 'by'} ${l.serving_at}` : '')}
                              {(prepByHint || l.serving_at) && l.note ? ' · ' : ''}{l.note ?? ''}
                            </span>
                          )}
                          {done && stampId && (
                            <span className="block text-[11px] text-green-600 truncate">
                              ✓ {names[stampId] ?? '—'}{stampAt ? ` · ${new Date(stampAt).toLocaleTimeString(lang === 'th' ? 'th-TH' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })}` : ''}
                            </span>
                          )}
                        </span>
                        {preparing
                          ? <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 flex-shrink-0">{lang === 'th' ? `กำลังเตรียม · ${deptLabel(l.prepare_department ?? '', lang)}` : `Preparing · ${deptLabel(l.prepare_department ?? '', lang)}`}</span>
                          : (tickable && !done && <span className="text-[10px] text-gray-400 flex-shrink-0">{actionLabel(l)}</span>)}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── approvals view (managers approve / reject special requests) ─────────────────

interface SpecialLine {
  id: string; room_no: string; slot: string | null; item: string | null
  fulfill_department: string; serving_at: string | null; note: string | null
  approval_status: 'pending' | 'approved' | 'rejected' | 'auto'
}

function RoomApprovalsView({ companyId, onChanged }: { companyId: string; onChanged: () => void }) {
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const today = bangkokDate()
  const [date, setDate] = useState(today)
  const [cfg, setCfg] = useState<ApprovalConfig>(DEFAULT_APPROVAL)
  const [lines, setLines] = useState<SpecialLine[]>([])
  const [orderId, setOrderId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [savingCfg, setSavingCfg] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const c = await loadApprovalConfig(companyId)
    setCfg(c)
    await escalateOverdueSpecials(companyId, date, c, lang)
    const { data: order } = await supabase.from('kaizen_rr_room_orders').select('id, status')
      .eq('company_id', companyId).eq('order_date', date).maybeSingle()
    const o = order as { id: string; status: string } | null
    setOrderId(o?.id ?? null)
    if (!o || o.status !== 'submitted') { setLines([]); setLoading(false); return }
    const { data } = await supabase.from('kaizen_rr_room_lines')
      .select('id, room_no, slot, item, fulfill_department, serving_at, note, approval_status')
      .eq('room_order_id', o.id).eq('source', 'special').eq('active', true)
    setLines(((data as SpecialLine[]) ?? []).slice().sort((a, b) => roomSort(a.room_no, b.room_no)))
    setLoading(false)
  }, [companyId, date, lang])
  useEffect(() => { load() }, [load])

  async function decide(ids: string[], status: 'approved' | 'rejected') {
    if (ids.length === 0) return
    setBusy(true)
    const { data: updated, error } = await supabase.from('kaizen_rr_room_lines').update({ approval_status: status }).in('id', ids).eq('approval_status', 'pending').select('id')
    setBusy(false)
    if (error) { toast.error(error.message); return }
    if (orderId) await logRoomEvent(companyId, orderId, date, profile?.id, status, `${ids.length} special request${ids.length === 1 ? '' : 's'}`)
    const updatedIds = new Set((updated ?? []).map((r: { id: string }) => r.id))
    setLines((prev) => prev.map((l) => updatedIds.has(l.id) ? { ...l, approval_status: status } : l))
    onChanged()
  }

  async function saveCfg(next: ApprovalConfig) {
    setCfg(next); setSavingCfg(true)
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_special_approval', value: next }, { onConflict: 'company_id,key' })
    setSavingCfg(false)
    if (error) toast.error(error.message)
  }

  const pending = lines.filter((l) => l.approval_status === 'pending')
  const decided = lines.filter((l) => l.approval_status !== 'pending')
  const dateLabel = parseDateOnlyBkk(date).toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB',
    { timeZone: 'Asia/Bangkok', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })

  const statusPill = (s: SpecialLine['approval_status']) => {
    const m: Record<string, [string, string]> = {
      approved: ['bg-green-50 text-green-700 border-green-200', lang === 'th' ? 'อนุมัติ' : 'Approved'],
      rejected: ['bg-red-50 text-red-500 border-red-200', lang === 'th' ? 'ปฏิเสธ' : 'Rejected'],
      auto: ['bg-amber-50 text-amber-700 border-amber-200', lang === 'th' ? 'ปล่อยอัตโนมัติ' : 'Auto-released'],
      pending: ['bg-gray-100 text-gray-500 border-gray-200', lang === 'th' ? 'รออนุมัติ' : 'Pending'],
    }
    const [cls, label] = m[s]
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${cls}`}>{label}</span>
  }

  const card = (l: SpecialLine, actions: boolean) => (
    <div key={l.id} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-semibold text-gray-900">{l.room_no}</span>
          <span className="text-sm text-gray-700">{l.slot || l.item || '—'}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${deptBadge(l.fulfill_department)}`}>{deptLabel(l.fulfill_department as Department, lang)}</span>
          {!actions && statusPill(l.approval_status)}
        </div>
        <p className="text-[11px] text-gray-400 mt-0.5 truncate">
          {l.item && l.slot ? l.item : ''}{l.item && l.slot && (l.serving_at || l.note) ? ' · ' : ''}
          {l.serving_at ? `${lang === 'th' ? 'ภายใน' : 'by'} ${l.serving_at}` : ''}{l.serving_at && l.note ? ' · ' : ''}{l.note ?? ''}
        </p>
      </div>
      {actions && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={() => decide([l.id], 'approved')} disabled={busy}
            className="flex items-center gap-1 h-8 px-2.5 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-medium disabled:opacity-50">
            <Check className="h-3.5 w-3.5" />{lang === 'th' ? 'อนุมัติ' : 'Approve'}
          </button>
          <button onClick={() => decide([l.id], 'rejected')} disabled={busy}
            className="flex items-center gap-1 h-8 px-2.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 text-xs font-medium disabled:opacity-50">
            <X className="h-3.5 w-3.5" />{lang === 'th' ? 'ปฏิเสธ' : 'Reject'}
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Cutoff config */}
      <div className="rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <Clock className="h-3.5 w-3.5 text-gray-400" />
          <h4 className="text-sm font-semibold text-gray-800">{lang === 'th' ? 'การปล่อยอัตโนมัติ' : 'Auto-release cutoff'}</h4>
          {savingCfg && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mb-2">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => saveCfg({ ...cfg, enabled: e.target.checked })} className="accent-[var(--brand-primary)]" />
          {lang === 'th' ? 'ปล่อยคำขอที่ยังไม่อนุมัติไปยังแผนกโดยอัตโนมัติเมื่อถึงกำหนด' : 'Auto-release un-approved requests to departments at the cutoff'}
        </label>
        {cfg.enabled && (
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <select value={cfg.mode} onChange={(e) => saveCfg({ ...cfg, mode: e.target.value as ApprovalConfig['mode'] })}
              className="h-8 rounded-md border border-gray-200 px-2 bg-white focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40">
              <option value="clock">{lang === 'th' ? 'เวลาที่กำหนด' : 'Fixed time'}</option>
              <option value="before_serving">{lang === 'th' ? 'ก่อนเวลาเสิร์ฟ' : 'Before serving'}</option>
            </select>
            {cfg.mode === 'clock' ? (
              <input type="time" value={cfg.clock_time} onChange={(e) => saveCfg({ ...cfg, clock_time: e.target.value })}
                className="h-8 rounded-md border border-gray-200 px-2 bg-white focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40" />
            ) : (
              <span className="flex items-center gap-1">
                <input type="number" min={0} max={24} value={cfg.hours_before} onChange={(e) => saveCfg({ ...cfg, hours_before: Math.max(0, Number(e.target.value) || 0) })}
                  className="h-8 w-16 rounded-md border border-gray-200 px-2 bg-white focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40" />
                <span className="text-gray-500 text-xs">{lang === 'th' ? 'ชม. ก่อนเสิร์ฟ' : 'h before serving'}</span>
              </span>
            )}
            <span className="text-[11px] text-gray-400">{cfg.mode === 'before_serving' ? (lang === 'th' ? '(เหมาะกับงานช่วงบ่าย/เย็น)' : '(handles morning & evening items)') : (lang === 'th' ? '(เวลาเดียวกันทุกห้อง)' : '(same time for all rooms)')}</span>
          </div>
        )}
      </div>

      {/* Date nav */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setDate(shiftDate(date, -1))} className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400"><ChevronLeft className="h-4 w-4" /></button>
        <div className="flex-1 text-center">
          <p className="text-sm font-semibold text-gray-900">{dateLabel}</p>
          <p className="text-[11px] text-gray-400">{date === today ? (lang === 'th' ? 'วันนี้' : 'today') : date === shiftDate(today, 1) ? (lang === 'th' ? 'พรุ่งนี้' : 'tomorrow') : ''}</p>
        </div>
        <button onClick={() => setDate(shiftDate(date, 1))} className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400"><ChevronRight className="h-4 w-4" /></button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : (
        <>
          {/* Pending */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <ShieldCheck className="h-4 w-4 text-[var(--brand-primary)]" />
              <h3 className="text-base font-semibold text-[var(--brand-primary)]">{lang === 'th' ? 'รออนุมัติ' : 'Needs approval'}</h3>
              <span className="text-sm text-gray-400">{pending.length}</span>
              {pending.length > 0 && (
                <button onClick={() => decide(pending.map((l) => l.id), 'approved')} disabled={busy}
                  className="ml-auto flex items-center gap-1 h-8 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-medium disabled:opacity-50">
                  <Check className="h-3.5 w-3.5" />{lang === 'th' ? 'อนุมัติทั้งหมด' : 'Approve all'}
                </button>
              )}
            </div>
            {pending.length === 0 ? (
              <div className="text-center py-8 rounded-xl border border-dashed border-gray-200 text-sm text-gray-400">
                {lang === 'th' ? 'ไม่มีคำขอที่รออนุมัติ' : 'No special requests awaiting approval.'}
              </div>
            ) : (
              <div className="space-y-1.5">{pending.map((l) => card(l, true))}</div>
            )}
          </div>

          {/* Decided */}
          {decided.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 mb-2">{lang === 'th' ? 'ตัดสินแล้ว' : 'Decided'} <span className="font-normal opacity-60">{decided.length}</span></h3>
              <div className="space-y-1.5">{decided.map((l) => card(l, false))}</div>
              {decided.some((l) => l.approval_status === 'auto') && (
                <p className="flex items-center gap-1 text-[11px] text-amber-600 mt-2"><AlertTriangle className="h-3 w-3" />{lang === 'th' ? 'รายการ “ปล่อยอัตโนมัติ” ไม่ได้รับการอนุมัติก่อนกำหนด' : 'Auto-released items were not approved before the cutoff.'}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Load the company's RR item catalog once. */
function useItems(companyId: string): RrItem[] {
  const [items, setItems] = useState<RrItem[]>([])
  useEffect(() => {
    if (!companyId) return
    let stale = false
    supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_items').maybeSingle()
      .then(({ data }) => { if (!stale) setItems(Array.isArray(data?.value) ? (data!.value as RrItem[]) : []) })
    return () => { stale = true }
  }, [companyId])
  return items
}
