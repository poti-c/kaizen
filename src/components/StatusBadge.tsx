import { cn, getStatusColor, getPriorityColor, getDepartmentColor } from '@/lib/utils'
import { deptLabel } from '@/types'
import { useLanguage } from '@/contexts/LanguageContext'
import type { CaseStatus, CasePriority, Department } from '@/types'

export function StatusBadge({ status }: { status: CaseStatus }) {
  const { t } = useLanguage()
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', getStatusColor(status))}>
      {t.status[status]}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: CasePriority }) {
  const { t } = useLanguage()
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', getPriorityColor(priority))}>
      {t.priority[priority]}
    </span>
  )
}

export function DepartmentBadge({ department }: { department: string }) {
  const { lang } = useLanguage()
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', getDepartmentColor(department as Department))}>
      {deptLabel(department, lang)}
    </span>
  )
}
