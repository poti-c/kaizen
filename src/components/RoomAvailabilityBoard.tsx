import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { PANEL as C, reportFreshness } from '@/lib/panelTheme'
import type { RoomConfig } from '@/components/RoomSetupSettings'
import type { ForecastDay } from '@/lib/hotelReports'
import { loadSandboxRow } from '@/lib/hotelSandbox'
import { bangkokDate } from '@/lib/utils'

import type { R052, TypeAvailability } from '@/lib/roomAvailabilityReports'
type Forecast = { asAtDate: string; days: ForecastDay[]; roomTypeAvailability?: TypeAvailability[] }
const status = (n: number | null) => n == null ? { color: C.muted, background: 'rgba(255,255,255,.035)' } : n < 0 ? { color: '#c084fc', background: '#38254e' } : n === 0 ? { color: '#f87171', background: '#3a202b' } : n <= 2 ? { color: '#fbbf24', background: '#3b3020' } : { color: '#4ade80', background: '#173629' }
const dayLabel = (date: string, options: Intl.DateTimeFormatOptions, lang: string) => new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', { ...options, timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'))

export function RoomAvailabilityBoard({ refreshMs, lang, sandbox = false, freshnessAlerts = true }: { refreshMs: number; lang: string; sandbox?: boolean; freshnessAlerts?: boolean }) {
  const { activeCompany } = useCompany()
  const th = lang === 'th'
  const [config, setConfig] = useState<RoomConfig | null>(null)
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [uploaded, setUploaded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const companyId = activeCompany?.id
  const [localReport, setLocalReport] = useState<R052 | null>(null)
  const [sharedUploaded, setSharedUploaded] = useState<string | null>(null)
  const [sharedReport, setSharedReport] = useState<R052 | null>(null)
  useEffect(() => {
    try { setLocalReport(companyId ? JSON.parse(localStorage.getItem(`kaizen-r052-${companyId}`) || 'null') : null) }
    catch { setLocalReport(null) }
    setSharedReport(null); setSharedUploaded(null)
  }, [companyId])
  useEffect(() => {
    setConfig(null); setForecast(null); setUploaded(null); setLoading(true); setError(false)
    if (!companyId) return
    let cancelled = false
    async function load() {
      const cfg = await supabase.from('kaizen_settings').select('value').eq('company_id', companyId!).eq('key', 'rr_room_config').maybeSingle()
      const report = sandbox ? null : await supabase.from('kaizen_hotel_daily').select('forecast, updated_at').eq('company_id', companyId!).order('stat_date', { ascending: false }).limit(1).maybeSingle()
      const shared = sandbox ? null : await supabase.from('kaizen_room_availability').select('report,updated_at').eq('company_id',companyId!).maybeSingle()
      if (cancelled) return
      if (shared?.data?.report) { setSharedReport(shared.data.report as R052); setSharedUploaded(shared.data.updated_at) }
      if (cfg.error || report?.error) { setError(true); setLoading(false); return }
      setError(false)
      setConfig(cfg.data?.value as RoomConfig | null ?? null)
      const local = sandbox ? loadSandboxRow() : null
      setForecast((sandbox ? local?.forecast : report?.data?.forecast) as Forecast | null ?? null)
      setUploaded(sandbox ? local?.report_date ?? null : report?.data?.updated_at ?? null)
      setLoading(false)
    }
    void load()
    const timer = setInterval(load, refreshMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [companyId, refreshMs, sandbox])
  const today = bangkokDate(new Date())
  const dates = useMemo(() => Array.from({ length: 10 }, (_, i) => {
    const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10)
  }), [today])
  const categories = useMemo(() => (config?.categories ?? []).slice().sort((a,b) => a.order - b.order).map(cat => ({
    id: cat.id, name: th ? cat.name_th || cat.name : cat.name,
    capacity: (config?.rooms ?? []).filter(r => config?.types?.some(t => t.code === r.type && t.category === cat.id)).length,
  })), [config, th])
  const report = sharedReport ?? localReport
  const freshness = report ? reportFreshness(sharedUploaded ?? report.reportDate) : null
  const types = report?.types ?? categories
  const map = new Map((report?.values ?? forecast?.roomTypeAvailability ?? []).filter(x => Number.isInteger(x.available)).map(x => [`${x.roomType}|${x.date}`, x.available]))
  const hasDetail = types.some(t => dates.some(d => map.has(`${t.id}|${d}`)))
  const totals = dates.map(d => { const items = types.map(t => map.get(`${t.id}|${d}`)); return items.length && items.every(n => n !== undefined) ? items.reduce<number>((a,n) => a + n!, 0) : null })
  const unoccupied = dates.map(d => { const day = forecast?.days.find(x => x.date === d); return day ? day.totalRooms - day.occupied : null })
  const group = (name: string) => name.replace(/\s+(King|Twin)$/i, '')
  const cell = (n: number | null, key: string) => <td key={key} className="p-0.5"><div className="h-full min-h-[21px] rounded-md flex items-center justify-center text-[17px] font-bold tabular-nums" style={status(n)}>{n ?? '—'}</div></td>
  return <div className="flex flex-col flex-1 min-h-0 gap-2" style={{ marginTop: 12 }}>
    <div className="flex items-center justify-between rounded-xl px-4 py-2 flex-shrink-0" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div><div className="text-[17px] font-bold">{th ? 'ห้องว่างตามประเภท · 10 วัน' : 'Room type availability · 10 days'}</div><div className="text-[11px]" style={{ color: C.muted }}>{dayLabel(dates[0], { day: 'numeric', month: 'short' }, lang)} – {dayLabel(dates[9], { day: 'numeric', month: 'short', year: 'numeric' }, lang)}</div></div>
      <span className="text-[12px] font-semibold" style={{ color: hasDetail ? C.resolved : C.pending }}>{loading ? (th ? 'กำลังโหลด…' : 'Loading…') : error ? (th ? 'อ่านข้อมูลไม่ได้' : 'Data unavailable') : hasDetail ? (sharedReport ? 'R052 · Staff upload' : localReport ? 'R052 · Local preview' : (th ? 'ข้อมูลตามประเภทห้อง' : 'Room-type report')) : (th ? 'ยังไม่มีข้อมูลห้องว่างตามประเภท' : 'Room-type data not yet supplied')}</span>
      <span className="text-[12px]" style={{ color: C.muted }}>{(report?.reportDate ?? uploaded) ? `${th ? 'ข้อมูล ณ วันที่' : 'As of'} ${new Intl.DateTimeFormat(th ? 'th-TH' : 'en-US', { timeZone: 'Asia/Bangkok', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(report?.reportDate ?? uploaded!))}` : '—'}{freshnessAlerts && freshness && <span className="ml-2 font-semibold" style={{color:freshness.color}}>{th?freshness.th:freshness.label}</span>}</span>
    </div>
    <div className="flex-1 min-h-0 overflow-auto rounded-xl px-2 py-1" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <style>{`.room-availability-grid .room-group-start > th, .room-availability-grid .room-group-start > td { border-top: 1px solid rgba(148,163,184,.32); padding-top: 2px; } .room-availability-grid .room-total > th, .room-availability-grid .room-total > td { border-top: 2px solid rgba(148,163,184,.48); padding-top: 2px; }`}</style>
      <table className="room-availability-grid w-full h-full table-fixed border-separate" style={{ borderSpacing: 2 }}>
        <colgroup><col style={{ width: 178 }}/><col style={{ width: 44 }}/>{dates.map(d => <col key={d}/>)}</colgroup>
        <thead><tr><th className="text-left pl-2 text-[12px]" style={{ color: C.muted }}>{th ? 'ประเภทห้อง' : 'ROOM TYPE'}</th><th className="text-[10px]" style={{ color: C.muted }}>{th ? 'จำนวน' : 'STOCK'}</th>{dates.map((d,i) => <th key={d} className="text-center py-1 rounded-md" style={{ background: i === 0 ? '#194252' : undefined, color: i === 0 ? '#67e8f9' : C.text }}><div className="text-[10px] uppercase" style={{ color: i === 0 ? '#67e8f9' : C.muted }}>{i === 0 ? (th ? 'วันนี้' : 'Today') : dayLabel(d,{ weekday:'short' },lang)}</div><div className="text-[14px]">{dayLabel(d,{ day:'numeric', month:'short' },lang)}</div></th>)}</tr></thead>
        <tbody>
          {types.map((t, i) => <tr key={t.id} className={i > 0 && group(types[i - 1].name) !== group(t.name) ? "room-group-start" : undefined}><th title={t.name} className="pl-2 text-left text-[13px] font-semibold truncate">{t.name}{report && <span className="ml-1 text-[10px]" style={{color:C.muted}}>{t.id}</span>}</th><td className="text-center text-[13px] tabular-nums" style={{color:C.muted}}>{t.capacity}</td>{dates.map(d => cell(map.get(`${t.id}|${d}`) ?? null,d))}</tr>)}
          {!types.length && <tr><td colSpan={12} className="text-center text-[14px]" style={{color:C.muted}}>{loading ? (th ? 'กำลังโหลด…' : 'Loading room types…') : (th ? 'ยังไม่ได้ตั้งค่าประเภทห้อง' : 'No room categories configured')}</td></tr>}
          <tr className="room-total" style={{background:'rgba(255,255,255,.04)'}}><th className="pl-2 text-left text-[13px] font-bold">{th ? 'รวมพร้อมขาย' : 'Total sellable'}</th><td className="text-center text-[13px] font-semibold">{types.reduce((a,t)=>a+t.capacity,0)||'—'}</td>{totals.map((n,i)=>cell(n,dates[i]))}</tr>
          {!report && <tr><th className="pl-2 text-left text-[12px] font-semibold" style={{color:C.muted}}>{th ? 'ห้องไม่ถูกจอง (พยากรณ์)' : 'Unoccupied (forecast)'}</th><td/><>{unoccupied.map((n,i)=><td key={dates[i]} className="text-center font-semibold text-[15px] tabular-nums" style={{color:C.inProgress}}>{n ?? '—'}</td>)}</></tr>}
        </tbody>
      </table>
    </div>
    <div className="flex items-center justify-between flex-shrink-0 text-[11px] px-2" style={{color:C.muted}}><div className="flex gap-3">{[[3,th?'ว่าง':'Available 3+'],[1,th?'เหลือน้อย':'Limited 1–2'],[0,th?'เต็ม':'Sold out'],[-1,th?'เกินจำนวน':'Overbooked'],[null,th?'ไม่มีข้อมูล':'Not supplied']].map(([n,label])=><span key={String(label)} className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm" style={{background:status(n as number|null).color}}/>{label}</span>)}</div><span>{sharedReport ? 'Source: PMS R052 · staff upload' : localReport ? 'Source: PMS R052 · local preview' : (th ? 'ห้องไม่ถูกจอง ≠ ห้องพร้อมขาย' : 'Unoccupied forecast ≠ confirmed sellable stock')}</span></div>
  </div>
}
