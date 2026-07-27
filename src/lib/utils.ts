import { useCallback, useRef, useState, useEffect } from 'react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { formatDistanceToNow, differenceInSeconds, differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns'
import { th } from 'date-fns/locale'
import type { CaseStatus, CasePriority, Department, KaizenCase } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// HS-BUG-02: this had no locale parameter at all, so notification timestamps
// ("5 minutes ago") were always English regardless of the language switcher —
// the only English left on an otherwise fully-translated notification list.
export function formatRelativeTime(date: string | Date, lang?: string) {
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: lang === 'th' ? th : undefined })
}

// ── Package feature authorities ──────────────────────────────────────────────
// A company's package stores which capabilities are unlocked as a { key: bool }
// map (denormalised from kaizen_products onto the company row). Returns true
// when the feature is granted. Fail-open when the map is empty/unconfigured so
// existing installs aren't accidentally locked out.
export type FeatureKey =
  | 'recurring_detection'
  | 'performance_analytics'
  | 'translation'
  | 'activity_log'
  | 'custom_theme'
  | 'priority_support'

export function companyHasFeature(
  company: { features?: Record<string, boolean> | null } | null | undefined,
  key: FeatureKey,
): boolean {
  const f = company?.features
  if (!f || typeof f !== 'object' || Object.keys(f).length === 0) return true
  return f[key] === true
}

// ── Subscription / trial status ──────────────────────────────────────────────
// Starter (plan === 'trial') runs for TRIAL_DAYS from created_at; paid plans use
// the denormalised subscription_end. End is unknown (null) for paid plans not yet
// activated — treated as NOT expired (fail-open) so nothing breaks.
export const TRIAL_DAYS = 30

type CompanyLike = {
  plan?: string | null
  created_at?: string | null
  subscription_end?: string | null
  addons?: Record<string, boolean | string> | null
}

function dayDiff(dateStr: string): number {
  const today = new Date(bangkokDate() + 'T00:00:00+07:00')
  const end = new Date(dateStr.length <= 10 ? dateStr + 'T00:00:00+07:00' : dateStr)
  return Math.ceil((end.getTime() - today.getTime()) / 86400000)
}

export interface SubInfo { isTrial: boolean; end: string | null; daysLeft: number | null; expired: boolean }

export function subscriptionInfo(company: CompanyLike | null | undefined): SubInfo {
  if (!company) return { isTrial: false, end: null, daysLeft: null, expired: false }
  if (company.subscription_end) {
    const d = dayDiff(company.subscription_end)
    return { isTrial: false, end: company.subscription_end, daysLeft: d, expired: d < 0 }
  }
  if (company.plan === 'trial' && company.created_at) {
    // Use Bangkok calendar date so the trial start/end matches what the hotel sees,
    // not the UTC date which drifts a day during 00:00–07:00 Bangkok time.
    const startIso = bangkokDate(new Date(String(company.created_at)))
    const start = new Date(startIso + 'T00:00:00+07:00')
    const end = new Date(start); end.setDate(start.getDate() + TRIAL_DAYS)
    const iso = bangkokDate(end)
    const d = dayDiff(iso)
    return { isTrial: true, end: iso, daysLeft: d, expired: d < 0 }
  }
  return { isTrial: false, end: null, daysLeft: null, expired: false }
}

// ── Purchased add-ons (entitlements) ─────────────────────────────────────────
// Add-ons are opt-in, stored in kaizen_companies.addons. A purchased add-on
// (key === true) is PAUSED while the subscription is expired. A self-serve trial
// (key + '_trial_until' >= today) is active independently for its window.
export type AddonKey = 'pms' | 'routine_roster'

export function companyHasAddon(company: CompanyLike | null | undefined, key: AddonKey): boolean {
  const a = company?.addons
  if (!a || typeof a !== 'object') return false
  if (a[key] === true) return !subscriptionInfo(company).expired // paused if lapsed
  const until = a[`${key}_trial_until`]
  if (typeof until === 'string') {
    const today = new Date(bangkokDate() + 'T00:00:00+07:00')
    return parseDateOnlyBkk(until) >= today
  }
  return false
}

