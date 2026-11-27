import { useState, type ReactNode } from 'react'
import { X, Monitor, RefreshCw, Wifi, Cpu, Info, Clock, ChevronRight, LayoutDashboard, Lock, Check } from 'lucide-react'
import { PANEL as P, BOARD_IDS, BOARD_LABELS, type PanelSettings, type BoardId } from '@/lib/panelTheme'
import { cn } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import { CITY_OPTIONS } from '@/lib/worldClock'

// ─────────────────────────────────────────────────────────────────────────────
// System Settings for the wall panel.
//
// This is the screen an ESP32-P4 build would need, laid out the way it would be
// laid out there: a tab rail on the left (reachable with a thumb, no scrolling
// to find a section) and controls sized for a finger, not a mouse — 44px touch
// targets, no hover-only affordances, no dropdowns that open off-screen.
//
// Items tagged `device` are the ones firmware owns rather than this page:
// on hardware they write NVS and act on the panel itself (backlight PWM, the
// Wi-Fi/Ethernet stack, a reboot). Here they are demo state so the shape of the
// screen can be reviewed before any firmware exists. Everything untagged is
// live — it really does drive this board.
// ─────────────────────────────────────────────────────────────────────────────

type SectionId = 'display' | 'dashboards' | 'clock' | 'data' | 'network' | 'device' | 'about'

// Stand-in for what firmware would report over its own API. Fixed values, not
// invented per-render, so the screen does not look like it is live when it is not.
const DEMO_DEVICE = {
  model: 'Guition JC1060P470C',
  soc: 'ESP32-P4 (dual RISC-V @ 360 MHz)',
  radio: 'ESP32-C6 · ESP-Hosted',
  firmware: 'kaizen-panel 0.1.0-demo',
  psram: '32 MB (24.1 MB free)',
  flash: '16 MB (4.8 MB free)',
  uptime: '6d 04:12',
  temp: '46 °C',
  ssid: 'NNR-Staff-5G',
  rssi: '−58 dBm',
  ip: '10.20.3.41',
  mac: 'A0:85:E3:1C:77:B2',
}

