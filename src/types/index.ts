export type Department =
  | 'top_management'
  | 'front_office'
  | 'sales_team'
  | 'house_keeping'
  | 'human_resource'
  | 'engineering_team'
  | 'restaurant'
  | 'kitchen'
  | 'accounting'

export type Role = 'super_admin' | 'manager' | 'staff'

export type CaseStatus =
  | 'open'
  | 'assigned'
  | 'in_progress'
  | 'pending_manager_approval'
  | 'pending_admin_approval'
  | 'closed'
  | 'reopened'

export type CasePriority = 'low' | 'medium' | 'high' | 'critical'

export type PhotoType = 'problem' | 'resolution'

export type AssignmentStatus = 'pending' | 'acknowledged' | 'in_progress' | 'completed'

export interface KaizenCompany {
  id: string
  name: string
  slug: string
  logo_url: string | null
  is_active: boolean
  created_at: string
}

export interface KaizenProfile {
  id: string
  full_name: string
  username: string | null
  email: string | null
  role: Role
  department: Department
  company_id: string | null
  is_active: boolean
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export interface KaizenCase {
  id: string
  case_number: string
  title: string
  description: string
  department: Department
  created_by: string
  status: CaseStatus
  priority: CasePriority
  proposed_solution: string | null
  assigned_departments: Department[] | null
  due_date?: string | null
  category?: string | null
  category_other?: string | null
  location?: string | null
  location_other?: string | null
  is_recurring?: boolean
  linked_case_ids?: string[]
  resolved_by: string | null
  resolution_note?: string | null
  manager_approved_by: string | null
  admin_approved_by: string | null
  manager_approved_at: string | null
  admin_approved_at: string | null
  resolved_at: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
  // joined
  creator?: KaizenProfile
  photos?: KaizenCasePhoto[]
  assignments?: KaizenCaseAssignment[]
  timeline?: KaizenCaseTimeline[]
}

export interface KaizenCasePhoto {
  id: string
  case_id: string
  photo_url: string
  photo_type: PhotoType
  uploaded_by: string
  created_at: string
  uploader?: KaizenProfile
}

export interface KaizenCaseAssignment {
  id: string
  case_id: string
  department: Department
  assigned_staff: string | null
  assigned_by: string | null
  status: AssignmentStatus
  notes: string | null
  created_at: string
  updated_at: string
  staff?: KaizenProfile
  assigner?: KaizenProfile
}

export interface KaizenCaseTimeline {
  id: string
  case_id: string
  action: string
  description: string | null
  performed_by: string | null
  metadata: Record<string, unknown>
  created_at: string
  performer?: KaizenProfile
}

export interface KaizenNotification {
  id: string
  user_id: string
  case_id: string | null
  title: string
  message: string
  is_read: boolean
  notification_type: string
  created_at: string
  case?: KaizenCase
}

export interface KaizenSettings {
  primary_color: string
  accent_color: string
  sidebar_color: string
}

export const DEPARTMENTS: { value: Department; label: string }[] = [
  { value: 'top_management', label: 'Top Management' },
  { value: 'front_office', label: 'Front Office' },
  { value: 'sales_team', label: 'Sales Team' },
  { value: 'house_keeping', label: 'House Keeping' },
  { value: 'human_resource', label: 'Human Resource' },
  { value: 'engineering_team', label: 'Engineering Team' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'accounting', label: 'Accounting' },
]

export const DEPARTMENT_LABELS: Record<Department, string> = {
  top_management: 'Top Management',
  front_office: 'Front Office',
  sales_team: 'Sales Team',
  house_keeping: 'House Keeping',
  human_resource: 'Human Resource',
  engineering_team: 'Engineering Team',
  restaurant: 'Restaurant',
  kitchen: 'Kitchen',
  accounting: 'Accounting',
}

export const STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Open',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  pending_manager_approval: 'Manager Approval',
  pending_admin_approval: 'GM/MD Approval',
  closed: 'Closed',
  reopened: 'Reopened',
}

export const PRIORITY_LABELS: Record<CasePriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}
