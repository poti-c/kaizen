import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PlusCircle, Search, Filter, Clock, ChevronRight, Download, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, RefreshCw, X, AlertCircle, CalendarDays, ChevronDown, ChevronUp } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { StatusBadge, PriorityBadge, DepartmentBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PMTaskModal, taskTone, type PMTask } from '@/components/pm/PMSchedule'
import { formatRelativeTime, formatDuration, isSLABreached, CATEGORIES, LOCATIONS, companyHasAddon } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { KaizenCase, CaseStatus, CasePriority, Department } from '@/types'
import { STATUS_LABELS, PRIORITY_LABELS, DEPARTMENTS, DEPARTMENT_LABELS } from '@/types'

const STATUS_FILTERS: (CaseStatus | 'all')[] = ['all', 'open', 'assigned', 'in_progress', 'pending_manager_approval', 'pending_admin_approval', 'closed', 'reopened']

const STATUS_FILTER_LABELS: Partial<Record<CaseStatus | 'all', string>> = {
  pending_manager_approval: 'Manager Pending',
  pending_admin_approval: 'GM/MD Pending',
}

type SortKey = 'priority' | 'status' | 'duration' | 'date' | 'due'
type SortDir = 'asc' | 'desc'

const PAGE_SIZE = 20

const CATEGORY_LABELS_EN: Record<string, string> = {
  maintenance: 'Maintenance', cleanliness: 'Cleanliness', safety: 'Safety',
  guest_complaint: 'Guest Complaint', equipment: 'Equipment', other: 'Other',
}

