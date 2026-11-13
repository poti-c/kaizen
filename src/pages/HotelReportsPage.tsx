import { useEffect, useRef, useState } from 'react'
import { FileUp, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { pdfTextItems } from '@/lib/pdfText'
import {
  linesFromItems, parseManagerReport, parseForecastReport, toHotelRow,
  weekWindow, monthWindows, currentMonthCombined,
  type ManagerReport, type ForecastReport,
} from '@/lib/hotelReports'
import { saveSandboxRow, clearSandboxRow, loadSandboxRow } from '@/lib/hotelSandbox'
import { cn } from '@/lib/utils'

// Manual ingest for the daily hotel figures: drop the two PDFs from the
// "Daily Manager Reports" email, check what was read out of them, then save.
//
// Parsing happens here in the browser rather than server-side on purpose — it
// means no ingest endpoint exists yet to be mis-permissioned, and the person
// uploading sees the extracted numbers before anything is written. When the
// Gmail automation arrives it reuses the same parser, and this page stays as
// the way to correct a day the automation got wrong.

type Parsed = { manager: ManagerReport; forecast: ForecastReport }

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-lg font-bold text-gray-900 tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
    </div>
  )
}

export function HotelReportsPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { lang } = useLanguage()
  const th = lang === 'th'

  const [mgrFile, setMgrFile] = useState<File | null>(null)
  const [fcFile, setFcFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [sandboxed, setSandboxed] = useState<string | null>(() => loadSandboxRow()?.stat_date ?? null)
  const [recent, setRecent] = useState<{ stat_date: string; occ_pct_today: number | null; hotel_revenue_today: number | null }[]>([])
  const seq = useRef(0)

  async function loadRecent() {
    if (!activeCompany) return
    const { data } = await supabase
      .from('kaizen_hotel_daily')
      .select('stat_date, occ_pct_today, hotel_revenue_today')
      .eq('company_id', activeCompany.id)
      .order('stat_date', { ascending: false })
      .limit(7)
    setRecent(data ?? [])
  }
  useEffect(() => { loadRecent() }, [activeCompany])

  // Parse as soon as both files are present, so the numbers can be checked
  // before anything is written.
  useEffect(() => {
    if (!mgrFile || !fcFile) { setParsed(null); return }
    const mine = ++seq.current
    setBusy(true); setError(null); setParsed(null); setSaved(null)
    ;(async () => {
      try {
        const [mgrItems, fcItems] = await Promise.all([pdfTextItems(mgrFile), pdfTextItems(fcFile)])
        if (mine !== seq.current) return
        let manager: ManagerReport
        let forecast: ForecastReport
        try {
          manager = parseManagerReport(linesFromItems(mgrItems))
        } catch (e) {
          // The two inputs are easy to swap, and the error should say so
          // rather than just "row not found".
          throw new Error(
            `${th ? 'อ่านไฟล์ Manager Report ไม่สำเร็จ' : 'Could not read the Manager Report'}: ${(e as Error).message}`,
          )
        }
        try {
          forecast = parseForecastReport(linesFromItems(fcItems))
        } catch (e) {
          throw new Error(
            `${th ? 'อ่านไฟล์ Forecast ไม่สำเร็จ' : 'Could not read the Forecast report'}: ${(e as Error).message}`,
          )
        }
        if (mine !== seq.current) return
        setParsed({ manager, forecast })
      } catch (e) {
        if (mine === seq.current) setError((e as Error).message)
      } finally {
        if (mine === seq.current) setBusy(false)
      }
    })()
  }, [mgrFile, fcFile, th])

  // The manager report describes yesterday; the forecast starts today. Any
  // other gap means the two files are from different days.
  const dayGap = parsed
    ? Math.round(
        (new Date(parsed.forecast.asAtDate).getTime() - new Date(parsed.manager.statDate).getTime())
        / 86_400_000,
      )
    : 0
  const mismatched = !!parsed && dayGap !== 1

  async function save() {
    if (!parsed || !activeCompany || !profile) return
    setSaving(true); setError(null)
    const { manager: m, forecast: f } = parsed
    const { error: err } = await supabase.from('kaizen_hotel_daily').upsert({
      ...toHotelRow(m, f),
      company_id: activeCompany.id,
      uploaded_by: profile.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,stat_date' })
    setSaving(false)
    if (err) { setError(err.message); return }
    setSaved(m.statDate)
    loadRecent()
  }

  function saveSandbox() {
    if (!parsed) return
    saveSandboxRow(toHotelRow(parsed.manager, parsed.forecast))
    setSandboxed(parsed.manager.statDate)
    setSaved(null)
  }

  const m = parsed?.manager
  const f = parsed?.forecast

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto animate-fade-in">
      <div className="mb-5">
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">
          {th ? 'รายงานประจำวันของโรงแรม' : 'Daily Hotel Reports'}
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {th
            ? 'อัปโหลด PDF สองไฟล์จากอีเมล Daily Manager Reports เพื่ออัปเดตแดชบอร์ด'
            : 'Upload the two PDFs from the Daily Manager Reports email to update the board.'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        {([
          ['Manager Report with Revenue.pdf', mgrFile, setMgrFile],
          ['Forecast and Availability Report.pdf', fcFile, setFcFile],
        ] as const).map(([name, file, set]) => (
          <label
            key={name}
            className={cn(
              'flex items-center gap-3 rounded-xl border-2 border-dashed p-4 cursor-pointer transition-colors',
              file ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white hover:border-[var(--brand-primary)]',
            )}
          >
            <input
              type="file" accept="application/pdf" className="hidden"
              onChange={e => set(e.target.files?.[0] ?? null)}
            />
            {file
              ? <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
              : <FileUp className="h-5 w-5 text-gray-400 flex-shrink-0" />}
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{name}</div>
              <div className="text-xs text-gray-500 truncate">
                {file ? file.name : (th ? 'คลิกเพื่อเลือกไฟล์' : 'Click to choose the file')}
              </div>
            </div>
          </label>
        ))}
      </div>

      {busy && (
        <div className="flex items-center gap-2 text-sm text-gray-600 mb-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          {th ? 'กำลังอ่านไฟล์…' : 'Reading the PDFs…'}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 mb-4">
          <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {m && f && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-900">
              {th ? 'ตรวจสอบก่อนบันทึก' : 'Check before saving'}
            </h2>
            <span className="text-xs text-gray-500">
              {th ? 'ข้อมูลของวันที่' : 'Figures for'} <strong>{m.statDate}</strong>
            </span>
          </div>

          {mismatched && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 mb-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-amber-800">
                {th
                  ? `ไฟล์อาจมาจากคนละวัน: Manager Report เป็นข้อมูลวันที่ ${m.statDate} แต่ Forecast เริ่มวันที่ ${f.asAtDate}`
                  : `These may be from different days — the Manager Report covers ${m.statDate} but the forecast starts ${f.asAtDate}.`}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 mb-4">
            <Stat label="% Rms Occupied" value={`${m.occPct.today}%`} sub={`M-T-D ${m.occPct.mtd}% · Y-T-D ${m.occPct.ytd}%`} />
            <Stat label="% excl Comp & HU" value={`${m.occExclCompHuPct.today}%`} sub={`M-T-D ${m.occExclCompHuPct.mtd}% · Y-T-D ${m.occExclCompHuPct.ytd}%`} />
            <Stat label="Rooms Occupied" value={`${m.roomsOccupied.today} / ${m.roomsAvailForSale.today}`} sub={`M-T-D ${m.roomsOccupied.mtd} / ${m.roomsAvailForSale.mtd}`} />
            <Stat label="Hotel Revenue" value={fmtMoney(m.hotelRevenue.today)} sub={`M-T-D ${fmtMoney(m.hotelRevenue.mtd)}`} />
            <Stat label="Hotel Revenue Y-T-D" value={fmtMoney(m.hotelRevenue.ytd)} sub={`${th ? 'ปีก่อน' : 'last year'} ${fmtMoney(m.lastYear.hotelRevenue.ytd)}`} />
            <Stat label="ADR" value={fmtMoney(m.avgRatePerRoom.today)} sub={`M-T-D ${fmtMoney(m.avgRatePerRoom.mtd)}`} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            {[weekWindow(f), currentMonthCombined(m, f), ...monthWindows(f, 3).slice(1)].map(w => (
              <Stat key={w.label} label={w.label} value={`${w.pct.toFixed(2)}%`} sub={`${w.occupied} / ${w.available}`} />
            ))}
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            {th
              ? 'เดือนนี้ = ข้อมูลจริงถึงเมื่อวาน + พยากรณ์ที่เหลือของเดือน'
              : 'This month combines month-to-date actuals with the rest of the month from the forecast.'}
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-4">
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {th ? 'บันทึก' : 'Save to dashboard'}
            </Button>
            <Button variant="outline" onClick={saveSandbox}>
              {th ? 'ทดลองบนเครื่องนี้' : 'Try in sandbox'}
            </Button>
            {saved && (
              <span className="text-sm text-green-700 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                {th ? `บันทึกข้อมูลวันที่ ${saved} แล้ว` : `Saved ${saved}`}
              </span>
            )}
            {sandboxed && !saved && (
              <span className="text-sm text-amber-700 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                {th
                  ? `อยู่ใน sandbox แล้ว — เปิด /display?sandbox=1`
                  : `In sandbox — open /display?sandbox=1`}
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            {th
              ? 'Sandbox เก็บข้อมูลไว้ในเบราว์เซอร์นี้เท่านั้น ไม่แตะฐานข้อมูล และไม่ได้ทดสอบ migration หรือ RLS'
              : 'Sandbox keeps the row in this browser only — it touches no database, and does not test the migration, the RLS policies or the upsert.'}
          </p>
        </div>
      )}

      {sandboxed && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 mb-5">
          <p className="text-sm text-amber-900">
            {th
              ? `มีข้อมูล sandbox ของวันที่ ${sandboxed} อยู่บนเครื่องนี้`
              : `A sandbox row for ${sandboxed} is held in this browser.`}
          </p>
          <Button variant="outline" onClick={() => { clearSandboxRow(); setSandboxed(null) }}>
            {th ? 'ล้าง sandbox' : 'Clear sandbox'}
          </Button>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
        <h2 className="font-semibold text-gray-900 mb-2">{th ? 'อัปโหลดล่าสุด' : 'Recent days'}</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-gray-500">{th ? 'ยังไม่มีข้อมูล' : 'Nothing uploaded yet.'}</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {recent.map(r => (
              <div key={r.stat_date} className="flex items-center justify-between py-1.5 text-sm">
                <span className="font-mono text-gray-700">{r.stat_date}</span>
                <span className="text-gray-500 tabular-nums">
                  {r.occ_pct_today ?? '—'}% · {r.hotel_revenue_today != null ? fmtMoney(Number(r.hotel_revenue_today)) : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
