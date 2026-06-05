import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { formatDistanceToNow, format, differenceInSeconds, differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns'
import type { CaseStatus, CasePriority, Department, KaizenCase } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatRelativeTime(date: string | Date) {
  return formatDistanceToNow(new Date(date), { addSuffix: true })
}

// "Online" = active within the last 5 minutes.
export function isOnline(lastActiveAt?: string | null): boolean {
  if (!lastActiveAt) return false
  return Date.now() - new Date(lastActiveAt).getTime() < 5 * 60 * 1000
}

// Compact activity label for user lists: "Online", "Active 12m ago", "Never".
export function activityLabel(lastActiveAt?: string | null): string {
  if (!lastActiveAt) return 'Never logged in'
  if (isOnline(lastActiveAt)) return 'Online now'
  return `Active ${formatDistanceToNow(new Date(lastActiveAt), { addSuffix: true })}`
}

export function formatDateTime(date: string | Date) {
  return format(new Date(date), 'dd MMM yyyy, HH:mm')
}

export function formatDate(date: string | Date) {
  return format(new Date(date), 'dd MMM yyyy')
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
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const random = Math.floor(Math.random() * 9000) + 1000
  return `KZN-${year}${month}-${random}`
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

export function buildPhotoPath(caseNumber: string, department: string, index: number, ext: string): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const dept = DEPT_ABBR[department] ?? department.toUpperCase().slice(0, 2)
  const caseTag = caseNumber.replace(/-/g, '_')
  const folder = `Na Nirand Kaizen/${yyyy}-${mm}`
  const filename = `${yyyy}_${mm}_${dd}_${dept}_${caseTag}_${index}.${ext}`
  return `${folder}/${filename}`
}

export const CATEGORIES = ['maintenance', 'cleanliness', 'safety', 'guest_complaint', 'equipment', 'other'] as const
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
  }
}

export function getSLARemaining(kcase: KaizenCase): number {
  if (kcase.status === 'closed') return Infinity
  const elapsed = differenceInHours(new Date(), new Date(kcase.created_at))
  return getSLAHours(kcase.priority) - elapsed
}

export function isSLABreached(kcase: KaizenCase): boolean {
  if (kcase.status === 'closed') return false
  return getSLARemaining(kcase) < 0
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}
