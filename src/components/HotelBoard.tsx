import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from 'recharts'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { PANEL as C } from '@/lib/panelTheme'
import { Panel } from '@/components/PanelCard'
import type { ForecastDay, ForecastMonth } from '@/lib/hotelReports'
import { loadSandboxRow } from '@/lib/hotelSandbox'

// Wall board for the hotel figures extracted from the daily manager email.
// Reads whatever the upload page last saved; it never parses anything itself.

interface HotelRow {
  stat_date: string
  occ_pct_today: number | null
  occ_pct_mtd: number | null
  occ_pct_ytd: number | null
  occ_excl_pct_today: number | null
  occ_excl_pct_mtd: number | null
  rooms_occupied_today: number | null
  rooms_occupied_mtd: number | null
  rooms_avail_today: number | null
  rooms_avail_mtd: number | null
  hotel_revenue_today: number | null
  hotel_revenue_mtd: number | null
  hotel_revenue_ytd: number | null
  room_revenue_today: number | null
  fb_revenue_today: number | null
  misc_revenue_today: number | null
  adr_today: number | null
  ly_occ_pct_today: number | null
  ly_hotel_rev_today: number | null
  ly_hotel_rev_ytd: number | null
  forecast: { asAtDate: string; days: ForecastDay[]; months: ForecastMonth[] } | null
}

const COLS = 'stat_date, occ_pct_today, occ_pct_mtd, occ_pct_ytd, occ_excl_pct_today, occ_excl_pct_mtd, '
  + 'rooms_occupied_today, rooms_occupied_mtd, rooms_avail_today, rooms_avail_mtd, '
  + 'hotel_revenue_today, hotel_revenue_mtd, hotel_revenue_ytd, '
  + 'room_revenue_today, fb_revenue_today, misc_revenue_today, adr_today, '
  + 'ly_occ_pct_today, ly_hotel_rev_today, ly_hotel_rev_ytd, forecast'

