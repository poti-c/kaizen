// Shared between the wall-panel board (DisplayPage) and its settings screen.
//
// These settings are per-DEVICE, not per-user: a panel in the lobby and a panel
// in the kitchen want different brightness, different night hours and possibly
// different names, while both are signed in as the same display account. So
// they live in localStorage on the device and are never written back to the
// profile — the same reason /display does not call setLang.
//
// On an ESP32 build the equivalent store is NVS, and the items marked `device`
// in the settings screen are the ones that would be handled by firmware rather
// than by this page.

export const PANEL = {
  bg: '#0b1220',
  card: '#141d2e',
  border: 'rgba(255,255,255,0.08)',
  text: '#e8edf3',
  muted: '#8b98ab',
  open: '#f97316',
  inProgress: '#3b82f6',
  pending: '#f59e0b',
  resolved: '#22c55e',
  reopened: '#ef4444',
  critical: '#ef4444',
}

export const BOARD_IDS = ['kaizen', 'hotel', 'availability', 'clock'] as const
export type BoardId = typeof BOARD_IDS[number]
export const BOARD_LABELS: Record<BoardId, string> = { kaizen: 'Kaizen System', hotel: 'Resort Report', availability: 'Room Availability', clock: 'World Clock' }
export function reportFreshness(date: string, now = new Date()) {
  const day = (d: Date) => { const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Bangkok',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(d); const get=(t:string)=>Number(parts.find(p=>p.type===t)?.value);return Date.UTC(get('year'),get('month')-1,get('day')) }
  const age = Math.max(0, Math.round((day(now)-day(new Date(date)))/86400000))
  return age >= 2 ? {label:'Attention required',th:'ต้องตรวจสอบ',color:PANEL.critical} : age === 1 ? {label:'Outdated',th:'ข้อมูลเก่า',color:PANEL.pending} : {label:'Up to date',th:'ข้อมูลล่าสุด',color:PANEL.resolved}
}

export interface PanelSettings {
  // Display
  brightness: number        // 10–100, backlight duty on hardware
  nightDim: boolean
  nightFrom: string         // 'HH:MM', Bangkok time
  nightTo: string
  nightLevel: number        // 10–100
  orientation: 0 | 180
  /** Cycle through the boards on the bottom row (Kaizen → Hotel → …). */
  rotate: boolean
  rotateSecs: number        // legacy rotation default
  enabledBoards: BoardId[]
  startupBoard: BoardId
  boardDurations: Record<BoardId, number>
  freshnessAlerts: boolean
  /** World Clock board: three city keys (src/lib/worldClock.ts) and where air quality is read. */
  clocks: string[]
  airHome: string
  // Data
  refreshSecs: number
  idleSecs: number
  touch: boolean
  // Device
  /** Name in the board's header. Empty = the company's display title. */
  boardTitle: string
  deviceName: string
  location: string
  soundOnCritical: boolean
}

export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  brightness: 100,
  nightDim: false,
  nightFrom: '22:00',
  nightTo: '06:00',
  nightLevel: 35,
  orientation: 0,
  rotate: false,
  rotateSecs: 30,
  enabledBoards: [...BOARD_IDS],
  startupBoard: 'kaizen',
  boardDurations: { kaizen:30, hotel:30, availability:30, clock:15 },
  freshnessAlerts: true,
  clocks: ['chiangmai', 'tokyo', 'taipei'],
  airHome: 'chiangmai',
  refreshSecs: 60,
  idleSecs: 30,
  touch: true,
  boardTitle: '',
  deviceName: 'Panel 1',
  location: '',
  soundOnCritical: false,
}

const KEY = 'kaizen-panel-settings'

export function loadPanelSettings(): PanelSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PANEL_SETTINGS
    // Merge over the defaults so a settings file written by an older build
    // (missing keys) still produces a complete object.
    const saved = JSON.parse(raw) as Partial<PanelSettings>
    const enabled = BOARD_IDS.filter(id => saved.enabledBoards?.includes(id))
    const enabledBoards = enabled.length ? enabled : [...BOARD_IDS]
    const startupBoard = saved.startupBoard && enabledBoards.includes(saved.startupBoard) ? saved.startupBoard : enabledBoards[0]
    const boardDurations = Object.fromEntries(BOARD_IDS.map(id => [id, Math.min(300, Math.max(15, Number(saved.boardDurations?.[id] ?? saved.rotateSecs ?? DEFAULT_PANEL_SETTINGS.boardDurations[id]) || 30))])) as Record<BoardId, number>
    return { ...DEFAULT_PANEL_SETTINGS, ...saved, enabledBoards, startupBoard, boardDurations }
  } catch {
    return DEFAULT_PANEL_SETTINGS
  }
}

export function savePanelSettings(s: PanelSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode, ignore */ }
}

// 'HH:MM' string compare, handling a window that crosses midnight (22:00→06:00).
export function inWindow(nowHHMM: string, from: string, to: string): boolean {
  if (from === to) return false
  return from < to
    ? nowHHMM >= from && nowHHMM < to
    : nowHHMM >= from || nowHHMM < to
}