// Is the given add-on currently running as a free trial (not purchased)?
export function addonTrialDaysLeft(company: CompanyLike | null | undefined, key: AddonKey): number | null {
  const until = company?.addons?.[`${key}_trial_until`]
  if (company?.addons?.[key] === true || typeof until !== 'string') return null
  const d = dayDiff(until)
  return d >= 0 ? d : null
}

// "Online" = active within the last 5 minutes.
export function isOnline(lastActiveAt?: string | null): boolean {
  if (!lastActiveAt) return false
  return Date.now() - new Date(lastActiveAt).getTime() < 5 * 60 * 1000
}

// Compact activity label for user lists. Pass `online` from real-time presence;
// falls back to the last-seen heuristic when presence is unknown.
export function activityLabel(lastActiveAt?: string | null, online?: boolean): string {
  if (online ?? isOnline(lastActiveAt)) return 'Online now'
  if (!lastActiveAt) return 'Never logged in'
  return `Active ${formatDistanceToNow(new Date(lastActiveAt), { addSuffix: true })}`
}

export function formatDateTime(date: string | Date) {
  return new Date(date).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok',
  })
}

export function formatDate(date: string | Date) {
  // TZ-stable like formatDateTime — date-fns' format() reads the system-local
  // clock, so a Bangkok timestamp near midnight rendered a different calendar
  // day for a viewer outside UTC+7.
  return new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok',
  })
}

export function formatDuration(startDate: string | Date, endDate?: string | Date): string {
  const start = new Date(startDate)
  const end = endDate ? new Date(endDate) : new Date()
  const seconds = differenceInSeconds(end, start)

  if (seconds < 60) return `${seconds}s`
  const minutes = differenceInMinutes(end, start)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = differenceInHours(end, start)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = differenceInDays(end, start)
  return `${days}d ${hours % 24}h`
}

export function getStatusColor(status: CaseStatus): string {
  switch (status) {
    case 'open': return 'bg-blue-100 text-blue-800 border-blue-200'
    case 'assigned': return 'bg-purple-100 text-purple-800 border-purple-200'
    case 'in_progress': return 'bg-yellow-100 text-yellow-800 border-yellow-200'
    case 'pending_manager_approval': return 'bg-orange-100 text-orange-800 border-orange-200'
    case 'pending_admin_approval': return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'closed': return 'bg-green-100 text-green-800 border-green-200'
    case 'reopened': return 'bg-red-100 text-red-800 border-red-200'
    default: return 'bg-gray-100 text-gray-800 border-gray-200'
  }
}

