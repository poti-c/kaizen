import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PlusCircle, Search, Filter, Clock, ChevronRight, Download, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { StatusBadge, PriorityBadge, DepartmentBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatRelativeTime, formatDuration, isSLABreached, CATEGORIES } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { KaizenCase, CaseStatus, CasePriority } from '@/types'
import { STATUS_LABELS, PRIORITY_LABELS } from '@/types'

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

export function CasesPage() {
  const { profile } = useAuth()
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

  useEffect(() => {
    if (profile) fetchCases()
  }, [profile])

  useEffect(() => {
    let result = cases
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((c) =>
        c.title.toLowerCase().includes(q) ||
        c.case_number.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      )
    }
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
    setFiltered(result)
    setPageActive(1)
    setPageClosed(1)
  }, [cases, search, statusFilter, groupFilter, priorityFilter, categoryFilter])

  async function fetchCases() {
    if (!profile) return
    setLoading(true)

    let query = supabase
      .from('kaizen_cases')
      .select('*, creator:kaizen_profiles!kaizen_cases_created_by_fkey(id, full_name, department)')
      .order('created_at', { ascending: false })

    if (profile.role === 'staff') {
      query = query.eq('department', profile.department)
    } else if (profile.role === 'manager') {
      query = query.or(`department.eq.${profile.department},assigned_departments.cs.{${profile.department}}`)
    }

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

  // Split into active and closed
  const activeCases = sortCases(filtered.filter(c => c.status !== 'closed'))
  const closedCases = sortCases(filtered.filter(c => c.status === 'closed'))

  const totalActivePages = Math.ceil(activeCases.length / PAGE_SIZE)
  const totalClosedPages = Math.ceil(closedCases.length / PAGE_SIZE)
  const paginatedActive = activeCases.slice((pageActive - 1) * PAGE_SIZE, pageActive * PAGE_SIZE)
  const paginatedClosed = closedCases.slice((pageClosed - 1) * PAGE_SIZE, pageClosed * PAGE_SIZE)

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

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 md:p-4 mb-4 md:mb-5 space-y-2 md:space-y-0 md:flex md:flex-wrap md:gap-3">
        <div className="relative flex-1 md:min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder={t.cases.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as CaseStatus | 'all')}>
            <SelectTrigger className="flex-1 md:w-52">
              <Filter className="h-4 w-4 text-gray-400 mr-1 flex-shrink-0" />
              <SelectValue placeholder={t.cases.allStatuses} />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'all' ? t.cases.allStatuses : (STATUS_FILTER_LABELS[s] ?? STATUS_LABELS[s as CaseStatus])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v as CasePriority | 'all')}>
            <SelectTrigger className="flex-1 md:w-40">
              <SelectValue placeholder={t.cases.allPriorities} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t.cases.allPriorities}</SelectItem>
              {(['critical', 'high', 'medium', 'low'] as CasePriority[]).map((p) => (
                <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v)}>
            <SelectTrigger className="flex-1 md:w-44">
              <SelectValue placeholder={t.cases.allCategories} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t.cases.allCategories}</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>{CATEGORY_LABELS_EN[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
        <div className="space-y-8">

          {/* ── Active Cases ── */}
          {showActive && (
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
                  {/* Mobile */}
                  <div className="md:hidden space-y-2">
                    {paginatedActive.map((c) => <MobileCard key={c.id} c={c} />)}
                  </div>

                  {/* Desktop */}
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

                  <Pagination
                    page={pageActive}
                    totalPages={totalActivePages}
                    total={activeCases.length}
                    onPrev={() => setPageActive(p => Math.max(1, p - 1))}
                    onNext={() => setPageActive(p => Math.min(totalActivePages, p + 1))}
                  />
                </>
              )}
            </div>
          )}

          {/* ── Closed Cases ── */}
          {showClosed && closedCases.length > 0 && (
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

        </div>
      )}
    </div>
  )
}
