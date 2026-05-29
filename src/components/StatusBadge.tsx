import { cn, getStatusColor, getPriorityColor, getDepartmentColor } from '@/lib/utils'
import { STATUS_LABELS, PRIORITY_LABELS, DEPARTMENT_LABELS } from '@/types'
import type { CaseStatus, CasePriority, Department } from '@/types'

export function StatusBadge({ status }: { status: CaseStatus }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', getStatusColor(status))}>
      {STATUS_LABELS[status]}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: CasePriority }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', getPriorityColor(priority))}>
      {PRIORITY_LABELS[priority]}
    </span>
  )
}

export function DepartmentBadge({ department }: { department: Department }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', getDepartmentColor(department))}>
      {DEPARTMENT_LABELS[department]}
    </span>
  )
}