export function getPriorityColor(priority: CasePriority): string {
  switch (priority) {
    case 'low': return 'bg-gray-100 text-gray-600 border-gray-200'
    case 'medium': return 'bg-blue-100 text-blue-700 border-blue-200'
    case 'high': return 'bg-orange-100 text-orange-700 border-orange-200'
    case 'critical': return 'bg-red-100 text-red-700 border-red-200'
    default: return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

export function getDepartmentColor(dept: Department): string {
  const colors: Record<Department, string> = {
    top_management: 'bg-violet-100 text-violet-800',
    front_office: 'bg-blue-100 text-blue-800',
    sales_team: 'bg-green-100 text-green-800',
    house_keeping: 'bg-teal-100 text-teal-800',
    human_resource: 'bg-pink-100 text-pink-800',
    engineering_team: 'bg-orange-100 text-orange-800',
    restaurant: 'bg-yellow-100 text-yellow-800',
    kitchen: 'bg-red-100 text-red-800',
    accounting: 'bg-indigo-100 text-indigo-800',
  }
  return colors[dept] || 'bg-gray-100 text-gray-800'
}

export function generateCaseNumber(): string {
  const now = new Date()
  const bkkParts = bangkokDate(now).split('-')  // ['YYYY','MM','DD']
  const yyyy = bkkParts[0]
  const mm = bkkParts[1]
  const random = Math.floor(Math.random() * 9000) + 1000
  return `KZN-${yyyy}${mm}-${random}`
}

// Normalize a company code/slug the same way slugs are generated
export function normalizeCompanyCode(code: string): string {
  return code.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

// Normalize a staff username (must match the edge function exactly)
export function normalizeStaffUsername(username: string): string {
  return username.trim().toLowerCase().split(' ').filter(Boolean).join('.')
}

// Staff auth email is synthetic and scoped per company so usernames can repeat
// across companies, e.g. john@na-nirand.staff.kaizen.internal
export function staffEmail(username: string, companyCode: string): string {
  return `${normalizeStaffUsername(username)}@${normalizeCompanyCode(companyCode)}.staff.kaizen.internal`
}

export const DEPT_ABBR: Record<string, string> = {
  front_office:     'FO',
  sales_team:       'ST',
  house_keeping:    'HK',
  human_resource:   'HR',
  engineering_team: 'EN',
  restaurant:       'RE',
  kitchen:          'KT',
  accounting:       'AC',
  top_management:   'TM',
}

export function buildPhotoPath(caseNumber: string, department: string, index: number, ext: string, companyId?: string): string {
  const now = new Date()
  const bkkParts = bangkokDate(now).split('-')  // ['YYYY','MM','DD']
  const yyyy = bkkParts[0]
  const mm = bkkParts[1]
  const dd = bkkParts[2]
  const dept = DEPT_ABBR[department] ?? department.toUpperCase().slice(0, 2)
  const caseTag = caseNumber.replace(/-/g, '_')
  // PHOTO-ORPHAN-01: this legacy folder name (used whenever companyId isn't known yet)
  // contains literal spaces. getPublicUrl() encodeURIs the public URL (spaces -> %20),
  // but storage.objects.name keeps the raw decoded path — so the orphan-sweep SQL, which
  // compares photo_url against storage.objects.name with no decode step, never matched
  // these paths and treated every photo under it as orphaned garbage for deletion.
  // A space-free literal keeps both sides of that comparison identical.
  const folder = companyId ? `${companyId}/kaizen/${yyyy}-${mm}` : `na_nirand_kaizen/${yyyy}-${mm}`
  // PHOTO-COLLISION-01: index alone isn't unique across a component remount (e.g. a
  // draft-recovery reload resets photoIndexRef to 1), so a same-day re-upload could
  // collide with an already-uploaded photo's exact path and silently fail (Storage
  // rejects a duplicate key with no upsert). A short random suffix makes every path
  // unique regardless of what index the caller thinks it's on.
  const uniq = Math.random().toString(36).slice(2, 8)
  const filename = `${yyyy}_${mm}_${dd}_${dept}_${caseTag}_${index}_${uniq}.${ext}`
  return `${folder}/${filename}`
}

// 'maintenance' was retired — it overlapped with the Preventive Maintenance (PMS) add-on
// and confused reporters. Existing cases still resolve their label via CATEGORY_LABELS_EN.
export const CATEGORIES = ['cleanliness', 'safety', 'guest_complaint', 'equipment', 'other'] as const
export type Category = typeof CATEGORIES[number]

export const LOCATIONS = [
  'Resort Front',
  'Reception Front',
  'Pool Bar',
  'Huan Kamung',
  'Spa',
  'Swimming Pool',
  'Time',
  'Kitchen',
  'Engineering',
  'Public Area',
  'A-Front/Sales Office',
  'A-Accounting Office',
  'A-Store',
  'A-Human Resources Office',
  'A-House Keeping',
  'A-Staff Dressing Room',
  'A-MD/GM',
  'A-Meeting Room',
  'A-101', 'A-102', 'A-103',
  'A-201', 'A-202', 'A-203',
  'A-301', 'A-302', 'A-303', 'A-304', 'A-305',
  'B-101', 'B-102', 'B-103', 'B-104',
  'B-201', 'B-202', 'B-203', 'B-204',
  'C-101', 'C-102',
  'C-201', 'C-202',
  'C-Swimming Pool',
  'D-101', 'D-102',
  'D-201', 'D-202',
  'E-101', 'E-102', 'E-103', 'E-104',
  'E-201', 'E-202', 'E-203', 'E-204',
  'F-101', 'F-102', 'F-103', 'F-104', 'F-105',
  'F-201', 'F-202', 'F-203', 'F-204', 'F-205',
  'Others',
] as const

export function getSLAHours(priority: CasePriority): number {
  switch (priority) {
    case 'critical': return 4
    case 'high': return 24
    case 'medium': return 72
    case 'low': return 168
    default: return 72  // runtime safety: unknown/legacy priority falls back to the medium SLA
  }
}

export function getSLARemaining(kcase: KaizenCase): number {
  if (kcase.status === 'closed') return Infinity
  const elapsed = differenceInHours(new Date(), new Date(kcase.created_at))
  return getSLAHours(kcase.priority) - elapsed
}

export function isSLABreached(kcase: KaizenCase): boolean {
  if (kcase.status === 'closed') return false
  // Cases awaiting approval are waiting on a reviewer, not stalled by the team —
  // don't count them as overdue.
  if (kcase.status === 'pending_manager_approval' || kcase.status === 'pending_admin_approval') return false
  // Honour an explicit due date when set (overdue once that day has passed);
  // otherwise fall back to the priority SLA measured from creation.
  if (kcase.due_date) {
    const raw = String(kcase.due_date)
    // AF-001: pin a date-only deadline to end-of-day Asia/Bangkok. Without the
    // +07:00 offset, `new Date('YYYY-MMT23:59:59')` is parsed in the browser's
    // local timezone, so the SLA deadline drifts by the viewer's UTC offset
    // (cf. parseDateOnlyBkk, which exists for exactly this reason).
    const due = new Date(raw.length <= 10 ? `${raw}T23:59:59+07:00` : raw)
    if (!isNaN(due.getTime())) return new Date() > due
  }
  return getSLARemaining(kcase) < 0
}

// ── Due-by (deadline) formatting ──────────────────────────────────────────────
// Case due dates are timestamps. A "date-only" deadline is stored at end-of-day
// (23:59); anything else carries a specific time the user picked (e.g. urgent
// "due in 30 minutes"). Show the time only when it's meaningful.
export function dueIsDateOnly(due: string): boolean {
  const d = new Date(due)
  if (isNaN(d.getTime())) return true
  // Extract hour/minute in Bangkok TZ (not local browser TZ) so the 23:59 sentinel
  // stored as UTC 16:59 is correctly identified on all browsers.
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok', hour12: false }).formatToParts(d)
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  const hm = h * 60 + m
  return hm === 23 * 60 + 59 || hm === 0 // end-of-day sentinel or midnight
}

export function formatDueBy(due: string | null | undefined, lang = 'en'): string {
  if (!due) return ''
  const d = new Date(due)
  if (isNaN(d.getTime())) return String(due)
  const loc = lang === 'th' ? 'th-TH' : 'en-GB'
  const tz = { timeZone: 'Asia/Bangkok' }
  const dateStr = d.toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric', ...tz })
  if (dueIsDateOnly(due)) return dateStr
  return `${dateStr}, ${d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', ...tz })}`
}

// Bind an ISO timestamp to / from an <input type="datetime-local">.
// CDP-003: always use Asia/Bangkok so the editor shows the correct local hotel time
// regardless of the viewer's browser timezone.
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  // 'sv' locale gives YYYY-MM-DD HH:mm:ss; slice to YYYY-MM-DDTHH:mm
  return d.toLocaleString('sv', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T').slice(0, 16)
}
export function fromDateTimeLocal(v: string): string {
  // v is in Bangkok wall-clock time; append +07:00 so Date parses it correctly
  return v ? new Date(`${v}:00+07:00`).toISOString() : ''
}

// Calendar date (YYYY-MM-DD) of a timestamp in the hotel's timezone (Asia/Bangkok).
// Use for any "today"/"this month" key or for comparing a timestamptz against a stored
// `date`, so the result is stable for every viewer instead of the browser's local day
// (raw toISOString() is UTC and lags a day during the 00:00–07:00 Bangkok window).
export function bangkokDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

// Bangkok TZ component extractors — use these instead of d.getHours(), d.getMonth(), d.getDay()
// which return local-timezone values and break when the runtime or viewer is not UTC+7.
export function bangkokHour(d: Date = new Date()): number {
  return parseInt(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }).format(d), 10)
}
export function bangkokMonth(d: Date = new Date()): number {
  // 0-indexed (January = 0), same contract as Date.getMonth()
  return parseInt(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', month: 'numeric' }).format(d), 10) - 1
}
export function bangkokDayOfWeek(d: Date = new Date()): number {
  // 0 = Sunday … 6 = Saturday, same contract as Date.getDay()
  const short = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', weekday: 'short' }).format(d)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short)
}
export function parseDateOnlyBkk(s: string): Date {
  // Parse a YYYY-MM-DD string as midnight Bangkok time.
  // Use instead of new Date('YYYY-MM-DD') which produces midnight UTC (7 h behind Bangkok).
  return new Date(`${s}T00:00:00+07:00`)
}

// Extract a Supabase Storage path from a public kaizen-photos URL (e.g.
// ".../storage/v1/object/public/kaizen-photos/<path>" → "<path>"), for
// .storage.from('kaizen-photos').remove([path]) calls. Falls back to the raw
// URL if the marker isn't found, matching every call site's prior behavior.
export function photoStoragePathFromUrl(url: string): string {
  const marker = '/kaizen-photos/'
  const idx = url.indexOf(marker)
  if (idx === -1) return url
  const raw = url.slice(idx + marker.length)
  // getPublicUrl() encodeURIs the path (e.g. a space becomes %20), but storage.objects
  // holds the raw decoded key — .remove([path]) needs the latter or it silently no-ops
  // instead of deleting (Supabase doesn't error on a non-matching key).
  try { return decodeURIComponent(raw) } catch { return raw }
}

// Format a Date for display in Asia/Bangkok time — always pass this instead of
// d.toLocaleDateString(locale, opts) so the result is stable regardless of the
// browser/server's local timezone.
export function fmtLocaleDateBkk(
  d: Date,
  locale: string,
  opts: Omit<Intl.DateTimeFormatOptions, 'timeZone'> = {},
): string {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'Asia/Bangkok' }).format(d)
}

// Stable unique ID for draft array items — use as React key instead of array index
// so keys survive mid-array insertion/deletion without remounting the wrong component.
export function makeDraftId(): string {
  return `draft_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

// Ref-backed busy guard that prevents a double-click from firing an async
// handler twice. Returns a stable wrapper: call `guard(fn)` instead of `fn()`
// on any button that triggers a network write.
export function useAsyncGuard() {
  const busy = useRef(false)
  return useCallback(async (fn: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true
    try { await fn() } finally { busy.current = false }
  }, [])
}

// Mirrors a server-supplied value into local state. When `locked` is true
// (component is in read-only / view mode) the local state is kept in sync with
// the latest prop so the next edit session starts from the current server value.
// When `locked` is false (user is actively editing) the local state is left
// alone so in-progress edits are not clobbered by a background prop change.
export function useServerState<T>(serverValue: T, locked: boolean): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(serverValue)
  useEffect(() => {
    if (locked) setState(serverValue)
  }, [serverValue, locked])
  return [state, setState]
}
