import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardList, ChevronRight, CircleCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface OrderRow { status: string; due_at: string | null; order_date: string; request_department: string | null; fulfill_department: string | null }
interface RoomOrderRow { order_date: string; room_statuses: Record<string, string> | null }
interface RoomLineRow { order_date: string; status: string; serving_at: string | null; active: boolean; fulfill_department: string | null }

// Dashboard summary for the Routine Roster — mirrors PMSummaryCard, split into two
// labelled halves: Today board (bulk routine orders) and Room order (per-room setup).
export function RRSummaryCard() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const companyId = activeCompany?.id ?? null
  const isStaff = profile?.role === 'staff'

  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [roomOrders, setRoomOrders] = useState<RoomOrderRow[]>([])
  const [roomLines, setRoomLines] = useState<RoomLineRow[]>([])

  const today = isoDate(new Date())
  const tomorrow = isoDate(new Date(Date.now() + 86400000))

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const [o, ro, rl] = await Promise.all([
        supabase.from('kaizen_rr_orders')
          .select('status, due_at, order_date, request_department, fulfill_department')
          .eq('company_id', companyId).in('order_date', [today, tomorrow]).neq('status', 'cancelled'),
        supabase.from('kaizen_rr_room_orders')
          .select('order_date, room_statuses')
          .eq('company_id', companyId).in('order_date', [today, tomorrow]),
        supabase.from('kaizen_rr_room_lines')
          .select('order_date, status, serving_at, active, fulfill_department')
          .eq('company_id', companyId).in('order_date', [today, tomorrow]).eq('active', true),
      ])
      if (cancelled) return
      let oList = (o.data as OrderRow[]) ?? []
      let lList = (rl.data as RoomLineRow[]) ?? []
      if (isStaff && profile?.department) {
        oList = oList.filter(x => x.request_department === profile.department || x.fulfill_department === profile.department)
        lList = lList.filter(x => x.fulfill_department === profile.department)
      }
      setOrders(oList)
      setRoomOrders((ro.data as RoomOrderRow[]) ?? [])
      setRoomLines(lList)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [companyId, isStaff, profile?.department, today, tomorrow])

  if (loading) {
    return <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 mb-4 h-28 animate-pulse" />
  }

  const now = Date.now()

  // ── Today board (bulk routine orders) ──
  const todays = orders.filter(o => o.order_date === today)
  const isOpen = (s: string) => s === 'pending' || s === 'sent' || s === 'accepted'
  const tbTotal = todays.length
  const tbLate = todays.filter(o => isOpen(o.status) && o.due_at != null && new Date(o.due_at).getTime() < now).length
  const tbToAccept = todays.filter(o => o.status === 'pending' || o.status === 'sent').length
  const tbInProgress = todays.filter(o => o.status === 'accepted').length
  const tbDelivered = todays.filter(o => o.status === 'delivered').length
  const tbConfirmed = todays.filter(o => o.status === 'confirmed').length
  const tbTomorrow = orders.filter(o => o.order_date === tomorrow).length
  const fulfillment = tbTotal === 0 ? null : Math.round(((tbTotal - tbLate) / tbTotal) * 100)
  const hasToday = tbTotal > 0 || tbTomorrow > 0

  // ── Room order (per-room setup) ──
  const lineLate = (l: RoomLineRow) => {
    const ts = new Date(`${l.order_date}T${(l.serving_at || '').slice(0, 5)}`).getTime()
    return !isNaN(ts) && now > ts
  }
  const todayLines = roomLines.filter(l => l.order_date === today)
  const roTotal = todayLines.length
  const roDone = todayLines.filter(l => l.status === 'done').length
  const roToPrepare = todayLines.filter(l => l.status !== 'done').length
  const roLate = todayLines.filter(l => l.status !== 'done' && lineLate(l)).length
  const roTomorrow = roomLines.filter(l => l.order_date === tomorrow).length
  const prep = roTotal === 0 ? null : Math.round((roDone / roTotal) * 100)
  // Room composition from today's room order(s).
  const roomCounts = { checkin: 0, occupied: 0, empty: 0, oo: 0 }
  roomOrders.filter(r => r.order_date === today).forEach(r =>
    Object.values(r.room_statuses ?? {}).forEach(s => { if (s in roomCounts) roomCounts[s as keyof typeof roomCounts]++ }))
  const ci = roomCounts.checkin, occ = roomCounts.occupied, emptyOO = roomCounts.empty + roomCounts.oo
  const hasRoom = roTotal > 0 || roTomorrow > 0 || (ci + occ + emptyOO) > 0

  const pct = (v: number | null, color: (n: number) => string) => v == null ? 'text-gray-400' : color(v)
  const gradeColor = (n: number) => n >= 90 ? 'text-green-600' : n >= 70 ? 'text-amber-600' : 'text-red-600'

  const L = {
    title: t.rr.title,
    open: lang === 'th' ? 'เปิด' : 'Open',
    todayBoard: lang === 'th' ? 'บอร์ดวันนี้' : 'Today board',
    roomOrder: lang === 'th' ? 'ใบสั่งห้อง' : 'Room order',
    fulfillment: lang === 'th' ? 'จัดส่งตามเวลา' : 'Fulfillment',
    prep: lang === 'th' ? 'เตรียมเสร็จ' : 'Prep complete',
    toAccept: lang === 'th' ? 'รอรับงาน' : 'To accept',
    inProgress: lang === 'th' ? 'กำลังทำ' : 'In progress',
    late: lang === 'th' ? 'เลยเวลา' : 'Late',
    delivered: lang === 'th' ? 'จัดส่งแล้ว' : 'Delivered',
    confirmed: lang === 'th' ? 'ยืนยันแล้ว' : 'Confirmed',
    forTomorrow: lang === 'th' ? 'พรุ่งนี้' : 'For tomorrow',
    toPrepare: lang === 'th' ? 'รอเตรียม' : 'To prepare',
    none: lang === 'th' ? 'ไม่มีกิจกรรมประจำสำหรับวันนี้หรือพรุ่งนี้' : 'No routine activity today or tomorrow.',
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5"><ClipboardList className="h-3.5 w-3.5 text-[var(--brand-primary)]" />{L.title}</h2>
        <Link to="/routine-roster" className="flex items-center gap-0.5 text-xs font-medium text-[var(--brand-primary)] hover:opacity-75">{L.open}<ChevronRight className="h-3.5 w-3.5" /></Link>
      </div>

      {!hasToday && !hasRoom ? (
        <p className="text-center text-xs text-gray-500 py-3">{L.none}</p>
      ) : (
        <div className="space-y-3">
          {hasToday && (
            <Section
              label={L.todayBoard}
              heroValue={fulfillment == null ? '—' : `${fulfillment}%`}
              heroLabel={L.fulfillment}
              heroColor={pct(fulfillment, gradeColor)}
              tiles={[
                { label: L.toAccept, value: tbToAccept, tone: 'amber' },
                { label: L.inProgress, value: tbInProgress, tone: 'blue' },
                { label: L.late, value: tbLate, tone: tbLate > 0 ? 'red' : 'slate' },
                { label: L.delivered, value: tbDelivered, tone: 'teal' },
                { label: L.confirmed, value: tbConfirmed, tone: 'green' },
                { label: L.forTomorrow, value: tbTomorrow, tone: 'slate' },
              ]}
            />
          )}
          {hasToday && hasRoom && <div className="h-px bg-gray-100" />}
          {hasRoom && (
            <Section
              label={L.roomOrder}
              heroValue={prep == null ? '—' : `${prep}%`}
              heroLabel={L.prep}
              heroColor={pct(prep, gradeColor)}
              tiles={[
                { label: L.toPrepare, value: roToPrepare, tone: 'amber' },
                { label: L.late, value: roLate, tone: roLate > 0 ? 'red' : 'slate' },
                { label: L.forTomorrow, value: roTomorrow, tone: 'slate' },
                { label: 'C/I', value: ci, tone: 'blue' },
                { label: 'OCC', value: occ, tone: 'teal' },
                { label: 'EMPTY/OO', value: emptyOO, tone: 'slate' },
              ]}
            />
          )}
        </div>
      )}
    </div>
  )
}

