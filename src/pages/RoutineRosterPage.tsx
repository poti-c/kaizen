import { useState, useEffect, useCallback } from 'react'
import {
  ClipboardList, ChevronLeft, ChevronRight, Loader2, X, Check, Trash2, Pencil,
  Plus, Send, PackageCheck, CircleCheck, ArrowRight, Clock, BedDouble, Ban, ChevronDown,
} from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import {
  DEPARTMENT_LABELS,
  type Department, type RrTemplate, type RrOrder, type RrOrderItem, type RrOrderStatus, type RrOrderType,
} from '@/types'

// ── helpers ──────────────────────────────────────────────────────────────────

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const EDIT_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

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

  const [view, setView] = useState<'board' | 'templates' | 'report'>('board')
  const [date, setDate] = useState(() => dateKey(new Date()))
  const [templates, setTemplates] = useState<RrTemplate[]>([])
  const [orders, setOrders] = useState<RrOrder[]>([])
  const [loading, setLoading] = useState(true)
  const today = dateKey(new Date())
  const readOnly = date !== today

  const statusLabel = (s: RrOrderStatus) =>
    ({ pending: tr.rr.pending, sent: tr.rr.sentStatus, accepted: tr.rr.acceptedStatus,
       delivered: tr.rr.deliveredStatus, confirmed: tr.rr.confirmedStatus, cancelled: tr.rr.cancelledStatus }[s])

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

    // Materialize today's orders from active templates that have none yet.
    // Upsert + ignoreDuplicates makes this race-safe across devices.
    if (date === dateKey(new Date())) {
      const have = new Set(((res.data as RrOrder[]) ?? []).map((o) => o.template_id))
      const missing = tplList.filter((tp) => tp.active && !have.has(tp.id))
      if (missing.length > 0) {
        const rows = missing.map((tp) => ({
          company_id: companyId, template_id: tp.id, order_date: date,
          title: tp.name, request_department: tp.request_department, fulfill_department: tp.fulfill_department,
          order_type: tp.order_type, item_label: itemFor(tp, date), status: 'pending',
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
  }, [companyId, date])
  useEffect(() => { load() }, [load])

  // Insert an in-app notification (the DB trigger sends the push) for every
  // active member of a department in this company — except the actor.
  const notifyDept = useCallback(async (dept: Department, title: string, message: string) => {
    if (!companyId || !profile) return
    const { data } = await supabase.from('kaizen_profiles').select('id')
      .eq('company_id', companyId).eq('department', dept).eq('is_active', true)
    const targets = ((data as { id: string }[]) ?? []).filter((p) => p.id !== profile.id)
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

  // Whose turn is it? pending/delivered → requesting side; sent/accepted → fulfilling side.
  const needsMyAction = useCallback((o: RrOrder) => {
    if (!profile || readOnly) return false
    const onRequest = canManage || profile.department === o.request_department
    const onFulfill = canManage || profile.department === o.fulfill_department
    if (o.status === 'pending' || o.status === 'delivered') return onRequest
    if (o.status === 'sent' || o.status === 'accepted') return onFulfill
    return false
  }, [profile, canManage, readOnly])

  const mine = orders.filter(needsMyAction)
  const rest = orders.filter((o) => !needsMyAction(o))

  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString(
    lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-[var(--brand-primary)]" />
          <h1 className="text-lg font-bold text-gray-900">{tr.rr.title}</h1>
        </div>
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs font-medium">
          {([...(['board'] as const), ...(canManage ? (['templates'] as const) : []), ...(['report'] as const)]).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 h-8 transition-colors ${view === v ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {v === 'board' ? tr.rr.boardTab : v === 'templates' ? tr.rr.templatesTab : tr.rr.reportTab}
            </button>
          ))}
        </div>
      </div>

      {view === 'templates' && canManage && companyId ? (
        <TemplatesView companyId={companyId} templates={templates} onChanged={load} />
      ) : view === 'report' && companyId ? (
        <ReportView companyId={companyId} companyName={activeCompany?.org_title || activeCompany?.name || ''}
          generatedBy={profile?.full_name ?? ''} statusLabel={statusLabel} />
      ) : (
        <>
          {/* Date picker row: ◀ Today ▶ */}
          <div className="flex items-center justify-between gap-2 mb-4">
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
              ) : (
                <p className="text-[11px] text-gray-400">{tr.rr.todayBtn}</p>
              )}
            </div>
            <button onClick={() => setDate(shiftDate(date, 1))}
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-gray-400">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

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
                      <OrderCard key={o.id} order={o} title={displayTitle(o)} statusLabel={statusLabel}
                        readOnly={readOnly} canManage={canManage} notifyDept={notifyDept} onChanged={load} />
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
                      <OrderCard key={o.id} order={o} title={displayTitle(o)} statusLabel={statusLabel}
                        readOnly={readOnly} canManage={canManage} notifyDept={notifyDept} onChanged={load} />
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

function OrderCard({ order: o, title, statusLabel, readOnly, canManage, notifyDept, onChanged }: {
  order: RrOrder
  title: string
  statusLabel: (s: RrOrderStatus) => string
  readOnly: boolean
  canManage: boolean
  notifyDept: (dept: Department, title: string, message: string) => Promise<void>
  onChanged: () => void
}) {
  const { t: tr } = useLanguage()
  const { profile } = useAuth()
  const [busy, setBusy] = useState(false)
  const [qty, setQty] = useState(o.quantity != null ? String(o.quantity) : '')
  const [roomsText, setRoomsText] = useState('')
  const [note, setNote] = useState(o.note ?? '')
  const [expanded, setExpanded] = useState(false)

  const onRequest = canManage || profile?.department === o.request_department
  const onFulfill = canManage || profile?.department === o.fulfill_department
  const items = (o.items ?? []).slice().sort((a, b) => a.room_no.localeCompare(b.room_no, undefined, { numeric: true }))
  const deliveredCount = items.filter((i) => i.delivered).length
  const deptArrow = `${DEPARTMENT_LABELS[o.request_department] ?? o.request_department} → ${DEPARTMENT_LABELS[o.fulfill_department] ?? o.fulfill_department}`
  const dueLabel = o.due_at ? fmtTime(o.due_at) : ''
  // The per-room checklist is shown while delivering, and as a read-only recap after.
  const showChecklist = o.order_type === 'per_room' && items.length > 0 &&
    (o.status === 'accepted' || o.status === 'delivered' || o.status === 'confirmed') &&
    (expanded || (o.status === 'accepted' && onFulfill && !readOnly))
  const canTickRooms = !readOnly && onFulfill && o.status === 'accepted'

  async function update(patch: Partial<RrOrder>, okMsg: string, notify?: { dept: Department; title: string; message: string }) {
    if (!profile) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_rr_orders').update(patch).eq('id', o.id)
    setBusy(false)
    if (error) { toast.error(error.message); return }
    if (notify) await notifyDept(notify.dept, notify.title, notify.message)
    toast.success(okMsg)
    onChanged()
  }

  const now = () => new Date().toISOString()
  const itemSuffix = o.item_label ? ` — ${o.item_label}` : ''

  async function sendOrder() {
    if (!profile) return
    if (o.order_type === 'bulk') {
      const n = Number(qty)
      if (!qty.trim() || !Number.isFinite(n) || n <= 0) { toast.error(tr.rr.quantityRequired); return }
      await update(
        { status: 'sent', quantity: n, note: note.trim() || null, sent_by: profile.id, sent_at: now() },
        tr.rr.orderSent,
        { dept: o.fulfill_department, title: 'Routine order received', message: `"${o.title}"${itemSuffix} — ${n} requested by ${DEPARTMENT_LABELS[o.request_department]}` },
      )
    } else {
      // Parse "one per line or comma-separated", optional "104: mango" item override.
      const rooms = roomsText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((tok) => {
        const m = tok.match(/^([^:]+?)\s*:\s*(.+)$/)
        return m ? { room_no: m[1].trim(), item_label: m[2].trim() } : { room_no: tok, item_label: null as string | null }
      })
      if (rooms.length === 0) { toast.error(tr.rr.roomsRequired); return }
      setBusy(true)
      const ins = await supabase.from('kaizen_rr_order_items').insert(
        rooms.map((r) => ({ order_id: o.id, company_id: o.company_id, room_no: r.room_no, item_label: r.item_label }))
      )
      setBusy(false)
      if (ins.error) { toast.error(ins.error.message); return }
      await update(
        { status: 'sent', quantity: rooms.length, note: note.trim() || null, sent_by: profile.id, sent_at: now() },
        tr.rr.orderSent,
        { dept: o.fulfill_department, title: 'Routine order received', message: `"${o.title}"${itemSuffix} — ${rooms.length} rooms, requested by ${DEPARTMENT_LABELS[o.request_department]}` },
      )
    }
  }

  async function acceptOrder() {
    if (!profile) return
    await update(
      { status: 'accepted', accepted_by: profile.id, accepted_at: now() },
      tr.rr.orderAccepted,
      { dept: o.request_department, title: 'Routine order accepted', message: `"${o.title}"${itemSuffix} was accepted by ${DEPARTMENT_LABELS[o.fulfill_department]}` },
    )
  }

  async function markDelivered() {
    if (!profile) return
    await update(
      { status: 'delivered', delivered_by: profile.id, delivered_at: now() },
      tr.rr.orderDelivered,
      { dept: o.request_department, title: 'Routine order delivered', message: `"${o.title}"${itemSuffix} was delivered by ${DEPARTMENT_LABELS[o.fulfill_department]}` },
    )
  }

  async function confirmReceived() {
    if (!profile) return
    await update(
      { status: 'confirmed', confirmed_by: profile.id, confirmed_at: now() },
      tr.rr.orderConfirmed,
      { dept: o.fulfill_department, title: 'Routine order confirmed', message: `"${o.title}"${itemSuffix} receipt was confirmed by ${DEPARTMENT_LABELS[o.request_department]}` },
    )
  }

  async function cancelOrder() {
    if (!confirm(tr.rr.confirmCancelOrder)) return
    await update({ status: 'cancelled' }, tr.rr.orderCancelled)
  }

  async function toggleRoom(it: RrOrderItem) {
    if (!profile || !canTickRooms || busy) return
    const delivered = !it.delivered
    setBusy(true)
    const { error } = await supabase.from('kaizen_rr_order_items').update({
      delivered, delivered_by: delivered ? profile.id : null, delivered_at: delivered ? now() : null,
    }).eq('id', it.id)
    if (error) { setBusy(false); toast.error(error.message); return }
    // Last room ticked → the whole order is delivered.
    const allDone = delivered && items.every((x) => (x.id === it.id ? delivered : x.delivered))
    if (allDone) {
      const { error: e2 } = await supabase.from('kaizen_rr_orders').update({
        status: 'delivered', delivered_by: profile.id, delivered_at: now(),
      }).eq('id', o.id)
      if (e2) toast.error(e2.message)
      else {
        await notifyDept(o.request_department, 'Routine order delivered',
          `"${o.title}"${itemSuffix} — all ${items.length} rooms done by ${DEPARTMENT_LABELS[o.fulfill_department]}`)
        toast.success(tr.rr.orderDelivered)
      }
    }
    setBusy(false)
    onChanged()
  }

  // Timestamps line — only what happened.
  const stamps = [
    o.sent_at && `${tr.rr.sentAt} ${fmtTime(o.sent_at)}`,
    o.accepted_at && `${tr.rr.acceptedAt} ${fmtTime(o.accepted_at)}`,
    o.delivered_at && `${tr.rr.deliveredAt} ${fmtTime(o.delivered_at)}`,
    o.confirmed_at && `${tr.rr.confirmedAt} ${fmtTime(o.confirmed_at)}`,
  ].filter(Boolean).join(' · ')

  const actionBtnCls = 'flex items-center justify-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50'

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
          </div>
          <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-1 flex-wrap">
            <span>{deptArrow}</span>
            {dueLabel && <span className="flex items-center gap-0.5">· <Clock className="h-3 w-3" /> {tr.rr.due} {dueLabel}</span>}
            {o.quantity != null && o.order_type === 'bulk' && <span>· {tr.rr.qty} {o.quantity}</span>}
            {o.order_type === 'per_room' && items.length > 0 && (
              <span className="flex items-center gap-0.5">· <BedDouble className="h-3 w-3" /> {tr.rr.roomsDone(deliveredCount, items.length)}</span>
            )}
          </p>
          {o.note && <p className="text-[11px] text-gray-400 mt-0.5">{o.note}</p>}
          {stamps && <p className="text-[11px] text-gray-400 mt-1">{stamps}</p>}
        </div>
        {/* expand toggle for finished per-room checklists */}
        {o.order_type === 'per_room' && items.length > 0 && (o.status === 'delivered' || o.status === 'confirmed') && (
          <button onClick={() => setExpanded((v) => !v)} title={tr.rr.roomChecklist}
            className="p-1.5 -m-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex-shrink-0">
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {/* pending → requester fills quantity / rooms and sends */}
      {!readOnly && o.status === 'pending' && onRequest && (
        <div className="mt-3 pl-5 space-y-2">
          {o.order_type === 'bulk' ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500">{tr.rr.quantity}</label>
              <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric" placeholder={tr.rr.quantityPh} className={inputCls + ' max-w-[160px]'} />
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-500">{tr.rr.rooms}</label>
              <textarea value={roomsText} onChange={(e) => setRoomsText(e.target.value)} rows={4}
                placeholder={tr.rr.roomsPh} className={inputCls + ' h-auto py-2 resize-none'} />
              <p className="text-[11px] text-gray-400">{tr.rr.roomsHint}</p>
            </div>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr.rr.notePh} className={inputCls} />
          <button onClick={sendOrder} disabled={busy} className={actionBtnCls}>
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
            {items.map((it) => (
              <button key={it.id} onClick={() => toggleRoom(it)} disabled={!canTickRooms || busy}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  it.delivered ? 'border-teal-200 bg-teal-50' : 'border-gray-200 bg-white'
                } ${canTickRooms ? 'hover:border-gray-300 cursor-pointer' : 'cursor-default'}`}>
                <span className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                  it.delivered ? 'bg-teal-500 border-teal-500' : 'border-gray-300'}`}>
                  {it.delivered && <Check className="h-3 w-3 text-white" />}
                </span>
                <span className="text-sm font-medium text-gray-800">{it.room_no}</span>
                {it.item_label && <span className="text-[11px] text-gray-500 truncate">{it.item_label}</span>}
                {it.delivered_at && <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0">{fmtTime(it.delivered_at)}</span>}
              </button>
            ))}
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
    </div>
  )
}

// ── templates view (managers) ────────────────────────────────────────────────

function TemplatesView({ companyId, templates, onChanged }: {
  companyId: string; templates: RrTemplate[]; onChanged: () => void
}) {
  const { t: tr, lang } = useLanguage()
  const [editor, setEditor] = useState<RrTemplate | 'new' | null>(null)

  async function toggleActive(tpl: RrTemplate) {
    const { error } = await supabase.from('kaizen_rr_templates').update({ active: !tpl.active }).eq('id', tpl.id)
    if (error) toast.error(error.message); else onChanged()
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
                    {tpl.order_type === 'per_room' ? tr.rr.perRoomShort : tr.rr.bulkShort}
                  </span>
                  {!tpl.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-400">{tr.rr.inactiveBadge}</span>}
                </div>
                <p className="text-[11px] text-gray-500 truncate mt-0.5 flex items-center gap-1">
                  {DEPARTMENT_LABELS[tpl.request_department] ?? tpl.request_department}
                  <ArrowRight className="h-3 w-3" />
                  {DEPARTMENT_LABELS[tpl.fulfill_department] ?? tpl.fulfill_department}
                  <span>· {tr.rr.due} {(tpl.due_time || '').slice(0, 5)}</span>
                  {tpl.default_item && <span>· {tpl.default_item}</span>}
                </p>
              </div>
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
  companyId: string; template: RrTemplate | null; sortNext: number; onClose: () => void; onSaved: () => void
}) {
  const { t: tr } = useLanguage()
  const [busy, setBusy] = useState(false)
  const [showWeekdays, setShowWeekdays] = useState(
    !!template?.item_by_weekday && Object.keys(template.item_by_weekday).length > 0)
  const [f, setF] = useState({
    name: template?.name ?? '', name_th: template?.name_th ?? '',
    request_department: template?.request_department ?? ('front_office' as Department),
    fulfill_department: template?.fulfill_department ?? ('restaurant' as Department),
    order_type: (template?.order_type ?? 'bulk') as RrOrderType,
    due_time: (template?.due_time ?? '12:00').slice(0, 5),
    default_item: template?.default_item ?? '',
    weekdays: Object.fromEntries(EDIT_WEEKDAYS.map((d) => [d, template?.item_by_weekday?.[d] ?? ''])) as Record<string, string>,
    active: template?.active ?? true,
  })
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }))
  const weekdayLabel: Record<string, string> = {
    mon: tr.rr.mon, tue: tr.rr.tue, wed: tr.rr.wed, thu: tr.rr.thu, fri: tr.rr.fri, sat: tr.rr.sat, sun: tr.rr.sun,
  }

  async function save() {
    if (!f.name.trim()) { toast.error(tr.rr.nameRequired); return }
    if (f.request_department === f.fulfill_department) { toast.error(tr.rr.sameDeptError); return }
    setBusy(true)
    const byWeekday = Object.fromEntries(
      Object.entries(f.weekdays).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
    const row = {
      company_id: companyId, name: f.name.trim(), name_th: f.name_th.trim() || null,
      request_department: f.request_department, fulfill_department: f.fulfill_department,
      order_type: f.order_type, due_time: f.due_time || '12:00',
      default_item: f.default_item.trim() || null,
      item_by_weekday: showWeekdays && Object.keys(byWeekday).length > 0 ? byWeekday : null,
      active: f.active, sort_order: template?.sort_order ?? sortNext,
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
                {(Object.keys(DEPARTMENT_LABELS) as Department[]).map((d) => <option key={d} value={d}>{DEPARTMENT_LABELS[d]}</option>)}
              </select>
            </Field>
            <Field label={tr.rr.fulfillDept}>
              <select value={f.fulfill_department} onChange={(e) => set({ fulfill_department: e.target.value as Department })} className={inputCls}>
                {(Object.keys(DEPARTMENT_LABELS) as Department[]).map((d) => <option key={d} value={d}>{DEPARTMENT_LABELS[d]}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.rr.orderType}>
              <select value={f.order_type} onChange={(e) => set({ order_type: e.target.value as RrOrderType })} className={inputCls}>
                <option value="bulk">{tr.rr.bulk}</option>
                <option value="per_room">{tr.rr.perRoom}</option>
              </select>
            </Field>
            <Field label={tr.rr.dueTime}>
              <input type="time" value={f.due_time} onChange={(e) => set({ due_time: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label={tr.rr.defaultItem}>
            <input value={f.default_item} onChange={(e) => set({ default_item: e.target.value })} className={inputCls} placeholder={tr.rr.defaultItemPh} />
          </Field>
          <div>
            <button onClick={() => setShowWeekdays((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-[var(--brand-primary)]">
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showWeekdays ? 'rotate-180' : ''}`} />
              {tr.rr.itemByWeekday}
            </button>
            {showWeekdays && (
              <div className="mt-2 space-y-1.5">
                {EDIT_WEEKDAYS.map((d) => (
                  <div key={d} className="flex items-center gap-2">
                    <span className="w-10 text-xs text-gray-500 flex-shrink-0">{weekdayLabel[d]}</span>
                    <input value={f.weekdays[d]} onChange={(e) => set({ weekdays: { ...f.weekdays, [d]: e.target.value } })}
                      className={inputCls + ' h-8'} placeholder={f.default_item || tr.rr.defaultItemPh} />
                  </div>
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

// ── Generate Report — period summary of requested items, for Accounting ──────

function startOfWeek(key: string): string {
  const d = new Date(key + 'T00:00:00')
  const dow = d.getDay() === 0 ? 6 : d.getDay() - 1 // Monday-first
  d.setDate(d.getDate() - dow)
  return dateKey(d)
}

function ReportView({ companyId, companyName, generatedBy, statusLabel }: {
  companyId: string
  companyName: string
  generatedBy: string
  statusLabel: (s: RrOrderStatus) => string
}) {
  const { t: tr, lang } = useLanguage()
  const [mode, setMode] = useState<'daily' | 'weekly'>('daily')
  const [anchor, setAnchor] = useState(() => dateKey(new Date()))
  const [rows, setRows] = useState<RrOrder[]>([])
  const [loading, setLoading] = useState(true)

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

  // Quantity of an order: bulk = quantity; per-room = number of rooms.
  const qtyOf = (o: RrOrder) => o.order_type === 'bulk' ? (o.quantity ?? 0) : (o.items?.length ?? 0)

  // Totals per item label (falls back to the routine title).
  const summary = rows.reduce<Record<string, number>>((acc, o) => {
    const k = o.item_label || o.title
    acc[k] = (acc[k] ?? 0) + qtyOf(o)
    return acc
  }, {})

  const fmtDay = (key: string) => new Date(key + 'T00:00:00').toLocaleDateString(
    lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  const periodLabel = mode === 'daily' ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`

  function printReport() {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const rowsHtml = rows.map((o) => `
      <tr>
        <td>${esc(fmtDay(o.order_date))}</td>
        <td>${esc(o.title)}</td>
        <td>${esc(o.item_label ?? '—')}</td>
        <td style="text-align:right">${qtyOf(o)}</td>
        <td>${esc(DEPARTMENT_LABELS[o.request_department] ?? o.request_department)}</td>
        <td>${esc(DEPARTMENT_LABELS[o.fulfill_department] ?? o.fulfill_department)}</td>
        <td>${esc(statusLabel(o.status))}</td>
      </tr>`).join('')
    const summaryHtml = Object.entries(summary).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td style="text-align:right">${v}</td></tr>`).join('')
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
      <table><thead><tr>
        <th>${esc(tr.rr.reportDate)}</th><th>${esc(tr.rr.reportRoutine)}</th><th>${esc(tr.rr.reportItem)}</th>
        <th style="text-align:right">${esc(tr.rr.reportQty)}</th><th>${esc(tr.rr.reportFrom)}</th>
        <th>${esc(tr.rr.reportTo)}</th><th>${esc(tr.rr.reportStatus)}</th>
      </tr></thead><tbody>${rowsHtml}</tbody></table>
      <h2>${esc(tr.rr.reportSummary)}</h2>
      <table style="max-width:380px"><thead><tr><th>${esc(tr.rr.reportItem)}</th><th style="text-align:right">${esc(tr.rr.reportTotal)}</th></tr></thead>
      <tbody>${summaryHtml}</tbody></table>
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
        <button onClick={printReport} disabled={loading || rows.length === 0}
          className="h-8 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-semibold disabled:opacity-40">
          {tr.rr.reportPrint}
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200 text-sm text-gray-400">{tr.rr.reportNoData}</div>
      ) : (
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
                    <td className="px-3 py-2 text-right text-gray-900 font-medium">{qtyOf(o)}</td>
                    <td className="px-3 py-2 text-gray-600">{DEPARTMENT_LABELS[o.request_department] ?? o.request_department}</td>
                    <td className="px-3 py-2 text-gray-600">{DEPARTMENT_LABELS[o.fulfill_department] ?? o.fulfill_department}</td>
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
    </div>
  )
}
