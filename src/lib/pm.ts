// Preventive Maintenance shared helpers (frequency + asset health status).

export type FreqUnit = 'day' | 'week' | 'month' | 'year'

export const FREQUENCIES: { label: string; unit: FreqUnit; interval: number }[] = [
  { label: 'Daily', unit: 'day', interval: 1 },
  { label: 'Weekly', unit: 'week', interval: 1 },
  { label: 'Every 2 weeks', unit: 'week', interval: 2 },
  { label: 'Monthly', unit: 'month', interval: 1 },
  { label: 'Every 2 months', unit: 'month', interval: 2 },
  { label: 'Quarterly', unit: 'month', interval: 3 },
  { label: 'Every 6 months', unit: 'month', interval: 6 },
  { label: 'Annual', unit: 'year', interval: 1 },
]

export function freqLabel(unit: FreqUnit, interval: number): string {
  const match = FREQUENCIES.find((f) => f.unit === unit && f.interval === interval)
  if (match) return match.label
  return `Every ${interval} ${unit}${interval === 1 ? '' : 's'}`
}

// Add a frequency interval to a YYYY-MM-DD date, returning YYYY-MM-DD.
export function addInterval(dateStr: string, unit: FreqUnit, interval: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  if (unit === 'day') d.setDate(d.getDate() + interval)
  else if (unit === 'week') d.setDate(d.getDate() + interval * 7)
  else if (unit === 'month') d.setMonth(d.getMonth() + interval)
  else if (unit === 'year') d.setFullYear(d.getFullYear() + interval)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const end = new Date(dateStr + 'T00:00:00')
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