const TONES: Record<string, string> = {
  amber: 'bg-amber-50 text-amber-700',
  blue: 'bg-blue-50 text-blue-700',
  red: 'bg-red-50 text-red-700',
  teal: 'bg-teal-50 text-teal-700',
  green: 'bg-green-50 text-green-700',
  slate: 'bg-gray-50 text-gray-700',
}

function Section({ label, heroValue, heroLabel, heroColor, tiles }: {
  label: string; heroValue: string; heroLabel: string; heroColor: string
  tiles: { label: string; value: number; tone: string }[]
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">{label}</p>
      <div className="flex items-stretch gap-2">
        <Link to="/routine-roster" className="flex flex-col items-center justify-center rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors px-3 py-1.5 w-24 flex-shrink-0">
          <p className={`text-2xl font-bold leading-none ${heroColor}`}>{heroValue}</p>
          <p className="text-[10px] text-gray-500 mt-0.5 text-center leading-tight flex items-center gap-0.5"><CircleCheck className={`h-3 w-3 ${heroColor}`} />{heroLabel}</p>
        </Link>
        <div className="flex-1 grid grid-cols-3 auto-rows-fr gap-1.5">
          {tiles.map((tile, i) => (
            <Link key={i} to="/routine-roster" className={`flex flex-col justify-center h-full rounded-md px-2 py-1 hover:brightness-95 transition-all ${TONES[tile.tone]}`}>
              <p className="text-base font-bold leading-none">{tile.value}</p>
              <p className="text-[10px] mt-0.5 opacity-80 leading-tight">{tile.label}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
