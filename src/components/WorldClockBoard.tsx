import { useEffect, useMemo, useState } from 'react'
import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun, Wind } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { PANEL as C } from '@/lib/panelTheme'
import { Panel } from '@/components/PanelCard'
import {
  CITY_OPTIONS, THAI_AQI_BANDS, US_AQI_BANDS,
  type AmbientData, type CityOption,
} from '@/lib/worldClock'

// World Clock board: three city clocks with their weather, and air quality at
// the panel's own location. Times are computed here from each city's time zone;
// weather and air quality come from the kaizen-ambient function (Open-Meteo,
// and Air4Thai monitoring stations), refreshed every 10 minutes.

const REFRESH_MS = 10 * 60 * 1000
const ICONS: Record<string, typeof Sun> = {
  sun: Sun, moon: Moon, partly: CloudSun, 'partly-night': CloudMoon, cloud: Cloud,
  fog: CloudFog, drizzle: CloudDrizzle, rain: CloudRain, snow: CloudSnow, storm: CloudLightning,
}

function timeIn(tz: string, now: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short', day: '2-digit', month: 'short',
  }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return { time: `${get('hour')}:${get('minute')}`, date: `${get('weekday')} ${get('day')} ${get('month')}` }
}
function offsetOf(tz: string, now: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0
}
const fmtOffset = (min: number) => {
  const sign = min < 0 ? '−' : '+', a = Math.abs(min)
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`
}
const fmtDiff = (min: number, th: boolean) => {
  if (min === 0) return th ? 'เวลาเดียวกัน' : 'Same time'
  const h = Math.abs(min) / 60
  const n = Number.isInteger(h) ? `${h}` : h.toFixed(1)
  return th ? `${min > 0 ? 'เร็วกว่า' : 'ช้ากว่า'} ${n} ชม.` : `${min > 0 ? '+' : '−'}${n} h`
}

export function WorldClockBoard({ clocks, airHome, lang }: { clocks: string[]; airHome: string; lang: string }) {
  const th = lang === 'th'
  const [now, setNow] = useState(() => new Date())
  const [data, setData] = useState<AmbientData | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const keys = clocks.join(',')
  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data: body, error } = await supabase.functions.invoke(
        `kaizen-ambient?clocks=${encodeURIComponent(keys)}&home=${encodeURIComponent(airHome)}`,
        { method: 'GET' },
      )
      if (cancelled) return
      if (error || !body) { setFailed(true); return }
      setData(body as AmbientData)
      setFailed(false)
    }
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [keys, airHome])

  const cities: CityOption[] = useMemo(
    () => clocks.map(k => CITY_OPTIONS.find(c => c.key === k)).filter((c): c is CityOption => !!c),
    [clocks],
  )
  const homeTz = CITY_OPTIONS.find(c => c.key === airHome)?.tz ?? 'Asia/Bangkok'
  const homeOffset = offsetOf(homeTz, now)
  const air = data?.air ?? null
  const bands = air?.scale === 'US' ? US_AQI_BANDS : THAI_AQI_BANDS
  const scaleMax = bands[bands.length - 1].upTo
  const homeName = th ? data?.home.nameTh : data?.home.name

  return (
    <>
      {/* Three clocks */}
      <div className="grid grid-cols-3 gap-3 flex-shrink-0" style={{ height: 250, marginTop: 12 }}>
        {cities.map(city => {
          const t = timeIn(city.tz, now)
          const off = offsetOf(city.tz, now)
          const wx = data?.clocks.find(c => c.key === city.key)
          const Icon = (wx?.icon && ICONS[wx.icon]) || Cloud
          const country = th ? wx?.countryTh : wx?.country
          return (
            <div key={city.key} className="rounded-xl px-5 py-4 flex flex-col min-w-0"
                 style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[17px] font-semibold truncate">{th ? city.nameTh : city.name}</div>
                  <div className="text-[11px] uppercase tracking-wider truncate" style={{ color: C.muted }}>{country ?? ' '}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-[11px] font-semibold tabular-nums" style={{ color: C.muted }}>{fmtOffset(off)}</div>
                  <div className="text-[11px] tabular-nums" style={{ color: off === homeOffset ? C.muted : 'var(--brand-primary, #0891b2)' }}>
                    {fmtDiff(off - homeOffset, th)}
                  </div>
                </div>
              </div>
              <div className="text-[72px] font-bold leading-none tabular-nums mt-4">{t.time}</div>
              <div className="text-[13px] mt-2" style={{ color: C.muted }}>{t.date}</div>
              <div className="flex items-center gap-3 mt-auto pt-3" style={{ borderTop: `1px solid ${C.border}` }}>
                <Icon className="h-8 w-8 flex-shrink-0" style={{ color: C.text }} />
                <span className="text-[30px] font-bold tabular-nums leading-none">
                  {wx?.temp != null ? `${wx.temp}°C` : '—'}
                </span>
                <span className="text-[13px] truncate" style={{ color: C.muted }}>
                  {(th ? wx?.labelTh : wx?.label) ?? (failed ? (th ? 'ไม่มีข้อมูลอากาศ' : 'Weather unavailable') : '')}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Air quality at the panel's location */}
      <div className="flex gap-3 flex-shrink-0" style={{ height: 168, marginTop: 12 }}>
        <Panel
          title={`${th ? 'คุณภาพอากาศ' : 'Air quality'}${homeName ? ` · ${homeName}` : ''}`}
          className="flex-1"
          right={air ? (
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>
              {air.scale === 'TH' ? (th ? 'ดัชนีคุณภาพอากาศ (ไทย)' : 'Thai AQI') : 'US AQI'}
            </span>
          ) : undefined}
        >
          {!air ? (
            <div className="h-full flex items-center justify-center gap-2 text-[13px]" style={{ color: C.muted }}>
              <Wind className="h-4 w-4" />
              {failed || data ? (th ? 'ไม่มีข้อมูลคุณภาพอากาศ' : 'Air quality unavailable') : (th ? 'กำลังโหลด…' : 'Loading…')}
            </div>
          ) : (
            <div className="h-full flex items-stretch gap-6">
              {/* AQI */}
              <div className="flex flex-col justify-center flex-shrink-0" style={{ width: 230 }}>
                <div className="flex items-end gap-3">
                  <span className="text-[64px] font-bold leading-none tabular-nums" style={{ color: air.level?.color ?? C.text }}>
                    {air.aqi ?? '—'}
                  </span>
                  <span className="text-[12px] font-semibold uppercase tracking-wider pb-2" style={{ color: C.muted }}>AQI</span>
                </div>
                <div className="text-[15px] font-semibold mt-2" style={{ color: air.level?.color ?? C.text }}>
                  {(th ? air.level?.labelTh : air.level?.label) ?? ''}
                </div>
              </div>
              {/* Pollutants */}
              <div className="flex-1 min-w-0 flex flex-col justify-center gap-3">
                <div className="flex flex-wrap gap-x-8 gap-y-2">
                  {air.pollutants.map((p, i) => (
                    <div key={p.key}>
                      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>{p.key}</div>
                      <div className="tabular-nums">
                        <span className={i === 0 ? 'text-[34px] font-bold' : 'text-[20px] font-semibold'}>{p.value}</span>
                        <span className="text-[11px] ml-1" style={{ color: C.muted }}>{p.unit}</span>
                      </div>
                    </div>
                  ))}
                </div>
                {/* scale with a marker at the current AQI */}
                <div className="relative" style={{ height: 8 }}>
                  <div className="flex h-full rounded-full overflow-hidden">
                    {bands.map((b, i) => (
                      <span key={i} style={{ background: b.color, opacity: 0.85,
                        width: `${((b.upTo - (i ? bands[i - 1].upTo : 0)) / scaleMax) * 100}%` }} />
                    ))}
                  </div>
                  {air.aqi != null && (
                    <span className="absolute rounded-full" style={{
                      top: -4, width: 16, height: 16, marginLeft: -8, background: C.text, border: `3px solid ${C.bg}`,
                      left: `${Math.min(100, (air.aqi / scaleMax) * 100)}%`,
                    }} />
                  )}
                </div>
                <div className="text-[11px] truncate" style={{ color: C.muted }}>
                  {air.station
                    ? `${air.source} · ${th ? air.station.nameTh : air.station.name} (${air.station.km} km) · ${air.time.slice(11, 16)}`
                    : `${air.source} · ${air.time.slice(11, 16)}`}
                </div>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </>
  )
}