const num = (v: number | null | undefined) => (v == null ? null : Number(v))
const pct = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}%`)

/** Compact for the tile: a 36px "2,384,786.89" does not fit 155px. */
function money(v: number | null): string {
  if (v == null) return '—'
  const abs = Math.abs(v)
  if (abs >= 10_000_000) return `฿${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000_000) return `฿${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `฿${(v / 1_000).toFixed(1)}K`
  return `฿${v.toFixed(0)}`
}
const exact = (v: number | null) =>
  v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 0 })

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl px-3 flex flex-col justify-center min-w-0"
         style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="text-[30px] font-bold leading-none tabular-nums truncate" style={{ color: color ?? C.text }}>
        {value}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wider mt-1.5 truncate" style={{ color: C.muted }} title={label}>
        {label}
      </div>
      {sub && <div className="text-[10px] mt-0.5 truncate" style={{ color: C.muted }}>{sub}</div>}
    </div>
  )
}

export function HotelBoard({ refreshMs, lang, sandbox = false }: {
  refreshMs: number
  lang: string
  /** Read the device-local sandbox row instead of the database. */
  sandbox?: boolean
}) {
  const { activeCompany } = useCompany()
  const th = lang === 'th'
  const [row, setRow] = useState<HotelRow | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (sandbox) {
      const r = loadSandboxRow()
      if (r) { setRow(r as unknown as HotelRow); setState('ready') }
      else { setState('empty') }
      return
    }
    if (!activeCompany) return
    let cancelled = false
    async function load() {
      const { data, error } = await supabase
        .from('kaizen_hotel_daily')
        .select(COLS)
        .eq('company_id', activeCompany!.id)
        .order('stat_date', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled) return
      if (error) {
        // Most likely the migration has not been applied yet. Say so on the
        // board instead of showing an empty frame that looks like real zeroes.
        setState('error')
        setMessage(error.message)
        return
      }
      if (!data) { setState('empty'); return }
      setRow(data as unknown as HotelRow)
      setState('ready')
    }
    load()
    const id = setInterval(load, refreshMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [activeCompany, refreshMs, sandbox])

  // Next 14 days of the saved forecast, for the trend chart.
  const chartDays = useMemo(() => {
    const days = row?.forecast?.days ?? []
    return days.slice(0, 14).map((d, i) => ({
      label: d.date.slice(8, 10),
      pct: d.occPct,
      today: i === 0,
    }))
  }, [row])

  // This week, this month (actual + forecast), and the two months after.
  const windows = useMemo(() => {
    if (!row?.forecast) return []
    const { days, months } = row.forecast
    const week = days.slice(0, 7)
    const weekOcc = week.reduce((s, d) => s + d.occupied, 0)
    const weekAvail = week.reduce((s, d) => s + d.totalRooms, 0)
    const mtdOcc = num(row.rooms_occupied_mtd) ?? 0
    const mtdAvail = num(row.rooms_avail_mtd) ?? 0
    const rest = months[0]
    const out = [
      { label: th ? 'สัปดาห์นี้' : 'This week', occ: weekOcc, avail: weekAvail },
      {
        label: th ? 'เดือนนี้' : 'This month',
        occ: mtdOcc + (rest?.occupiedRoomNights ?? 0),
        avail: mtdAvail + (rest?.totalRoomNights ?? 0),
      },
      ...months.slice(1, 3).map(m => ({ label: m.month, occ: m.occupiedRoomNights, avail: m.totalRoomNights })),
    ]
    return out.map(w => ({ ...w, pct: w.avail ? (w.occ / w.avail) * 100 : 0 }))
  }, [row, th])

  const revenueSplit = useMemo(() => {
    if (!row) return []
    return [
      { label: th ? 'ห้องพัก' : 'Rooms', value: num(row.room_revenue_today) ?? 0, color: C.inProgress },
      { label: th ? 'อาหารและเครื่องดื่ม' : 'F&B', value: num(row.fb_revenue_today) ?? 0, color: C.resolved },
      { label: th ? 'อื่น ๆ' : 'Other', value: num(row.misc_revenue_today) ?? 0, color: C.pending },
    ]
  }, [row, th])
  const revMax = Math.max(1, ...revenueSplit.map(r => r.value))

  if (state !== 'ready' || !row) {
    const text = state === 'loading'
      ? (th ? 'กำลังโหลด…' : 'Loading…')
      : state === 'error'
        ? (th ? `อ่านข้อมูลไม่ได้: ${message}` : `Can't read hotel data: ${message}`)
        : sandbox
          ? (th
              ? 'sandbox ว่าง — อัปโหลด PDF แล้วกด "ทดลองบนเครื่องนี้"'
              : 'Sandbox is empty — upload the PDFs and press "Try in sandbox"')
          : (th
              ? 'ยังไม่มีข้อมูล — อัปโหลด PDF ที่หน้า "รายงานโรงแรม"'
              : 'No report uploaded yet — add one on the Hotel Reports page')
    return (
      <div className="flex-1 flex items-center justify-center rounded-xl"
           style={{ background: C.card, border: `1px solid ${C.border}`, marginTop: 12 }}>
        <span className="text-[13px] px-6 text-center" style={{ color: state === 'error' ? C.critical : C.muted }}>
          {text}
        </span>
      </div>
    )
  }

  const occToday = num(row.occ_pct_today)
  const lyOcc = num(row.ly_occ_pct_today)
  const revToday = num(row.hotel_revenue_today)
  const lyRev = num(row.ly_hotel_rev_today)

  return (
    <>
      {/* KPI row */}
      <div className="grid grid-cols-6 gap-3 flex-shrink-0" style={{ height: 86, marginTop: 12 }}>
        <Tile
          label={th ? 'เข้าพักวันนี้' : 'Occupancy today'}
          value={pct(occToday)}
          sub={`${row.rooms_occupied_today ?? '—'} / ${row.rooms_avail_today ?? '—'} ${th ? 'ห้อง' : 'rooms'}`}
          color={C.inProgress}
        />
        <Tile
          label={th ? 'เข้าพัก M-T-D' : 'Occupancy M-T-D'}
          value={pct(num(row.occ_pct_mtd))}
          sub={`${row.rooms_occupied_mtd ?? '—'} / ${row.rooms_avail_mtd ?? '—'}`}
        />
        <Tile
          label={th ? 'ไม่รวม Comp & HU' : 'Excl Comp & HU'}
          value={pct(num(row.occ_excl_pct_today))}
          sub={`M-T-D ${pct(num(row.occ_excl_pct_mtd))}`}
        />
        <Tile
          label={th ? 'รายได้วันนี้' : 'Revenue today'}
          value={money(revToday)}
          sub={`${th ? 'ปีก่อน' : 'LY'} ${money(lyRev)}`}
          color={C.resolved}
        />
        <Tile
          label={th ? 'รายได้ M-T-D' : 'Revenue M-T-D'}
          value={money(num(row.hotel_revenue_mtd))}
          sub={exact(num(row.hotel_revenue_mtd))}
        />
        <Tile
          label={th ? 'รายได้ Y-T-D' : 'Revenue Y-T-D'}
          value={money(num(row.hotel_revenue_ytd))}
          sub={`${th ? 'ปีก่อน' : 'LY'} ${money(num(row.ly_hotel_rev_ytd))}`}
        />
      </div>

      {/* Forecast trend + today detail */}
      <div className="flex gap-3 flex-shrink-0" style={{ height: 202, marginTop: 12 }}>
        <Panel title={th ? 'พยากรณ์การเข้าพัก 14 วัน' : 'Occupancy forecast · next 14 days'} className="flex-1">
          {chartDays.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[12px]" style={{ color: C.muted }}>
              {th ? 'ไม่มีข้อมูลพยากรณ์' : 'No forecast in this report'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartDays} margin={{ top: 16, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
                <YAxis domain={[0, 100]} tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} width={34} unit="%" />
                <Bar dataKey="pct" radius={[3, 3, 0, 0]} isAnimationActive={false}
                     label={{ position: 'top', fill: C.text, fontSize: 9, formatter: (v: number) => Math.round(v) }}>
                  {chartDays.map((d, i) => (
                    <Cell key={i} fill={d.today ? 'var(--brand-primary, #0891b2)' : 'rgba(255,255,255,0.18)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title={th ? 'วันนี้' : 'Today'} style={{ width: 324 }} className="flex-shrink-0">
          <div className="h-full flex flex-col justify-center gap-2.5">
            {[
              { k: th ? 'ห้องที่ขายได้' : 'Rooms occupied', v: `${row.rooms_occupied_today ?? '—'} / ${row.rooms_avail_today ?? '—'}` },
              { k: 'ADR', v: exact(num(row.adr_today)) },
              { k: th ? 'รายได้รวม' : 'Hotel revenue', v: exact(revToday) },
              {
                k: th ? 'เทียบปีก่อน' : 'vs last year',
                v: lyOcc != null && occToday != null ? `${(occToday - lyOcc).toFixed(2)} pt` : '—',
                color: lyOcc != null && occToday != null ? (occToday >= lyOcc ? C.resolved : C.critical) : undefined,
              },
            ].map(r => (
              <div key={r.k} className="flex items-baseline justify-between gap-2">
                <span className="text-[12px]" style={{ color: C.muted }}>{r.k}</span>
                <span className="text-[16px] font-bold tabular-nums" style={{ color: r.color ?? C.text }}>{r.v}</span>
              </div>
            ))}
            <div className="text-[10px] pt-1" style={{ color: C.muted }}>
              {th ? 'ข้อมูลวันที่' : 'Figures for'} {row.stat_date}
            </div>
          </div>
        </Panel>
      </div>

      {/* Occupancy windows + revenue split */}
      <div className="flex gap-3 flex-shrink-0" style={{ height: 130, marginTop: 12 }}>
        <Panel title={th ? 'อัตราการเข้าพักล่วงหน้า' : 'Occupancy outlook'} className="flex-1">
          <div className="grid grid-cols-4 gap-3 h-full items-center">
            {windows.map(w => (
              <div key={w.label} className="min-w-0">
                <div className="text-[22px] font-bold leading-none tabular-nums">{w.pct.toFixed(1)}%</div>
                <div className="text-[10px] font-semibold uppercase tracking-wider mt-1 truncate" style={{ color: C.muted }}>
                  {w.label}
                </div>
                <div className="text-[10px] tabular-nums" style={{ color: C.muted }}>
                  {w.occ} / {w.avail}
                </div>
                <span className="block h-1.5 rounded-full mt-1.5 overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                  <span className="block h-full rounded-full"
                        style={{ width: `${Math.min(100, w.pct)}%`, background: 'var(--brand-primary, #0891b2)' }} />
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={th ? 'รายได้วันนี้ตามหมวด' : "Today's revenue split"} style={{ width: 324 }} className="flex-shrink-0">
          <div className="space-y-2">
            {revenueSplit.map(r => (
              <div key={r.label} className="flex items-center gap-2">
                <span className="text-[11px] truncate" style={{ width: 92, color: C.muted }}>{r.label}</span>
                <span className="flex-1 h-2.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <span className="block h-full rounded-full" style={{ width: `${(r.value / revMax) * 100}%`, background: r.color }} />
                </span>
                <span className="text-[11px] font-semibold tabular-nums w-16 text-right flex-shrink-0">{exact(r.value)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  )
}