// The browser has no device radio. Keep this preview explicitly simulated and
// do not request or store Wi-Fi credentials here.
const DEMO_NETWORKS = [
  { ssid: 'Demo Staff', rssi: -48, secure: true },
  { ssid: 'Demo Lobby', rssi: -62, secure: true },
  { ssid: 'Demo Guest', rssi: -71, secure: false },
  { ssid: 'Demo Office', rssi: -83, secure: true },
]
function NetworkPreview({ th }: { th: boolean }) {
  const [connected, setConnected] = useState<string | null>('Demo Staff')
  const [saved, setSaved] = useState(['Demo Staff', 'Demo Lobby'])
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const scan = () => { setScanning(true); setSelected(null); setMessage(''); window.setTimeout(() => { setScanning(false); setMessage(th ? 'สแกนจำลองเสร็จแล้ว' : 'Simulated scan complete') }, 450) }
  const current = DEMO_NETWORKS.find(n => n.ssid === connected)
  function join(ssid: string) { setConnected(ssid); setSaved(v => v.includes(ssid) ? v : [...v, ssid]); setSelected(null); setMessage(th ? 'เชื่อมต่อจำลองแล้ว' : 'Simulated connection established') }
  return <div className="py-2 space-y-3">
    <div className="flex items-center justify-between"><div><h3 className="text-[16px] font-semibold">{th ? 'เครือข่ายไร้สาย' : 'Wi-Fi networks'}</h3><p className="text-[11px]" style={{color:P.muted}}>{th ? 'ตัวอย่างเท่านั้น — สแกนจริงบน ESP32' : 'Preview only · real scanning runs on the ESP32'}</p></div><span className="text-[10px] font-semibold px-2 py-1 rounded" style={{color:P.pending,background:'rgba(245,158,11,.14)'}}>SIMULATED</span></div>
    <div className="rounded-xl px-3 py-2.5 flex items-center gap-3" style={{background:P.card,border:`1px solid ${P.border}`}}><Wifi className="h-5 w-5" style={{color:connected?P.resolved:P.muted}}/><div className="flex-1"><div className="text-[13px] font-semibold">{connected??(th?'ไม่ได้เชื่อมต่อ':'Not connected')}</div><div className="text-[11px]" style={{color:P.muted}}>{connected?`${th?'เชื่อมต่อ (จำลอง)':'Connected (simulated)'} · ${current?.rssi??'—'} dBm · 2.4 GHz`:'Select a network below'}</div></div>{connected&&<ActionButton label={th?'ลืม':'Forget'} onClick={()=>{setSaved(v=>v.filter(x=>x!==connected));setConnected(null);setMessage(th?'ลืมเครือข่ายจำลองแล้ว':'Simulated network forgotten')}}/>}</div>
    <div className="flex items-center justify-between"><span className="text-[12px] font-semibold" style={{color:P.muted}}>{th?'เครือข่ายที่พบ':'AVAILABLE NETWORKS'} · {DEMO_NETWORKS.length}</span><button disabled={scanning} onClick={scan} className="rounded-lg px-3 py-2 flex items-center gap-2 text-[12px] font-semibold disabled:opacity-60" style={{background:'var(--brand-primary, #0891b2)',color:'#fff'}}><RefreshCw className="h-4 w-4"/>{scanning?(th?'กำลังสแกน…':'Scanning…'):(th?'สแกน':'Scan again')}</button></div>
    <div className="rounded-xl overflow-hidden" style={{background:P.card,border:`1px solid ${P.border}`}}>{DEMO_NETWORKS.map(n=>{const strength=n.rssi>=-55?4:n.rssi>=-67?3:n.rssi>=-78?2:1;return <button key={n.ssid} disabled={scanning} onClick={()=>n.ssid===connected?setSelected(null):setSelected(n.ssid)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left" style={{borderBottom:`1px solid ${P.border}`,background:selected===n.ssid?'rgba(8,145,178,.18)':undefined}}><div className="flex items-end gap-[2px] h-4 w-6" aria-label={`${strength} of 4 signal bars`}>{[1,2,3,4].map(i=><span key={i} className="w-[4px] rounded-sm" style={{height:4*i,background:i<=strength?(strength<=1?P.critical:strength===2?P.pending:P.resolved):'rgba(255,255,255,.12)'}}/>)}</div><span className="flex-1 text-[13px] font-medium">{n.ssid}</span>{n.secure&&<Lock className="h-3.5 w-3.5" style={{color:P.muted}}/>}{saved.includes(n.ssid)&&<span className="text-[11px]" style={{color:P.muted}}>{th?'บันทึกแล้ว':'Saved'}</span>}<span className="text-[11px] tabular-nums w-16 text-right" style={{color:P.muted}}>{n.rssi} dBm</span>{connected===n.ssid?<Check className="h-4 w-4" style={{color:P.resolved}}/>:<ChevronRight className="h-4 w-4" style={{color:P.muted}}/>}</button>})}</div>
    {selected&&<div className="rounded-lg p-3 flex items-center justify-between gap-3" style={{background:P.card,border:`1px solid ${P.border}`}}><div><div className="text-[13px] font-semibold">{selected}</div><p className="text-[11px]" style={{color:P.muted}}>{th?'ไม่ต้องใช้รหัสผ่านจริงในตัวอย่าง':'Demo connection only — no real password required.'}</p></div><div className="flex gap-2"><ActionButton label={th?'ยกเลิก':'Cancel'} onClick={()=>setSelected(null)}/><button className="rounded-lg px-3 py-2 text-[12px] font-semibold" style={{background:'#0891b2',color:'#fff'}} onClick={()=>join(selected)}>{th?'เชื่อมต่อจำลอง':'Connect (demo)'}</button></div></div>}
    {message&&<div role="status" className="text-[11px]" style={{color:P.resolved}}>{message}</div>}
  </div>
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ background: 'rgba(255,255,255,0.07)', color: P.muted }}>
      {children}
    </span>
  )
}

function Row({ label, hint, device, children }: {
  label: string; hint?: string; device?: boolean; children: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 py-2.5" style={{ borderBottom: `1px solid ${P.border}` }}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">{label}</span>
          {device && <Chip>device</Chip>}
        </div>
        {hint && <div className="text-[11px] mt-0.5" style={{ color: P.muted }}>{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className="rounded-full flex items-center flex-shrink-0"
      style={{ width: 52, height: 30, padding: 3, background: on ? 'var(--brand-primary, #0891b2)' : 'rgba(255,255,255,0.12)' }}
    >
      <span className="rounded-full bg-white"
            style={{ width: 24, height: 24, transform: on ? 'translateX(22px)' : 'translateX(0)' }} />
    </button>
  )
}

function Segmented<T extends string | number>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-lg overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
      {options.map(o => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={cn('text-[12px] font-medium', value === o.value && 'font-semibold')}
          style={{
            minWidth: 56, height: 34, padding: '0 10px',
            background: value === o.value ? 'var(--brand-primary, #0891b2)' : 'transparent',
            color: value === o.value ? '#fff' : P.muted,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Slider({ value, min, max, suffix, onChange }: {
  value: number; min: number; max: number; suffix?: string; onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-3" style={{ width: 240 }}>
      <input
        type="range" min={min} max={max} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 h-9 accent-[var(--brand-primary,#0891b2)]"
      />
      <span className="text-[12px] font-semibold tabular-nums w-12 text-right flex-shrink-0">
        {value}{suffix}
      </span>
    </div>
  )
}

function Field({ value, placeholder, onChange }: {
  value: string; placeholder?: string; onChange: (v: string) => void
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className="rounded-lg px-3 text-[13px] outline-none"
      style={{ width: 220, height: 36, background: 'rgba(255,255,255,0.06)', border: `1px solid ${P.border}`, color: P.text }}
    />
  )
}

function TimeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="time" value={value} onChange={e => onChange(e.target.value)}
      className="rounded-lg px-2 text-[13px] outline-none tabular-nums"
      style={{ width: 104, height: 36, background: 'rgba(255,255,255,0.06)', border: `1px solid ${P.border}`, color: P.text }}
    />
  )
}

// City picker. A native <select> is out on the panel: its popup is drawn by the
// OS, not the page, so on a kiosk/embedded browser it can open off-screen or not
// at all. Instead the button opens CityPicker, a full-panel list grouped by
// country with finger-sized buttons.
function CityButton({ value, onOpen, th }: { value: string; onOpen: () => void; th: boolean }) {
  const c = CITY_OPTIONS.find(o => o.key === value)
  return (
    <button
      onClick={onOpen}
      className="rounded-lg px-3 text-[13px] flex items-center justify-between gap-2 active:brightness-150"
      style={{ width: 240, height: 40, background: 'rgba(255,255,255,0.06)', border: `1px solid ${P.border}`, color: P.text }}
    >
      <span className="truncate">
        {c ? (th ? c.nameTh : c.name) : value}
        {c && <span style={{ color: P.muted }}> · {th ? c.countryTh : c.country}</span>}
      </span>
      <ChevronRight className="h-4 w-4 flex-shrink-0" style={{ color: P.muted }} />
    </button>
  )
}

function CityPicker({ title, value, onPick, onClose, th }: {
  title: string; value: string; onPick: (v: string) => void; onClose: () => void; th: boolean
}) {
  const groups: { country: string; countryTh: string; cities: typeof CITY_OPTIONS }[] = []
  for (const c of CITY_OPTIONS) {
    const g = groups.find(x => x.country === c.country)
    if (g) g.cities.push(c)
    else groups.push({ country: c.country, countryTh: c.countryTh, cities: [c] })
  }
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center p-6"
         style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="flex flex-col rounded-xl overflow-hidden w-full h-full"
           style={{ maxWidth: 760, background: P.card, border: `1px solid ${P.border}` }}
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
             style={{ borderBottom: `1px solid ${P.border}` }}>
          <span className="text-[15px] font-bold">{title}</span>
          <button onClick={onClose} aria-label={th ? 'ปิด' : 'Close'}
                  className="w-10 h-10 rounded-lg flex items-center justify-center active:brightness-150"
                  style={{ background: 'rgba(255,255,255,0.07)' }}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {groups.map(g => (
            <div key={g.country}>
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: P.muted }}>
                {th ? g.countryTh : g.country}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {g.cities.map(c => {
                  const on = c.key === value
                  return (
                    <button key={c.key} onClick={() => { onPick(c.key); onClose() }}
                            className="rounded-lg px-3 text-[13px] text-left active:brightness-150"
                            style={{
                              height: 44,
                              background: on ? 'var(--brand-primary, #0891b2)' : 'rgba(255,255,255,0.06)',
                              border: `1px solid ${on ? 'transparent' : P.border}`,
                              color: on ? '#fff' : P.text, fontWeight: on ? 600 : 400,
                            }}>
                      {th ? c.nameTh : c.name}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ActionButton({ label, tone = 'normal', onClick }: {
  label: string; tone?: 'normal' | 'danger'; onClick: () => void
}) {
  const danger = tone === 'danger'
  return (
    <button
      onClick={onClick}
      className="rounded-lg px-4 text-[12px] font-semibold active:brightness-150"
      style={{
        height: 36,
        background: danger ? 'rgba(239,68,68,0.14)' : 'rgba(255,255,255,0.08)',
        color: danger ? P.critical : P.text,
        border: `1px solid ${danger ? 'rgba(239,68,68,0.35)' : P.border}`,
      }}
    >
      {label}
    </button>
  )
}

function ReadOnly({ children }: { children: ReactNode }) {
  return <span className="text-[12px] tabular-nums" style={{ color: P.muted }}>{children}</span>
}

export function DisplaySettings({ settings, onChange, onClose, lang, onActivity }: {
  settings: PanelSettings
  onChange: (next: PanelSettings) => void
  onClose: () => void
  lang: string
  /** Any touch or keystroke in here restarts the panel's return-to-board timer. */
  onActivity?: () => void
}) {
  const [section, setSection] = useState<SectionId>('display')
  const { activeCompany } = useCompany()
  const companyTitle = activeCompany?.org_title || activeCompany?.name || ''
  const [note, setNote] = useState<string | null>(null)
  const [cityPick, setCityPick] = useState<{ title: string; value: string; apply: (v: string) => void } | null>(null)
  const th = lang === 'th'
  const set = <K extends keyof PanelSettings>(k: K, v: PanelSettings[K]) => onChange({ ...settings, [k]: v })

  // Demo-only actions acknowledge themselves instead of pretending to work.
  function demoAction(msg: string) {
    setNote(msg)
    window.setTimeout(() => setNote(null), 2600)
  }

  const sections: { id: SectionId; label: string; icon: typeof Monitor }[] = [
    { id: 'display', label: th ? 'หน้าจอ' : 'Display',  icon: Monitor },
    { id: 'dashboards', label: th ? 'แดชบอร์ด' : 'Dashboards', icon: LayoutDashboard },
    { id: 'clock',   label: th ? 'นาฬิกาโลก' : 'World clock', icon: Clock },
    { id: 'data',    label: th ? 'ข้อมูล' : 'Data',      icon: RefreshCw },
    { id: 'network', label: th ? 'เครือข่าย' : 'Network', icon: Wifi },
    { id: 'device',  label: th ? 'อุปกรณ์' : 'Device',   icon: Cpu },
    { id: 'about',   label: th ? 'เกี่ยวกับ' : 'About',   icon: Info },
  ]

  return (
    <div className="absolute flex flex-col rounded-xl overflow-hidden"
         style={{ inset: 16, background: P.bg, border: `1px solid ${P.border}` }}
         onPointerDown={onActivity} onKeyDown={onActivity}>

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0"
           style={{ borderBottom: `1px solid ${P.border}` }}>
        <span className="text-[17px] font-bold">{th ? 'ตั้งค่าระบบ' : 'System Settings'}</span>
        <div className="flex items-center gap-3">
          {note && (
            <span className="text-[11px] px-2.5 py-1 rounded"
                  style={{ background: 'rgba(34,197,94,0.14)', color: P.resolved }}>
              {note}
            </span>
          )}
          <button
            onClick={onClose}
            aria-label={th ? 'ปิด' : 'Close'}
            className="w-10 h-10 rounded-lg flex items-center justify-center active:brightness-150"
            style={{ background: 'rgba(255,255,255,0.07)' }}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Tab rail */}
        <div className="flex-shrink-0 py-2 pl-2 pr-1 space-y-1" style={{ width: 164, borderRight: `1px solid ${P.border}` }}>
          {sections.map(s => {
            const active = s.id === section
            const Icon = s.icon
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className="w-full flex items-center gap-2.5 px-3 rounded-lg text-left active:brightness-150"
                style={{
                  height: 44,
                  background: active ? 'var(--brand-primary, #0891b2)' : 'transparent',
                  color: active ? '#fff' : P.muted,
                }}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="text-[13px] font-medium truncate">{s.label}</span>
              </button>
            )
          })}
        </div>

        {/* Controls */}
        <div className="flex-1 min-w-0 overflow-y-auto px-4 py-1" style={{ scrollbarWidth: 'thin' }}>
          {section === 'display' && (
            <>
              <Row label={th ? 'ความสว่าง' : 'Brightness'} device
                   hint={th ? 'PWM ของไฟหน้าจอ' : 'Backlight PWM duty cycle'}>
                <Slider value={settings.brightness} min={10} max={100} suffix="%"
                        onChange={v => set('brightness', v)} />
              </Row>
              <Row label={th ? 'หรี่จอกลางคืน' : 'Night dim'} device
                   hint={th ? 'ลดความสว่างอัตโนมัติตามเวลา' : 'Drop the backlight between set hours'}>
                <Toggle on={settings.nightDim} onChange={v => set('nightDim', v)} />
              </Row>
              {settings.nightDim && (
                <>
                  <Row label={th ? 'ช่วงเวลา' : 'Night hours'} hint={th ? 'เวลาประเทศไทย' : 'Bangkok time'}>
                    <div className="flex items-center gap-2">
                      <TimeField value={settings.nightFrom} onChange={v => set('nightFrom', v)} />
                      <span className="text-[12px]" style={{ color: P.muted }}>→</span>
                      <TimeField value={settings.nightTo} onChange={v => set('nightTo', v)} />
                    </div>
                  </Row>
                  <Row label={th ? 'ความสว่างกลางคืน' : 'Night brightness'}>
                    <Slider value={settings.nightLevel} min={10} max={100} suffix="%"
                            onChange={v => set('nightLevel', v)} />
                  </Row>
                </>
              )}
              <Row label={th ? 'การหมุนจอ' : 'Orientation'} device
                   hint={th ? 'สำหรับการติดตั้งกลับหัว' : 'For upside-down mounting'}>
                <Segmented
                  value={settings.orientation}
                  options={[{ value: 0, label: th ? 'ปกติ' : 'Normal' }, { value: 180, label: '180°' }]}
                  onChange={v => set('orientation', v as 0 | 180)}
                />
              </Row>
            </>
          )}

          {section === 'dashboards' && (
            <>
              <Row label={th ? 'สลับหน้าจออัตโนมัติ' : 'Rotate boards'} hint={th ? 'หยุดระหว่างเปิดการตั้งค่า' : 'Pause rotation while settings or a detail view is open'}>
                <Toggle on={settings.rotate} onChange={v => set('rotate', v)} />
              </Row>
              <Row label={th ? 'หน้าเริ่มต้น' : 'Default dashboard'} hint={th ? 'หน้าแรกเมื่อเปิดจอ' : 'First page when the display starts'}>
                <select aria-label="Default dashboard" value={settings.startupBoard} onChange={e=>set('startupBoard',e.target.value as BoardId)} className="rounded-lg px-3 py-2 text-[13px]" style={{background:P.card,color:P.text,border:`1px solid ${P.border}`}}>
                  {BOARD_IDS.filter(id=>settings.enabledBoards.includes(id)).map(id=><option key={id} value={id}>{BOARD_LABELS[id]}</option>)}
                </select>
              </Row>
              <div className="grid grid-cols-[1fr_70px_135px] gap-3 items-center py-2 text-[11px] font-semibold uppercase" style={{color:P.muted}}><span>Dashboard</span><span className="text-center">Enabled</span><span className="text-center">Rotation time</span></div>
              {BOARD_IDS.map(id=>{
                const enabled=settings.enabledBoards.includes(id)
                return <div key={id} className="grid grid-cols-[1fr_70px_135px] gap-3 items-center py-2" style={{borderBottom:`1px solid ${P.border}`}}>
                  <span className="text-[13px] font-medium">{BOARD_LABELS[id]}</span>
                  <div className="flex justify-center"><button role="switch" aria-label={`Enable ${BOARD_LABELS[id]}`} aria-checked={enabled} disabled={enabled&&settings.enabledBoards.length===1} onClick={()=>{const boards=enabled?settings.enabledBoards.filter(x=>x!==id):BOARD_IDS.filter(x=>x===id||settings.enabledBoards.includes(x));onChange({...settings,enabledBoards:boards,startupBoard:boards.includes(settings.startupBoard)?settings.startupBoard:boards[0]})}} className="rounded-full flex items-center disabled:opacity-50" style={{width:52,height:30,padding:3,background:enabled?'var(--brand-primary, #0891b2)':'rgba(255,255,255,.12)'}}><span className="rounded-full bg-white" style={{width:24,height:24,transform:enabled?'translateX(22px)':'translateX(0)'}}/></button></div>
                  <select aria-label={`${BOARD_LABELS[id]} rotation time`} disabled={!enabled} value={settings.boardDurations[id]} onChange={e=>set('boardDurations',{...settings.boardDurations,[id]:Number(e.target.value)})} className="rounded-lg px-2 py-2 text-[12px] disabled:opacity-40" style={{background:P.card,color:P.text,border:`1px solid ${P.border}`}}>{[...new Set([15,30,60,120,300,settings.boardDurations[id]])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n<60?`${n} sec`:`${n/60} min`}</option>)}</select>
                </div>
              })}
              <Row label={th ? 'แจ้งเตือนข้อมูลเก่า' : 'Report freshness alerts'} hint={th?'เตือนเมื่อรายงานเก่า 1 วันหรือมากกว่า':'Warn when a resort or availability report is 1+ days old'}><Toggle on={settings.freshnessAlerts} onChange={v=>set('freshnessAlerts',v)} /></Row>
              <p className="text-[11px] mt-2" style={{color:P.muted}}>{th?'ต้องเปิดอย่างน้อยหนึ่งหน้า':'At least one dashboard must stay enabled. Settings are saved on this device.'}</p>
            </>
          )}

          {section === 'clock' && (
            <>
              {[0, 1, 2].map(i => (
                <Row key={i} label={`${th ? 'นาฬิกา' : 'Clock'} ${i + 1}`}
                     hint={i === 0 ? (th ? 'เวลาและอุณหภูมิของแต่ละเมือง' : 'Time and temperature for each city') : undefined}>
                  <CityButton th={th} value={settings.clocks[i] ?? 'chiangmai'}
                              onOpen={() => setCityPick({
                                title: `${th ? 'นาฬิกา' : 'Clock'} ${i + 1}`,
                                value: settings.clocks[i] ?? 'chiangmai',
                                apply: v => set('clocks', [0, 1, 2].map(j => (j === i ? v : settings.clocks[j] ?? 'chiangmai'))),
                              })} />
                </Row>
              ))}
              <Row label={th ? 'ตำแหน่งวัดคุณภาพอากาศ' : 'Air quality location'}
                   hint={th ? 'สถานี Air4Thai ที่ใกล้ที่สุด (ในประเทศไทย)' : 'Nearest Air4Thai station (in Thailand)'}>
                <CityButton th={th} value={settings.airHome}
                            onOpen={() => setCityPick({
                              title: th ? 'ตำแหน่งวัดคุณภาพอากาศ' : 'Air quality location',
                              value: settings.airHome,
                              apply: v => set('airHome', v),
                            })} />
              </Row>
            </>
          )}

          {section === 'data' && (
            <>
              <Row label={th ? 'รอบดึงข้อมูล' : 'Refresh interval'}
                   hint={th ? 'ความถี่ในการดึงเคสใหม่' : 'How often the board re-reads cases'}>
                <Segmented
                  value={settings.refreshSecs}
                  options={[
                    { value: 15,  label: '15s' },
                    { value: 30,  label: '30s' },
                    { value: 60,  label: '1m' },
                    { value: 300, label: '5m' },
                  ]}
                  onChange={v => set('refreshSecs', v as number)}
                />
              </Row>
              <Row label={th ? 'สัมผัสเพื่อดูรายละเอียด' : 'Touch drill-down'}
                   hint={th ? 'ปิดเพื่อให้เป็นจอแสดงผลอย่างเดียว' : 'Off makes the board display-only'}>
                <Toggle on={settings.touch} onChange={v => set('touch', v)} />
              </Row>
              <Row label={th ? 'กลับหน้าสรุปอัตโนมัติ' : 'Return to summary after'}
                   hint={th ? 'เมื่อไม่มีการสัมผัส' : 'Idle timeout on a drill-down'}>
                <Segmented
                  value={settings.idleSecs}
                  options={[
                    { value: 10,  label: '10s' },
                    { value: 30,  label: '30s' },
                    { value: 60,  label: '1m' },
                    { value: 120, label: '2m' },
                  ]}
                  onChange={v => set('idleSecs', v as number)}
                />
              </Row>
            </>
          )}

          {section === 'network' && <NetworkPreview th={th} />}

          {section === 'device' && (
            <>
              <Row label={th ? 'ชื่อบนจอ' : 'Board title'}
                   hint={th ? 'ชื่อที่แสดงบนหัวจอ เว้นว่างเพื่อใช้ชื่อบริษัท' : 'Shown in the header. Leave empty to use the company name.'}>
                <Field value={settings.boardTitle} placeholder={companyTitle}
                       onChange={v => set('boardTitle', v)} />
              </Row>
              <Row label={th ? 'ชื่ออุปกรณ์' : 'Device name'}
                   hint={th ? 'ใช้ระบุจอนี้' : 'Identifies this panel'}>
                <Field value={settings.deviceName} onChange={v => set('deviceName', v)} />
              </Row>
              <Row label={th ? 'ตำแหน่งติดตั้ง' : 'Location'}
                   hint={th ? 'เช่น ล็อบบี้, ครัว' : 'e.g. Lobby, Kitchen'}>
                <Field value={settings.location} placeholder={th ? 'ล็อบบี้' : 'Lobby'}
                       onChange={v => set('location', v)} />
              </Row>
              <Row label={th ? 'เสียงเตือนเคสวิกฤต' : 'Sound on critical case'} device
                   hint={th ? 'ต้องมีลำโพงต่อกับบอร์ด' : 'Needs a speaker on the board header'}>
                <Toggle on={settings.soundOnCritical} onChange={v => set('soundOnCritical', v)} />
              </Row>
              <Row label={th ? 'รีสตาร์ท' : 'Reboot'} device>
                <ActionButton label={th ? 'รีสตาร์ท' : 'Reboot'}
                              onClick={() => demoAction(th ? 'เดโม — ไม่มีการรีสตาร์ท' : 'Demo — nothing rebooted')} />
              </Row>
              <Row label={th ? 'ล้างค่าทั้งหมด' : 'Factory reset'} device
                   hint={th ? 'ลบการตั้งค่าและการจับคู่ทั้งหมด' : 'Clears settings and unpairs the device'}>
                <ActionButton tone="danger" label={th ? 'ล้างค่า' : 'Reset'}
                              onClick={() => demoAction(th ? 'เดโม — ไม่มีการล้างค่า' : 'Demo — nothing cleared')} />
              </Row>
            </>
          )}

          {section === 'about' && (
            <>
              <Row label={th ? 'รุ่น' : 'Model'} device><ReadOnly>{DEMO_DEVICE.model}</ReadOnly></Row>
              <Row label="SoC" device><ReadOnly>{DEMO_DEVICE.soc}</ReadOnly></Row>
              <Row label={th ? 'ไร้สาย' : 'Radio'} device><ReadOnly>{DEMO_DEVICE.radio}</ReadOnly></Row>
              <Row label={th ? 'เฟิร์มแวร์' : 'Firmware'} device><ReadOnly>{DEMO_DEVICE.firmware}</ReadOnly></Row>
              <Row label="PSRAM" device><ReadOnly>{DEMO_DEVICE.psram}</ReadOnly></Row>
              <Row label="Flash" device><ReadOnly>{DEMO_DEVICE.flash}</ReadOnly></Row>
              <Row label={th ? 'เวลาทำงาน' : 'Uptime'} device><ReadOnly>{DEMO_DEVICE.uptime}</ReadOnly></Row>
              <Row label={th ? 'อุณหภูมิ' : 'Temperature'} device><ReadOnly>{DEMO_DEVICE.temp}</ReadOnly></Row>
              <Row label={th ? 'อัปเดตเฟิร์มแวร์' : 'Firmware update'} device
                   hint={th ? 'ตรวจสอบเวอร์ชันใหม่ (OTA)' : 'Check for a new build over the air'}>
                <ActionButton label={th ? 'ตรวจสอบ' : 'Check'}
                              onClick={() => demoAction(th ? 'เดโม — ไม่มีเซิร์ฟเวอร์ OTA' : 'Demo — no OTA server')} />
              </Row>
              <div className="py-3 text-[11px] leading-relaxed" style={{ color: P.muted }}>
                {th
                  ? 'ค่าที่มีป้าย "device" คือค่าที่เฟิร์มแวร์เป็นผู้ควบคุมบนฮาร์ดแวร์จริง ในเดโมนี้เป็นเพียงตัวอย่าง'
                  : 'Rows tagged "device" are the ones firmware would own on real hardware — here they are demo values. Everything untagged already drives this board.'}
              </div>
            </>
          )}
        </div>
      </div>
      {cityPick && (
        <CityPicker th={th} title={cityPick.title} value={cityPick.value}
                    onPick={cityPick.apply} onClose={() => setCityPick(null)} />
      )}
    </div>
  )
}
