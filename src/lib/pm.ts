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
  const d = new Date(dateStr + 'T00:00:00')
  if (unit === 'day') d.setDate(d.getDate() + interval)
  else if (unit === 'week') d.setDate(d.getDate() + interval * 7)
  else if (unit === 'month' || unit === 'year') {
    const months = unit === 'year' ? interval * 12 : interval
    const day = d.getDate()
    d.setDate(1)
    d.setMonth(d.getMonth() + months)
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    d.setDate(Math.min(day, lastDay))
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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
