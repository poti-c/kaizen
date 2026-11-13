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

export interface PanelSettings {
  // Display
  brightness: number        // 10–100, backlight duty on hardware
  nightDim: boolean
  nightFrom: string         // 'HH:MM', Bangkok time
  nightTo: string
  nightLevel: number        // 10–100
  orientation: 0 | 180
  // Data
  refreshSecs: number
  idleSecs: number
  touch: boolean
  // Device
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
  refreshSecs: 60,
  idleSecs: 30,
  touch: true,
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
    return { ...DEFAULT_PANEL_SETTINGS, ...JSON.parse(raw) as Partial<PanelSettings> }
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
