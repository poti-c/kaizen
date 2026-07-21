// Preventive Maintenance shared helpers (frequency + asset health status).
import { bangkokDate } from '@/lib/utils'

export type FreqUnit = 'day' | 'week' | 'month' | 'year'

export const FREQUENCIES: { label: string; label_th: string; unit: FreqUnit; interval: number }[] = [
  { label: 'Daily', label_th: 'รายวัน', unit: 'day', interval: 1 },
  { label: 'Weekly', label_th: 'รายสัปดาห์', unit: 'week', interval: 1 },
  { label: 'Every 2 weeks', label_th: 'ทุก 2 สัปดาห์', unit: 'week', interval: 2 },
  { label: 'Monthly', label_th: 'รายเดือน', unit: 'month', interval: 1 },
  { label: 'Every 2 months', label_th: 'ทุก 2 เดือน', unit: 'month', interval: 2 },
  { label: 'Quarterly', label_th: 'ทุก 3 เดือน', unit: 'month', interval: 3 },
  { label: 'Every 6 months', label_th: 'ทุก 6 เดือน', unit: 'month', interval: 6 },
  { label: 'Annual', label_th: 'รายปี', unit: 'year', interval: 1 },
]

const UNIT_TH: Record<FreqUnit, string> = { day: 'วัน', week: 'สัปดาห์', month: 'เดือน', year: 'ปี' }

// An asset's full set of responsible departments. Assets may have more than one
// (e.g. Front Office + Engineering). Falls back to the legacy single `department`
// column when the array is empty/unset, so old data keeps working.
export function assetDepartments(
  a: { departments?: string[] | null; department?: string | null } | null | undefined,
): string[] {
  if (!a) return []
  if (a.departments && a.departments.length) return a.departments.filter(Boolean)
  return a.department ? [a.department] : []
}

/** Frequency label in the given UI language (handles custom intervals too). */
export function freqLabel(unit: FreqUnit, interval: number, lang?: string): string {
  const match = FREQUENCIES.find((f) => f.unit === unit && f.interval === interval)
  if (match) return lang === 'th' ? match.label_th : match.label
  return lang === 'th'
    ? `ทุก ${interval} ${UNIT_TH[unit]}`
    : `Every ${interval} ${unit}${interval === 1 ? '' : 's'}`
}

// Add a frequency interval to a YYYY-MM-DD date, returning YYYY-MM-DD.
// Month/year steps clamp to the end of the target month so e.g. Jan 31 + 1 month = Feb 28/29
// (instead of JS's overflow to Mar 2/3) and Feb 29 + 1 year = Feb 28.
export function addInterval(dateStr: string, unit: FreqUnit, interval: number): string {
  const parts = dateStr.split('-').map(Number)
  let y = parts[0], m = parts[1]
  const day = parts[2]
  if (unit === 'day' || unit === 'week') {
    const d = new Date(Date.UTC(y, m - 1, unit === 'week' ? day + interval * 7 : day + interval))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }
  // month/year: clamp to end of target month using pure numeric arithmetic (no local-TZ Date methods)
  const months = unit === 'year' ? interval * 12 : interval
  m += months
  while (m > 12) { m -= 12; y++ }
  while (m < 1) { m += 12; y-- }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const today = new Date(bangkokDate() + 'T00:00:00+07:00')
  const end = new Date(dateStr + 'T00:00:00+07:00')
  return Math.ceil((end.getTime() - today.getTime()) / 86400000)
}

export type AssetStatus = 'good' | 'due_soon' | 'overdue' | 'unscheduled' | 'inactive'

export function assetStatus(
  next: string | null,
  isActive: boolean,
  dueSoonDays = 7,
): AssetStatus {
  if (!isActive) return 'inactive'
  if (!next) return 'unscheduled'
  const d = daysUntil(next)
  if (d === null) return 'unscheduled'
  if (d < 0) return 'overdue'
  if (d <= dueSoonDays) return 'due_soon'
  return 'good'
}

export const STATUS_META: Record<AssetStatus, { label: string; pill: string; dot: string }> = {
  good:        { label: 'Good',        pill: 'bg-green-100 text-green-700 border-green-200', dot: 'bg-green-500' },
  due_soon:    { label: 'Due soon',    pill: 'bg-amber-100 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  overdue:     { label: 'Overdue',     pill: 'bg-red-100 text-red-700 border-red-200', dot: 'bg-red-500' },
  unscheduled: { label: 'Not scheduled', pill: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'bg-slate-400' },
  inactive:    { label: 'Inactive',    pill: 'bg-slate-100 text-slate-500 border-slate-200', dot: 'bg-slate-300' },
}
