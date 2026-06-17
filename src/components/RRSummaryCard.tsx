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

// Dashboard summary for the Routine Roster — mirrors PMSummaryCard. Hero is the
// Today-board on-time Fulfillment %; below the order tiles sits the room
// composition (C/I · OCC · Empty · O/O) from today's room order.
export function RRSummaryCard() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const companyId = activeCompany?.id ?? null
  const isStaff = profile?.role === 'staff'

  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [roomOrders, setRoomOrders] = useState<RoomOrderRow[]>([])

  const today = isoDate(new Date())
  const tomorrow = isoDate(new Date(Date.now() + 86400000))

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const [o, ro] = await Promise.all([
        supabase.from('kaizen_rr_orders')
          .select('status, due_at, order_date, request_department, fulfill_department')
          .eq('company_id', companyId).in('order_date', [today, tomorrow]).neq('status', 'cancelled'),
        supabase.from('kaizen_rr_room_orders')
          .select('order_date, room_statuses')
          .eq('company_id', companyId).eq('order_date', today),
      ])
      if (cancelled) return
      let oList = (o.data as OrderRow[]) ?? []
      if (isStaff && profile?.department) {
        oList = oList.filter(x => x.request_department === profile.department || x.fulfill_department === profile.department)
      }
      setOrders(oList)
      setRoomOrders((ro.data as RoomOrderRow[]) ?? [])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [companyId, isStaff, profile?.department, today, tomorrow])

  if (loading) {
    return <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 mb-4 h-24 animate-pulse" />
  }

  const now = Date.now()
  const todays = orders.filter(o => o.order_date === today)
  const isOpen = (s: string) => s === 'pending' || s === 'sent' || s === 'accepted'
  const total = todays.length
  const late = todays.filter(o => isOpen(o.status) && o.due_at != null && new Date(o.due_at).getTime() < now).length
  const toAccept = todays.filter(o => o.status === 'pending' || o.status === 'sent').length
  const inProgress = todays.filter(o => o.status === 'accepted').length
  const delivered = todays.filter(o => o.status === 'delivered').length
  const confirmed = todays.filter(o => o.status === 'confirmed').length
  const forTomorrow = orders.filter(o => o.order_date === tomorrow).length
  const fulfillment = total === 0 ? null : Math.round(((total - late) / total) * 100)
  const fulfillColor = fulfillment == null ? 'text-gray-400'
    : fulfillment >= 90 ? 'text-green-600' : fulfillment >= 70 ? 'text-amber-600' : 'text-red-600'
  const hasToday = total > 0 || forTomorrow > 0

  // Room composition from today's room order(s).
  const rc = { checkin: 0, occupied: 0, empty: 0, oo: 0 }
  roomOrders.forEach(r => Object.values(r.room_statuses ?? {}).forEach(s => { if (s in rc) rc[s as keyof typeof rc]++ }))
  const hasRoom = (rc.checkin + rc.occupied + rc.empty + rc.oo) > 0

  const L = {
    title: t.rr.title,
    open: lang === 'th' ? 'เปิด' : 'Open',
    fulfillment: lang === 'th' ? 'จัดส่งตามเวลา' : 'Fulfillment',
    toAccept: lang === 'th' ? 'รอรับงาน' : 'To accept',
    inProgress: lang === 'th' ? 'กำลังทำ' : 'In progress',
    late: lang === 'th' ? 'เลยเวลา' : 'Late',
    delivered: lang === 'th' ? 'จัดส่งแล้ว' : 'Delivered',
    confirmed: lang === 'th' ? 'ยืนยันแล้ว' : 'Confirmed',
    forTomorrow: lang === 'th' ? 'พรุ่งนี้' : 'For tomorrow',
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
        <div className="space-y-1.5">
          {hasToday && (
            <div className="flex items-stretch gap-2">
              {/* Fulfillment hero */}
              <Link to="/routine-roster" className="flex flex-col items-center justify-center rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors px-3 py-1.5 w-24 flex-shrink-0">
                <p className={`text-2xl font-bold leading-none ${fulfillColor}`}>{fulfillment == null ? '—' : `${fulfillment}%`}</p>
                <p className="text-[10px] text-gray-500 mt-0.5 text-center leading-tight flex items-center gap-0.5"><CircleCheck className={`h-3 w-3 ${fulfillColor}`} />{L.fulfillment}</p>
              </Link>
              {/* Order tiles: row 1 actions, row 2 outcomes */}
              <div className="flex-1 grid grid-cols-3 auto-rows-fr gap-1.5">
                <Tile label={L.toAccept} value={toAccept} tone="amber" />
                <Tile label={L.inProgress} value={inProgress} tone="blue" />
                <Tile label={L.late} value={late} tone={late > 0 ? 'red' : 'slate'} />
                <Tile label={L.delivered} value={delivered} tone="teal" />
                <Tile label={L.confirmed} value={confirmed} tone="green" />
                <Tile label={L.forTomorrow} value={forTomorrow} tone="slate" />
              </div>
            </div>
          )}
          {hasRoom && (
            <div className="grid grid-cols-4 gap-1.5">
              <Tile label="C/I" value={rc.checkin} tone="blue" />
              <Tile label="OCC" value={rc.occupied} tone="teal" />
              <Tile label="Empty" value={rc.empty} tone="slate" />
              <Tile label="O/O" value={rc.oo} tone={rc.oo > 0 ? 'red' : 'slate'} />
            </div>
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

function Tile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <Link to="/routine-roster" className={`flex flex-col justify-center h-full rounded-md px-2 py-1 hover:brightness-95 transition-all ${TONES[tone]}`}>
      <p className="text-base font-bold leading-none">{value}</p>
      <p className="text-[10px] mt-0.5 opacity-80 leading-tight">{label}</p>
    </Link>
  )
}
