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
  /** Display name shown in the app UI; falls back to the legal `name`. Never printed on documents. */
  org_title?: string | null
  slug: string
  logo_url: string | null
  is_active: boolean
  created_at: string
  // Package-derived (denormalised from the assigned product/package)
  plan?: string
  max_managers?: number | null
  max_staff?: number | null
  multi_company?: boolean
  features?: Record<string, boolean> | null
  max_super_admins?: number | null
  addons?: Record<string, boolean | string> | null
  subscription_end?: string | null
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
  job_title: string | null
  position: string | null
  must_change_password: boolean
  last_active_at?: string | null
  last_login_at?: string | null
  deleted_at?: string | null
  created_at: string
  updated_at: string
}

export interface KaizenCase {
  id: string
  case_number: string
  title: string
  description: string
  department: Department
  company_id: string | null
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
  person_in_charge?: string | null
  pic_ids?: string[] | null
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
  title_key?: string | null
  body_params?: Record<string, string | number> | null
  case?: KaizenCase
}

// ── Routine Roster (daily recurring inter-department orders) ────────────────
export type RrOrderType = 'bulk' | 'per_room' | 'per_room_variants'
export type RrOrderStatus = 'pending' | 'sent' | 'accepted' | 'delivered' | 'confirmed' | 'cancelled'
export type RrPicMode = 'department' | 'users'

/** A selectable variant for per-room-with-variants routines (e.g. V1/V2/V3). */
export interface RrVariant {
  code: string
  label: string
  label_th: string
}

export interface RrTemplate {
  id: string
  company_id: string
  name: string
  name_th: string | null
  request_department: Department
  fulfill_department: Department
  order_type: RrOrderType
  default_item: string | null
  /** Per-weekday item override, keys 'mon'..'sun' (e.g. turndown gift of the day) */
  item_by_weekday: Record<string, string> | null
  /** Weekdays the routine runs ('mon'..'sun'); null = every day. */
  run_weekdays: string[] | null
  due_time: string
  active: boolean
  sort_order: number
  created_at: string
  // ── order-ahead scheduling ──
  /** 0 = same-day, 1 = order placed the day before the service date, etc. */
  lead_days: number
  /** Evening order window open time (HH:MM[:SS]) when lead_days > 0. */
  order_open: string | null
  order_close: string | null
  /** Reminder time (HH:MM[:SS]) — optional. */
  remind_at: string | null
  // ── bulk unit ──
  /** Bulk unit label, e.g. "gallon". */
  unit_label: string | null
  // ── per-room variants ──
  variants: RrVariant[] | null
  // ── catalog items (from dept item catalog) ──
  catalog_items: { label: string; unit: string }[] | null
  // ── person in charge (request side) ──
  pic_mode: RrPicMode
  pic_ids: string[] | null
}

export interface RrOrder {
  id: string
  company_id: string
  template_id: string | null
  order_date: string
  title: string
  request_department: Department
  fulfill_department: Department
  order_type: RrOrderType
  item_label: string | null
  quantity: number | null
  note: string | null
  status: RrOrderStatus
  /** Bulk unit label snapshot, e.g. "gallon". */
  unit_label: string | null
  due_at: string | null
  sent_by: string | null
  sent_at: string | null
  accepted_by: string | null
  accepted_at: string | null
  delivered_by: string | null
  delivered_at: string | null
  confirmed_by: string | null
  confirmed_at: string | null
  created_at: string
  // joined
  items?: RrOrderItem[]
}

export interface RrOrderItem {
  id: string
  order_id: string
  company_id: string
  room_no: string
  item_label: string | null
  /** Variant code (V1/V2/V3) for per-room-with-variants routines. */
  variant: string | null
  delivered: boolean
  delivered_by: string | null
  delivered_at: string | null
  created_at: string
}

/** Acknowledgement-timeline event for an order. */
export interface RrEvent {
  id: string
  company_id: string
  order_id: string
  actor_id: string | null
  action: string
  detail: string | null
  created_at: string
}

export interface RrMute {
  id: string
  company_id: string
  user_id: string
  template_id: string
  created_at: string
}

export interface KaizenSettings {
  primary_color: string
  accent_color: string
  sidebar_color: string
  /** Page canvas background. Set only by Special Presets — no manual user picker. */
  background_color: string
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

export const DEPARTMENT_LABELS_TH: Record<Department, string> = {
  top_management: 'ผู้บริหารระดับสูง',
  front_office: 'แผนกต้อนรับ',
  sales_team: 'ฝ่ายขาย',
  house_keeping: 'แผนกแม่บ้าน',
  human_resource: 'ฝ่ายบุคคล',
  engineering_team: 'ฝ่ายช่าง',
  restaurant: 'ห้องอาหาร',
  kitchen: 'ครัว',
  accounting: 'ฝ่ายบัญชี',
}

/** Department label in the given UI language (falls back to English). */
export function deptLabel(dept: Department, lang?: string): string {
  return lang === 'th' ? (DEPARTMENT_LABELS_TH[dept] ?? DEPARTMENT_LABELS[dept]) : DEPARTMENT_LABELS[dept]
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