// One PM task row in the Cases → PMS tab (opens the run/checklist modal).
function PmTaskRow({ t, onOpen }: { t: PMTask; onOpen: () => void }) {
  const tone = taskTone(t)
  const due = new Date(t.due_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return (
    <button onClick={onOpen} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors">
      <span className={cn('w-2 h-2 rounded-full flex-shrink-0', tone.dot)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-900 truncate">{t.asset?.name ?? 'Asset'}</span>
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border', tone.chip)}>{tone.label}</span>
        </div>
        <p className="text-[11px] text-gray-400 truncate">
          {t.asset?.location ?? '—'}{t.asset?.department ? ` · ${DEPARTMENT_LABELS[t.asset.department as Department] ?? t.asset.department}` : ''} · due {due}
        </p>
      </div>
      <ChevronRight className="h-4 w-4 text-gray-300 flex-shrink-0" />
    </button>
  )
}

export function CasesPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t } = useLanguage()
  const [searchParams] = useSearchParams()
  const [cases, setCases] = useState<KaizenCase[]>([])
  const [filtered, setFiltered] = useState<KaizenCase[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(searchParams.get('q') || '')
  const [statusFilter, setStatusFilter] = useState<CaseStatus | 'all'>(
    (searchParams.get('status') as CaseStatus) || 'all'
  )
  const [groupFilter] = useState<string>(searchParams.get('group') || '')
  const [priorityFilter, setPriorityFilter] = useState<CasePriority | 'all'>(
    (searchParams.get('priority') as CasePriority) || 'all'
  )
  const [categoryFilter, setCategoryFilter] = useState<string>(searchParams.get('category') || 'all')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [pageActive, setPageActive] = useState(1)
  const [pageClosed, setPageClosed] = useState(1)

  // Custom lists for incomplete case detection (locations + departments + categories)
  const [customLocations, setCustomLocations] = useState<string[]>([...LOCATIONS] as string[])
  const [validDeptValues, setValidDeptValues] = useState<string[]>(DEPARTMENTS.map(d => d.value))
  // Valid category slugs derived from custom category display names
  const [validCategorySlugs, setValidCategorySlugs] = useState<string[]>([...CATEGORIES] as string[])

  useEffect(() => {
    supabase.from('kaizen_settings').select('key, value')
      .in('key', ['custom_locations', 'custom_departments', 'custom_categories'])
      .then(({ data }) => {
        if (!data) return
        data.forEach((row: { key: string; value: unknown }) => {
          if (!Array.isArray(row.value) || row.value.length === 0) return
          if (row.key === 'custom_locations') {
            setCustomLocations(row.value as string[])
          }
          if (row.key === 'custom_departments') {
            const vals = (row.value as string[])
              .map(label => DEPARTMENTS.find(d => d.label === label)?.value)
              .filter(Boolean) as string[]
            if (vals.length > 0) setValidDeptValues(vals)
          }
          if (row.key === 'custom_categories') {
            // Convert display names → slugs (e.g. "Guest Complaint" → "guest_complaint")
            const slugs = (row.value as string[]).map(c => c.toLowerCase().replace(/ /g, '_'))
            if (slugs.length > 0) setValidCategorySlugs(slugs)
          }
        })
      })
  }, [])

  // Advanced search state
  const [advancedSearchEnabled, setAdvancedSearchEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('kaizen-advanced-search-enabled')
    return saved ? JSON.parse(saved) : false
  })
  const [advFilters, setAdvFilters] = useState<{
    statuses: CaseStatus[]
    departments: Department[]
    priorities: CasePriority[]
    categories: string[]
  }>(() => {
    const saved = localStorage.getItem('kaizen-adv-filters')
    return saved ? JSON.parse(saved) : { statuses: [], departments: [], priorities: [], categories: [] }
  })

  // ── Date filter ───────────────────────────────────────────────────────────
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set()) // empty = all

  function monthKey(year: number, month: number) { return `${year}-${month}` }
  const MONTH_SHORT_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  // Build month list from actual case data
  const caseMonthList = React.useMemo(() => {
    const keys = new Set<string>()
    cases.forEach(c => {
      const d = new Date(c.created_at)
      keys.add(monthKey(d.getFullYear(), d.getMonth()))
    })
    return Array.from(keys)
      .map(k => { const [y, m] = k.split('-').map(Number); return { year: y, month: m, label: MONTH_SHORT_LABELS[m], key: k } })
      .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
  }, [cases])

  const caseByYear = React.useMemo(() => {
    const map: Record<number, typeof caseMonthList> = {}
    caseMonthList.forEach(m => { if (!map[m.year]) map[m.year] = []; map[m.year].push(m) })
    return Object.entries(map).map(([y, ms]) => ({ year: Number(y), months: ms })).reverse()
  }, [caseMonthList])

  function toggleCaseMonth(key: string) {
    setSelectedMonths(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }
  function toggleCaseYear(year: number) {
    const keys = caseMonthList.filter(m => m.year === year).map(m => m.key)
    setSelectedMonths(prev => {
      const allSel = keys.every(k => prev.has(k))
      const n = new Set(prev)
      allSel ? keys.forEach(k => n.delete(k)) : keys.forEach(k => n.add(k))
      return n
    })
  }

  const dateLabel = selectedMonths.size === 0
    ? 'All time'
    : selectedMonths.size === 1
      ? (() => { const [k] = selectedMonths; const m = caseMonthList.find(x => x.key === k); return m ? `${m.label} ${m.year}` : '' })()
      : `${selectedMonths.size} months`
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (profile && activeCompany) fetchCases()
  }, [profile, activeCompany])

  useEffect(() => {
    let result = cases

    // Keyword search
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((c) =>
        c.title.toLowerCase().includes(q) ||
        c.case_number.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      )
    }

    // Advanced filters (if enabled)
    if (advancedSearchEnabled) {
      // Status filter: OR logic (show if status matches ANY selected)
      if (advFilters.statuses.length > 0) {
        result = result.filter((c) => advFilters.statuses.includes(c.status))
      }
      // Department filter: OR logic
      if (advFilters.departments.length > 0) {
        result = result.filter((c) => advFilters.departments.includes(c.department))
      }
      // Priority filter: OR logic
      if (advFilters.priorities.length > 0) {
        result = result.filter((c) => advFilters.priorities.includes(c.priority))
      }
      // Category filter: OR logic
      if (advFilters.categories.length > 0) {
        result = result.filter((c) => c.category && advFilters.categories.includes(c.category))
      }
    } else {
      // Old filter logic (when advanced search disabled)
      if (groupFilter === 'open') {
        result = result.filter((c) => ['open', 'reopened'].includes(c.status))
      } else if (groupFilter === 'in_progress') {
        result = result.filter((c) => ['assigned', 'in_progress'].includes(c.status))
      } else if (groupFilter === 'pending') {
        result = result.filter((c) => ['pending_manager_approval', 'pending_admin_approval'].includes(c.status))
      } else if (groupFilter === 'resolved') {
        result = result.filter((c) => c.status === 'closed')
      } else if (statusFilter !== 'all') {
        result = result.filter((c) => c.status === statusFilter)
      }
      if (priorityFilter !== 'all') result = result.filter((c) => c.priority === priorityFilter)
      if (categoryFilter !== 'all') result = result.filter((c) => c.category === categoryFilter)
    }

    // Date filter
    if (selectedMonths.size > 0) {
      result = result.filter(c => {
        const d = new Date(c.created_at)
        return selectedMonths.has(monthKey(d.getFullYear(), d.getMonth()))
      })
    }

    setFiltered(result)
    setPageActive(1)
    setPageClosed(1)
  }, [cases, search, statusFilter, groupFilter, priorityFilter, categoryFilter, advancedSearchEnabled, advFilters, selectedMonths])

  async function fetchCases() {
    if (!profile) return
    setLoading(true)

    let query = supabase
      .from('kaizen_cases')
      .select('*, creator:kaizen_profiles!kaizen_cases_created_by_fkey(id, full_name, department)')
      .order('created_at', { ascending: false })

    if (activeCompany) query = query.eq('company_id', activeCompany.id)
    const isHRMgr = profile.role === 'manager' && profile.department === 'human_resource'
    if (profile.role === 'staff') {
      query = query.eq('department', profile.department)
    }
    // Managers see all cases (cross-dept view) — edit restrictions enforced in CaseDetailPage
    // HR Manager: no filter — sees all cases (read-only enforced in detail page)

    const { data } = await query
    setCases((data || []) as KaizenCase[])
    setLoading(false)
  }

  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />
  }

  function sortCases(list: KaizenCase[]) {
    return [...list].sort((a, b) => {
      if (!sortKey) return (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4)
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortKey === 'priority') return dir * ((priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4))
      if (sortKey === 'status') return dir * a.status.localeCompare(b.status)
      if (sortKey === 'duration') return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      if (sortKey === 'date') return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      if (sortKey === 'due') {
        const aTime = a.due_date ? new Date(a.due_date).getTime() : Infinity
        const bTime = b.due_date ? new Date(b.due_date).getTime() : Infinity
        return dir * (aTime - bTime)
      }
      return 0
    })
  }

  // Split into active, two pending levels, and closed
  const activeCases       = sortCases(filtered.filter(c => !['closed','pending_manager_approval','pending_admin_approval'].includes(c.status)))
  const pendingMgrCases   = sortCases(filtered.filter(c => c.status === 'pending_manager_approval'))
  const pendingAdminCases = sortCases(filtered.filter(c => c.status === 'pending_admin_approval'))
  const closedCases       = sortCases(filtered.filter(c => c.status === 'closed'))

  const totalActivePages     = Math.ceil(activeCases.length / PAGE_SIZE)
  const totalPendingMgrPages = Math.ceil(pendingMgrCases.length / PAGE_SIZE)
  const totalPendingAdmPages = Math.ceil(pendingAdminCases.length / PAGE_SIZE)
  const totalClosedPages     = Math.ceil(closedCases.length / PAGE_SIZE)
  const [pagePendingMgr, setPagePendingMgr] = React.useState(1)
  const [pagePendingAdm, setPagePendingAdm] = React.useState(1)
  const paginatedActive     = activeCases.slice((pageActive - 1) * PAGE_SIZE, pageActive * PAGE_SIZE)
  const paginatedPendingMgr = pendingMgrCases.slice((pagePendingMgr - 1) * PAGE_SIZE, pagePendingMgr * PAGE_SIZE)
  const paginatedPendingAdm = pendingAdminCases.slice((pagePendingAdm - 1) * PAGE_SIZE, pagePendingAdm * PAGE_SIZE)
  const paginatedClosed     = closedCases.slice((pageClosed - 1) * PAGE_SIZE, pageClosed * PAGE_SIZE)

  function exportCSV() {
    const headers = ['Case #', 'Date', 'Title', 'Description', 'Department', 'Category', 'Priority', 'Status', 'Due Date', 'Duration']
    const rows = filtered.map((c) => [
      c.case_number,
      new Date(c.created_at).toLocaleDateString('en-GB'),
      `"${c.title.replace(/"/g, '""')}"`,
      `"${c.description.replace(/"/g, '""')}"`,
      c.department,
      c.category || '',
      c.priority,
      c.status,
      c.due_date || '',
      formatDuration(c.created_at, c.closed_at || undefined),
    ])
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kaizen-cases-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function CaseTableHeader() {
    return (
      <tr className="border-b border-gray-100 bg-gray-50">
        <th onClick={() => handleSort('date')} className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700">
          <span className="flex items-center">{t.cases.caseNo}<SortIcon k="date" /></span>
        </th>
        <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.cases.titleCol}</th>
        <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.cases.dept}</th>
        <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{t.cases.category}</th>
        <th onClick={() => handleSort('priority')} className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700">
          <span className="flex items-center">{t.cases.priority}<SortIcon k="priority" /></span>
        </th>
        <th onClick={() => handleSort('status')} className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700">
          <span className="flex items-center">{t.cases.status}<SortIcon k="status" /></span>
        </th>
        <th onClick={() => handleSort('due')} className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700">
          <span className="flex items-center">{t.cases.due}<SortIcon k="due" /></span>
        </th>
        <th onClick={() => handleSort('duration')} className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700">
          <span className="flex items-center">{t.cases.duration}<SortIcon k="duration" /></span>
        </th>
      </tr>
    )
  }

  function CaseRow({ c }: { c: KaizenCase }) {
    const breached = isSLABreached(c)
    return (
      <Link key={c.id} to={`/cases/${c.id}`} className="contents">
        <tr className="hover:bg-gray-50 transition-colors cursor-pointer">
          <td className="px-5 py-3.5 whitespace-nowrap">
            <div className="flex items-center gap-1">
              <span className="font-mono text-xs font-medium text-gray-700 block">{c.case_number}</span>
              {breached && <span className="animate-pulse text-red-500 text-xs font-bold" title={t.cases.slaBreached}>⚠</span>}
            </div>
            <span className="text-xs text-gray-400 mt-0.5 block">{new Date(c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </td>
          <td className="px-5 py-3.5 max-w-xs">
            <div className="flex items-center gap-1.5">
              <p className="font-medium text-gray-900 truncate">{c.title}</p>
              {c.is_recurring && <RefreshCw className="h-3 w-3 text-orange-500 flex-shrink-0" />}
            </div>
            <p className="text-xs text-gray-400 truncate mt-0.5">{c.description}</p>
          </td>
          <td className="px-5 py-3.5"><DepartmentBadge department={c.department} /></td>
          <td className="px-5 py-3.5">
            {c.category ? (
              <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">{CATEGORY_LABELS_EN[c.category] || c.category}</span>
            ) : (
              <span className="text-xs text-gray-300">—</span>
            )}
          </td>
          <td className="px-5 py-3.5"><PriorityBadge priority={c.priority} /></td>
          <td className="px-5 py-3.5"><StatusBadge status={c.status} /></td>
          <td className="px-5 py-3.5 whitespace-nowrap">
            {c.due_date ? (
              <span className={cn('text-xs', new Date(c.due_date) < new Date() && c.status !== 'closed' ? 'text-red-500 font-medium' : 'text-gray-500')}>
                {new Date(c.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
            ) : <span className="text-xs text-gray-300">—</span>}
          </td>
          <td className="px-5 py-3.5">
            <div className="flex items-center gap-1 text-xs text-gray-500">
              <Clock className="h-3 w-3" />
              {formatDuration(c.created_at, c.closed_at || undefined)}
            </div>
          </td>
        </tr>
      </Link>
    )
  }

  function MobileCard({ c }: { c: KaizenCase }) {
    const breached = isSLABreached(c)
    return (
      <Link to={`/cases/${c.id}`} className="block bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3.5 active:bg-gray-50">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <span className="text-xs text-gray-400 font-mono">{c.case_number}</span>
              {breached && <span className="animate-pulse text-red-500 text-xs font-bold" title={t.cases.slaBreached}>⚠</span>}
              <PriorityBadge priority={c.priority} />
              <StatusBadge status={c.status} />
            </div>
            <div className="flex items-center gap-1.5 mb-1">
              <p className="text-sm font-semibold text-gray-900 truncate">{c.title}</p>
              {c.is_recurring && <RefreshCw className="h-3 w-3 text-orange-500 flex-shrink-0" />}
            </div>
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              <DepartmentBadge department={c.department} />
              {c.category && <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">{CATEGORY_LABELS_EN[c.category] || c.category}</span>}
              <span className="text-xs text-gray-400">{formatRelativeTime(c.created_at)}</span>
              <span className="flex items-center gap-1 text-xs text-gray-400">
                <Clock className="h-3 w-3" />
                {formatDuration(c.created_at, c.closed_at || undefined)}
              </span>
              {c.due_date && (
                <span className={cn('text-xs', new Date(c.due_date) < new Date() && c.status !== 'closed' ? 'text-red-500 font-medium' : 'text-gray-400')}>
                  {t.cases.due}: {new Date(c.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
              )}
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-gray-300 flex-shrink-0 mt-1" />
        </div>
      </Link>
    )
  }

  function Pagination({ page, totalPages, onPrev, onNext, total }: { page: number; totalPages: number; onPrev: () => void; onNext: () => void; total: number }) {
    if (total <= PAGE_SIZE) return null
    return (
      <div className="mt-3 flex flex-col items-center gap-2">
        <p className="text-xs text-gray-500">
          Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} cases
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onPrev} disabled={page === 1}>
            <ChevronLeft className="h-4 w-4" />Previous
          </Button>
          <span className="text-sm text-gray-600">Page {page} of {totalPages}</span>
          <Button variant="outline" size="sm" onClick={onNext} disabled={page === totalPages}>
            Next<ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    )
  }

  const showActive = statusFilter === 'all' || statusFilter !== 'closed'
  const showClosed = statusFilter === 'all' || statusFilter === 'closed'

  // Tab state
  const [activeTab, setActiveTab] = useState<'active' | 'pms' | 'pending' | 'closed'>('active')
  const pendingTotal = pendingMgrCases.length + pendingAdminCases.length

  // ── PMS tab: preventive-maintenance tasks (active + overdue) ───────────────
  const pmsEnabled = companyHasAddon(activeCompany, 'pms')
  const [pmTasks, setPmTasks] = useState<PMTask[]>([])
  const [openTask, setOpenTask] = useState<PMTask | null>(null)
  const [pmsMonth, setPmsMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [pmsViewAll, setPmsViewAll] = useState(false)
  const loadPmTasks = React.useCallback(() => {
    if (!activeCompany?.id || !pmsEnabled) { setPmTasks([]); return }
    ;(async () => {
      try { await supabase.rpc('kaizen_pm_sync') } catch { /* materialize tasks; ignore if it fails */ }
      const { data } = await supabase.from('kaizen_pm_tasks')
        .select('*, asset:kaizen_pm_assets(name, location, notes, checklist, department, type:kaizen_pm_equipment_types(name))')
        .eq('company_id', activeCompany.id).in('status', ['scheduled', 'in_progress', 'pending_approval'])
      setPmTasks((data as PMTask[]) ?? [])
    })()
  }, [activeCompany?.id, pmsEnabled])
  useEffect(() => { loadPmTasks() }, [loadPmTasks])

  const todayKey = new Date().toISOString().slice(0, 10)
  const matchTaskSearch = (t: PMTask) => !search || `${t.asset?.name ?? ''} ${t.asset?.location ?? ''} ${t.asset?.type?.name ?? ''}`.toLowerCase().includes(search.toLowerCase())
  const overdueTasks = pmTasks.filter(t => t.due_date < todayKey && matchTaskSearch(t))
  const activeTasksAll = pmTasks.filter(t => t.due_date >= todayKey && matchTaskSearch(t))
  const activeTasks = pmsViewAll ? activeTasksAll : activeTasksAll.filter(t => {
    const d = new Date(t.due_date + 'T00:00:00')
    return d.getFullYear() === pmsMonth.getFullYear() && d.getMonth() === pmsMonth.getMonth()
  })
  const pmsOpenCount = overdueTasks.length + activeTasksAll.length
  const pmsMonthLabel = pmsMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  const stepPmsMonth = (delta: number) => setPmsMonth(m => new Date(m.getFullYear(), m.getMonth() + delta, 1))

  // Incomplete cases: department, location or category no longer exists in the current custom lists
  const incompleteCases = cases.filter(c => {
    if (c.status === 'closed') return false
    const badDept = !validDeptValues.includes(c.department)
    const badLocation = c.location && c.location !== 'Others' &&
      !customLocations.some(l => l.toLowerCase() === c.location!.toLowerCase())
    const catSlug = (c.category || '').toLowerCase().replace(/ /g, '_')
    const badCategory = c.category && c.category !== 'other' && catSlug !== 'preventive_maintenance' &&
      !validCategorySlugs.some(s => s.toLowerCase() === catSlug)
    return badDept || badLocation || badCategory
  })

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-4 md:mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t.cases.title}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{t.cases.caseCount(filtered.length)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCSV} title="Export to CSV">
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{t.cases.export}</span>
          </Button>
          <Link to="/cases/new">
            <Button size="sm" className="md:size-default">
              <PlusCircle className="h-4 w-4" />
              <span className="hidden sm:inline">{t.cases.newCase}</span>
            </Button>
          </Link>
        </div>
      </div>

      {/* ── Incomplete Case Registration ── */}
      {!loading && incompleteCases.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden mb-4">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-200">
            <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-amber-800">
              Incomplete Case Registration
              <span className="ml-2 text-xs font-normal text-amber-600">{incompleteCases.length} case{incompleteCases.length > 1 ? 's' : ''} need{incompleteCases.length === 1 ? 's' : ''} updating</span>
            </h2>
          </div>
          <div className="divide-y divide-amber-100">
            {incompleteCases.map((c) => (
              <Link
                key={c.id}
                to={`/cases/${c.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-amber-100/60 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-xs font-mono text-amber-700">{c.case_number}</span>
                    <StatusBadge status={c.status} />
                    <PriorityBadge priority={c.priority} />
                  </div>
                  <p className="text-sm font-medium text-gray-900 truncate">{c.title}</p>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {!validDeptValues.includes(c.department) && (
                      <span className="text-xs text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                        Dept &ldquo;{DEPARTMENT_LABELS[c.department] ?? c.department}&rdquo; removed
                      </span>
                    )}
                    {c.location && c.location !== 'Others' && !customLocations.some(l => l.toLowerCase() === c.location!.toLowerCase()) && (
                      <span className="text-xs text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                        Location &ldquo;{c.location}&rdquo; removed
                      </span>
                    )}
                    {c.category && c.category !== 'other' && (c.category || '').toLowerCase().replace(/ /g, '_') !== 'preventive_maintenance' && !validCategorySlugs.some(s => s.toLowerCase() === (c.category || '').toLowerCase().replace(/ /g, '_')) && (
                      <span className="text-xs text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                        Category &ldquo;{c.category}&rdquo; removed
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-amber-400 flex-shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Search & Advanced Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm mb-4 md:mb-5">
        {/* Search Bar */}
        <div className="p-3 md:p-4 border-b border-gray-100 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder={t.cases.search}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          {/* Date filter */}
          <div className="relative">
            <button
              onClick={() => setDatePickerOpen(v => !v)}
              className={cn(
                'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors whitespace-nowrap',
                selectedMonths.size > 0
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-[var(--brand-primary)]'
              )}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              <span>{dateLabel}</span>
              {datePickerOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {datePickerOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 w-64 bg-white border border-gray-200 rounded-xl shadow-lg p-3 space-y-3 max-h-72 overflow-y-auto">
                {/* Clear */}
                <div className="flex items-center justify-between pb-1.5 border-b border-gray-100">
                  <span className="text-xs font-semibold text-gray-500">Filter by month</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        const now = new Date()
                        setSelectedMonths(new Set([monthKey(now.getFullYear(), now.getMonth())]))
                      }}
                      className="text-xs text-[var(--brand-primary)] font-medium hover:underline"
                    >
                      This Month
                    </button>
                    {selectedMonths.size > 0 && (
                      <button onClick={() => setSelectedMonths(new Set())} className="text-xs text-gray-400 hover:underline">Clear</button>
                    )}
                  </div>
                </div>
                {caseByYear.map(({ year, months }) => {
                  const yearKeys = months.map(m => m.key)
                  const allSel = yearKeys.every(k => selectedMonths.has(k))
                  return (
                    <div key={year}>
                      <button
                        onClick={() => toggleCaseYear(year)}
                        className="text-xs font-semibold text-gray-500 mb-1.5 flex items-center gap-1.5 hover:text-gray-800 transition-colors"
                      >
                        <span className={cn('w-3 h-3 rounded border flex-shrink-0 flex items-center justify-center',
                          allSel ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)]' : 'border-gray-300 bg-white'
                        )}>
                          {allSel && <svg viewBox="0 0 10 10" className="w-2 h-2"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        </span>
                        {year}
                      </button>
                      <div className="flex flex-wrap gap-1.5">
                        {months.map(m => {
                          const sel = selectedMonths.has(m.key)
                          return (
                            <button key={m.key} onClick={() => toggleCaseMonth(m.key)}
                              className={cn('px-2 py-0.5 rounded text-xs font-medium border transition-all',
                                sel ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                                    : 'bg-white text-gray-600 border-gray-200 hover:border-[var(--brand-primary)]'
                              )}>
                              {m.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap text-sm">
            <Checkbox
              checked={advancedSearchEnabled}
              onCheckedChange={(checked) => {
                setAdvancedSearchEnabled(checked as boolean)
                localStorage.setItem('kaizen-advanced-search-enabled', JSON.stringify(checked))
              }}
            />
            <span className="text-gray-600">Filter</span>
          </label>
        </div>

        {/* Advanced Filters (shown when enabled) */}
        {advancedSearchEnabled && (
          <div className="p-3 space-y-2.5">
            {/* Status Checkboxes */}
            <div>
              <p className="text-xs font-semibold text-gray-700 uppercase mb-1.5">Status</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                {STATUS_FILTERS.filter(s => s !== 'all').map((s) => (
                  <label key={s} className="flex items-center gap-1.5 cursor-pointer text-xs">
                    <Checkbox
                      checked={advFilters.statuses.includes(s as CaseStatus)}
                      onCheckedChange={(checked) => {
                        const newStatuses = checked
                          ? [...advFilters.statuses, s as CaseStatus]
                          : advFilters.statuses.filter(x => x !== s)
                        const newFilters = { ...advFilters, statuses: newStatuses }
                        setAdvFilters(newFilters)
                        localStorage.setItem('kaizen-adv-filters', JSON.stringify(newFilters))
                      }}
                    />
                    <span className="text-gray-600">{STATUS_FILTER_LABELS[s as CaseStatus] ?? STATUS_LABELS[s as CaseStatus]}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Department Checkboxes */}
            <div>
              <p className="text-xs font-semibold text-gray-700 uppercase mb-1.5">Department</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                {DEPARTMENTS.filter(d => d.value !== 'top_management').map((d) => (
                  <label key={d.value} className="flex items-center gap-1.5 cursor-pointer text-xs">
                    <Checkbox
                      checked={advFilters.departments.includes(d.value as Department)}
                      onCheckedChange={(checked) => {
                        const newDepts = checked
                          ? [...advFilters.departments, d.value as Department]
                          : advFilters.departments.filter(x => x !== d.value)
                        const newFilters = { ...advFilters, departments: newDepts }
                        setAdvFilters(newFilters)
                        localStorage.setItem('kaizen-adv-filters', JSON.stringify(newFilters))
                      }}
                    />
                    <span className="text-gray-600">{d.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Priority Checkboxes */}
            <div>
              <p className="text-xs font-semibold text-gray-700 uppercase mb-1.5">Priority</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                {(['critical', 'high', 'medium', 'low'] as CasePriority[]).map((p) => (
                  <label key={p} className="flex items-center gap-1.5 cursor-pointer text-xs">
                    <Checkbox
                      checked={advFilters.priorities.includes(p)}
                      onCheckedChange={(checked) => {
                        const newPriorities = checked
                          ? [...advFilters.priorities, p]
                          : advFilters.priorities.filter(x => x !== p)
                        const newFilters = { ...advFilters, priorities: newPriorities }
                        setAdvFilters(newFilters)
                        localStorage.setItem('kaizen-adv-filters', JSON.stringify(newFilters))
                      }}
                    />
                    <span className="text-gray-600">{PRIORITY_LABELS[p]}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Category Checkboxes */}
            <div>
              <p className="text-xs font-semibold text-gray-700 uppercase mb-1.5">Category</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                {CATEGORIES.map((c) => (
                  <label key={c} className="flex items-center gap-1.5 cursor-pointer text-xs">
                    <Checkbox
                      checked={advFilters.categories.includes(c)}
                      onCheckedChange={(checked) => {
                        const newCategories = checked
                          ? [...advFilters.categories, c]
                          : advFilters.categories.filter(x => x !== c)
                        const newFilters = { ...advFilters, categories: newCategories }
                        setAdvFilters(newFilters)
                        localStorage.setItem('kaizen-adv-filters', JSON.stringify(newFilters))
                      }}
                    />
                    <span className="text-gray-600">{CATEGORY_LABELS_EN[c]}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Clear Filters Button */}
            {(advFilters.statuses.length > 0 || advFilters.departments.length > 0 || advFilters.priorities.length > 0 || advFilters.categories.length > 0) && (
              <div className="pt-2 border-t border-gray-100">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAdvFilters({ statuses: [], departments: [], priorities: [], categories: [] })
                    localStorage.setItem('kaizen-adv-filters', JSON.stringify({ statuses: [], departments: [], priorities: [], categories: [] }))
                  }}
                  className="gap-1"
                >
                  <X className="h-3.5 w-3.5" />
                  Clear Filters
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-16 text-center">
          <div className="text-gray-300 text-5xl mb-3">📋</div>
          <p className="text-gray-500 font-medium">{t.cases.noFound}</p>
          <p className="text-gray-400 text-sm mt-1">{t.cases.adjustFilters}</p>
          <Link to="/cases/new" className="inline-block mt-4">
            <Button size="sm"><PlusCircle className="h-4 w-4" />{t.cases.newCase}</Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-5">

          {/* ── Tabs ── */}
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            {([
              { key: 'active',  label: 'Active',  count: activeCases.length,  color: 'text-gray-800' },
              { key: 'pms',     label: 'PMS',     count: pmsOpenCount,        color: 'text-sky-700' },
              { key: 'pending', label: 'Pending', count: pendingTotal,         color: 'text-amber-700' },
              { key: 'closed',  label: 'Closed',  count: closedCases.length,  color: 'text-gray-500' },
            ] as const).filter(tab => tab.key !== 'pms' || pmsEnabled).map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm font-medium transition-all',
                  activeTab === tab.key
                    ? 'bg-white shadow-sm text-gray-900'
                    : 'text-gray-500 hover:text-gray-700'
                )}
              >
                {tab.label}
                <span className={cn(
                  'text-xs font-semibold px-1.5 py-0.5 rounded-full',
                  activeTab === tab.key
                    ? tab.key === 'pending' ? 'bg-amber-100 text-amber-700' : tab.key === 'closed' ? 'bg-gray-100 text-gray-500' : tab.key === 'pms' ? 'bg-sky-100 text-sky-700' : 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                    : 'bg-gray-200 text-gray-500'
                )}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* ── Active Cases ── */}
          {activeTab === 'active' && showActive && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-gray-800">
                  Active Cases
                  <span className="ml-2 text-sm font-normal text-gray-400">{activeCases.length}</span>
                </h2>
              </div>

              {activeCases.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-10 text-center">
                  <p className="text-gray-400 text-sm">No active cases</p>
                </div>
              ) : (
                <>
                  <div className="md:hidden space-y-2">
                    {paginatedActive.map((c) => <MobileCard key={c.id} c={c} />)}
                  </div>
                  <div className="hidden md:block bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><CaseTableHeader /></thead>
                        <tbody className="divide-y divide-gray-50">
                          {paginatedActive.map((c) => <CaseRow key={c.id} c={c} />)}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <Pagination page={pageActive} totalPages={totalActivePages} total={activeCases.length}
                    onPrev={() => setPageActive(p => Math.max(1, p - 1))}
                    onNext={() => setPageActive(p => Math.min(totalActivePages, p + 1))} />
                </>
              )}
            </div>
          )}

          {/* ── PMS (preventive-maintenance tasks: active + overdue) ── */}
          {activeTab === 'pms' && (
            <div className="space-y-5">
              {/* Active PMS tasks (month-scoped) */}
              <div>
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <h2 className="text-base font-semibold text-sky-700">
                    Active PMS Cases
                    <span className="ml-2 text-sm font-normal text-sky-400">{activeTasks.length}</span>
                  </h2>
                  <div className="flex items-center gap-2">
                    {!pmsViewAll && (
                      <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-1 h-8">
                        <button onClick={() => stepPmsMonth(-1)} title="Previous month" className="p-1 rounded-md hover:bg-gray-100"><ChevronLeft className="h-4 w-4 text-gray-600" /></button>
                        <span className="min-w-[120px] text-center text-xs font-medium text-gray-700">{pmsMonthLabel}</span>
                        <button onClick={() => stepPmsMonth(1)} title="Next month" className="p-1 rounded-md hover:bg-gray-100"><ChevronRight className="h-4 w-4 text-gray-600" /></button>
                      </div>
                    )}
                    <button onClick={() => setPmsViewAll(v => !v)}
                      className={cn('h-8 px-3 rounded-lg border text-xs font-medium transition-colors', pmsViewAll ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400')}>
                      {pmsViewAll ? 'By month' : 'View all'}
                    </button>
                  </div>
                </div>
                {activeTasks.length === 0 ? (
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-8 text-center">
                    <p className="text-gray-400 text-sm">No active PMS tasks{pmsViewAll ? '' : ` in ${pmsMonthLabel}`}</p>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm divide-y divide-gray-50 overflow-hidden">
                    {activeTasks.map((t) => <PmTaskRow key={t.id} t={t} onOpen={() => setOpenTask(t)} />)}
                  </div>
                )}
              </div>

              {/* Overdue PMS tasks (always shown) */}
              {overdueTasks.length > 0 && (
                <div>
                  <h2 className="text-base font-semibold text-red-700 mb-3">
                    Overdue PMS Cases
                    <span className="ml-2 text-sm font-normal text-red-400">{overdueTasks.length}</span>
                  </h2>
                  <div className="bg-white rounded-xl border border-red-200 shadow-sm divide-y divide-gray-50 overflow-hidden">
                    {overdueTasks.map((t) => <PmTaskRow key={t.id} t={t} onOpen={() => setOpenTask(t)} />)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Pending Manager Approval ── */}
          {activeTab === 'pending' && pendingMgrCases.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-amber-700">
                  Pending Manager Approval
                  <span className="ml-2 text-sm font-normal text-amber-400">{pendingMgrCases.length}</span>
                </h2>
              </div>
              <div className="md:hidden space-y-2">
                {paginatedPendingMgr.map((c) => <MobileCard key={c.id} c={c} />)}
              </div>
              <div className="hidden md:block bg-white rounded-xl border border-amber-200 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><CaseTableHeader /></thead>
                    <tbody className="divide-y divide-gray-50">
                      {paginatedPendingMgr.map((c) => <CaseRow key={c.id} c={c} />)}
                    </tbody>
                  </table>
                </div>
              </div>
              <Pagination page={pagePendingMgr} totalPages={totalPendingMgrPages} total={pendingMgrCases.length}
                onPrev={() => setPagePendingMgr(p => Math.max(1, p - 1))}
                onNext={() => setPagePendingMgr(p => Math.min(totalPendingMgrPages, p + 1))} />
            </div>
          )}

          {/* ── Pending Top Management Approval ── */}
          {activeTab === 'pending' && pendingAdminCases.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-violet-700">
                  Pending Top Management Approval
                  <span className="ml-2 text-sm font-normal text-violet-400">{pendingAdminCases.length}</span>
                </h2>
              </div>
              <div className="md:hidden space-y-2">
                {paginatedPendingAdm.map((c) => <MobileCard key={c.id} c={c} />)}
              </div>
              <div className="hidden md:block bg-white rounded-xl border border-violet-200 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><CaseTableHeader /></thead>
                    <tbody className="divide-y divide-gray-50">
                      {paginatedPendingAdm.map((c) => <CaseRow key={c.id} c={c} />)}
                    </tbody>
                  </table>
                </div>
              </div>
              <Pagination page={pagePendingAdm} totalPages={totalPendingAdmPages} total={pendingAdminCases.length}
                onPrev={() => setPagePendingAdm(p => Math.max(1, p - 1))}
                onNext={() => setPagePendingAdm(p => Math.min(totalPendingAdmPages, p + 1))} />
            </div>
          )}

          {/* ── Pending: empty state ── */}
          {activeTab === 'pending' && pendingTotal === 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-10 text-center">
              <p className="text-gray-400 text-sm">No cases pending approval</p>
            </div>
          )}

          {/* ── Closed Cases ── */}
          {activeTab === 'closed' && showClosed && closedCases.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-gray-500">
                  Closed Cases
                  <span className="ml-2 text-sm font-normal text-gray-400">{closedCases.length}</span>
                </h2>
              </div>

              {/* Mobile */}
              <div className="md:hidden space-y-2">
                {paginatedClosed.map((c) => <MobileCard key={c.id} c={c} />)}
              </div>

              {/* Desktop */}
              <div className="hidden md:block bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden opacity-80">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><CaseTableHeader /></thead>
                    <tbody className="divide-y divide-gray-50">
                      {paginatedClosed.map((c) => <CaseRow key={c.id} c={c} />)}
                    </tbody>
                  </table>
                </div>
              </div>

              <Pagination
                page={pageClosed}
                totalPages={totalClosedPages}
                total={closedCases.length}
                onPrev={() => setPageClosed(p => Math.max(1, p - 1))}
                onNext={() => setPageClosed(p => Math.min(totalClosedPages, p + 1))}
              />
            </div>
          )}

          {activeTab === 'closed' && closedCases.length === 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-10 text-center">
              <p className="text-gray-400 text-sm">No closed cases</p>
            </div>
          )}

        </div>
      )}

      {/* PMS task run/checklist popup (same modal as the calendar) */}
      {openTask && <PMTaskModal task={openTask} onClose={() => setOpenTask(null)} onDone={() => { setOpenTask(null); loadPmTasks() }} />}
    </div>
  )
}
