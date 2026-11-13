import { useCallback, useEffect, useRef, useState } from 'react'
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
import { cn, bangkokDate } from '@/lib/utils'

// "Upload Hotel Report" — the Dashboard card where Front Office drops the two
// PDFs from the nightly "Daily Manager Reports" email. The saved row is what the
// wall-panel board (/display, and later the ESP32 panel) reads.
//
// Parsing happens here in the browser rather than server-side on purpose — no
// ingest endpoint exists to be mis-permissioned, and the uploader sees the
// extracted numbers before anything is written. When the Gmail automation
// arrives it reuses the same parser, and this card stays as the way to correct
// a day the automation got wrong.

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

export function HotelReportUpload() {
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
  const [recent, setRecent] = useState<{ stat_date: string; occ_pct_today: number | null; hotel_revenue_today: number | null }[]>([])
  // The most recent upload by time, not by business day: re-uploading an older
  // day to correct it is still "the last upload".
  const [lastUpload, setLastUpload] = useState<{ stat_date: string; updated_at: string; uploader: { full_name: string } | null } | null>(null)
  const seq = useRef(0)

  const loadRecent = useCallback(async () => {
    if (!activeCompany) return
    const { data } = await supabase
      .from('kaizen_hotel_daily')
      .select('stat_date, occ_pct_today, hotel_revenue_today')
      .eq('company_id', activeCompany.id)
      .order('stat_date', { ascending: false })
      .limit(5)
    setRecent(data ?? [])
    const { data: last } = await supabase
      .from('kaizen_hotel_daily')
      .select('stat_date, updated_at, uploader:uploaded_by(full_name)')
      .eq('company_id', activeCompany.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setLastUpload(last as typeof lastUpload)
  }, [activeCompany])
  useEffect(() => { loadRecent() }, [loadRecent])

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
    // Clear the pickers so the next day's upload starts fresh.
    setMgrFile(null); setFcFile(null); setParsed(null)
    loadRecent()
  }

  const m = parsed?.manager
  const f = parsed?.forecast

  // The report printed on day N carries day N-1's figures, so on any given day
  // the newest row should be for yesterday (Bangkok). Older than that means
  // today's report has not been uploaded yet.
  const expectedDay = bangkokDate(new Date(Date.now() - 86_400_000))
  const newestDay = recent[0]?.stat_date ?? null
  const behind = !!newestDay && newestDay < expectedDay
  const fmtDay = (iso: string) => new Date(iso + 'T00:00:00+07:00').toLocaleDateString(
    th ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' })
  const fmtStamp = (ts: string) => new Date(ts).toLocaleString(
    th ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="font-semibold text-gray-900">{th ? 'อัปโหลดรายงานโรงแรม' : 'Upload Hotel Report'}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {th
            ? 'อัปโหลด PDF สองไฟล์จากอีเมล Daily Manager Reports เพื่ออัปเดตจอแสดงผล'
            : 'Upload the two PDFs from the Daily Manager Reports email to update the display board.'}
        </p>
        {lastUpload && (
          <p className={cn('text-xs mt-2 flex items-center gap-1.5', behind ? 'text-amber-700' : 'text-gray-600')}>
            {behind
              ? <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              : <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-600" />}
            <span>
              {th ? 'อัปโหลดล่าสุด: ' : 'Last upload: '}
              <strong className="font-semibold">{fmtStamp(lastUpload.updated_at)}</strong>
              {lastUpload.uploader?.full_name && <>{th ? ' โดย ' : ' by '}{lastUpload.uploader.full_name}</>}
              {' · '}
              {th ? 'ข้อมูลของวันที่ ' : 'figures for '}{fmtDay(lastUpload.stat_date)}
              {behind && (th
                ? ` — ยังไม่มีรายงานของวันที่ ${fmtDay(expectedDay)}`
                : ` — the report for ${fmtDay(expectedDay)} hasn't been uploaded yet`)}
            </span>
          </p>
        )}
      </div>

      <div className="p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {([
            ['Manager Report with Revenue.pdf', mgrFile, setMgrFile],
            ['Forecast and Availability Report.pdf', fcFile, setFcFile],
          ] as const).map(([name, file, set]) => (
            <label
              key={name}
              className={cn(
                'flex items-center gap-3 rounded-xl border-2 border-dashed p-3.5 cursor-pointer transition-colors',
                file ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white hover:border-[var(--brand-primary)]',
              )}
            >
              <input
                type="file" accept="application/pdf" className="hidden"
                // Reset the value so picking the same file again (e.g. after a
                // save cleared the card) still fires onChange.
                onClick={e => { (e.target as HTMLInputElement).value = '' }}
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
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            {th ? 'กำลังอ่านไฟล์…' : 'Reading the PDFs…'}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3">
            <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {saved && !parsed && (
          <p className="text-sm text-green-700 flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            {th ? `บันทึกข้อมูลวันที่ ${saved} แล้ว` : `Saved the report for ${saved}.`}
          </p>
        )}

        {m && f && (
          <div className="rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-900">
                {th ? 'ตรวจสอบก่อนบันทึก' : 'Check before saving'}
              </h3>
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

            <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 mb-3">
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

            <Button onClick={save} disabled={saving} className="mt-4">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {th ? 'บันทึก' : 'Save report'}
            </Button>
          </div>
        )}

        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            {th ? 'อัปโหลดล่าสุด' : 'Recently uploaded'}
          </p>
          {recent.length === 0 ? (
            <p className="text-sm text-gray-400">{th ? 'ยังไม่มีข้อมูล' : 'Nothing uploaded yet.'}</p>
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
    </div>
  )
}
