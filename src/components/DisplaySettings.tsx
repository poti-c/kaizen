import { useState, type ReactNode } from 'react'
import { X, Monitor, RefreshCw, Wifi, Cpu, Info } from 'lucide-react'
import { PANEL as P, type PanelSettings } from '@/lib/panelTheme'
import { cn } from '@/lib/utils'

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

type SectionId = 'display' | 'data' | 'network' | 'device' | 'about'

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
      className="rounded-full transition-colors flex items-center flex-shrink-0"
      style={{ width: 52, height: 30, padding: 3, background: on ? 'var(--brand-primary, #0891b2)' : 'rgba(255,255,255,0.12)' }}
    >
      <span className="rounded-full bg-white transition-transform"
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
          className={cn('text-[12px] font-medium transition-colors', value === o.value && 'font-semibold')}
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

function ActionButton({ label, tone = 'normal', onClick }: {
  label: string; tone?: 'normal' | 'danger'; onClick: () => void
}) {
  const danger = tone === 'danger'
  return (
    <button
      onClick={onClick}
      className="rounded-lg px-4 text-[12px] font-semibold active:brightness-150 transition"
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
  const [note, setNote] = useState<string | null>(null)
  const th = lang === 'th'
  const set = <K extends keyof PanelSettings>(k: K, v: PanelSettings[K]) => onChange({ ...settings, [k]: v })

  // Demo-only actions acknowledge themselves instead of pretending to work.
  function demoAction(msg: string) {
    setNote(msg)
    window.setTimeout(() => setNote(null), 2600)
  }

  const sections: { id: SectionId; label: string; icon: typeof Monitor }[] = [
    { id: 'display', label: th ? 'หน้าจอ' : 'Display',  icon: Monitor },
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
            className="w-10 h-10 rounded-lg flex items-center justify-center active:brightness-150 transition"
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
                className="w-full flex items-center gap-2.5 px-3 rounded-lg text-left transition active:brightness-150"
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

          {section === 'network' && (
            <>
              <Row label={th ? 'การเชื่อมต่อ' : 'Connection'} device
                   hint={th ? 'Wi-Fi ทำงานผ่าน ESP32-C6' : 'Wi-Fi runs on the companion ESP32-C6'}>
                <ReadOnly>Wi-Fi · {DEMO_DEVICE.ssid}</ReadOnly>
              </Row>
              <Row label={th ? 'ความแรงสัญญาณ' : 'Signal'} device><ReadOnly>{DEMO_DEVICE.rssi}</ReadOnly></Row>
              <Row label="IP" device><ReadOnly>{DEMO_DEVICE.ip}</ReadOnly></Row>
              <Row label="MAC" device><ReadOnly>{DEMO_DEVICE.mac}</ReadOnly></Row>
              <Row label={th ? 'เชื่อมต่อใหม่' : 'Reconnect'} device
                   hint={th ? 'รีสตาร์ทการเชื่อมต่อเครือข่าย' : 'Restart the network link'}>
                <ActionButton label={th ? 'เชื่อมต่อใหม่' : 'Reconnect'}
                              onClick={() => demoAction(th ? 'เดโม — ไม่มีการเชื่อมต่อจริง' : 'Demo — no radio to restart')} />
              </Row>
            </>
          )}

          {section === 'device' && (
            <>
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
    </div>
  )
}
