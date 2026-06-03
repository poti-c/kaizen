import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { KaizenCase, Department } from '@/types'
import { DEPARTMENTS } from '@/types'

const PRIORITY_COLORS: Record<string, string> = {
  low:      'bg-green-500 text-white',
  medium:   'bg-blue-400 text-white',
  high:     'bg-orange-500 text-white',
  critical: 'bg-red-500 text-white',
}

const MONTH_NAMES_EN = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]
const MONTH_NAMES_TH = [
  'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
]
const DAY_LABELS_EN = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const DAY_LABELS_TH = ['จ','อ','พ','พฤ','ศ','ส','อา']

export function CasesCalendarPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { lang, t } = useLanguage()
  const navigate = useNavigate()
  const today = new Date()

  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [cases, setCases] = useState<KaizenCase[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [selectedCases, setSelectedCases] = useState<KaizenCase[]>([])
  const [deptFilter, setDeptFilter] = useState<Department | 'all'>(
    () => (localStorage.getItem('kaizen-default-dept') as Department | 'all') || 'all'
  )

  const MONTH_NAMES = lang === 'th' ? MONTH_NAMES_TH : MONTH_NAMES_EN
  const DAY_LABELS = lang === 'th' ? DAY_LABELS_TH : DAY_LABELS_EN

  useEffect(() => {
    if (profile && activeCompany) fetchCases()
  }, [profile, activeCompany, viewMonth, viewYear])

  async function fetchCases() {
    setLoading(true)
    const start = new Date(viewYear, viewMonth, 1).toISOString()
    const end = new Date(viewYear, viewMonth + 1, 0, 23, 59, 59).toISOString()

    let query = supabase
      .from('kaizen_cases')
      .select('*')
      .eq('company_id', activeCompany!.id)
      .gte('created_at', start)
      .lte('created_at', end)

    // Staff: own department only. Super Admin & Manager: all cases
    if (profile?.role === 'staff') {
      query = query.eq('department', profile.department)
    }

    const { data } = await query
    setCases((data || []) as KaizenCase[])
    setLoading(false)
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) }
    else setViewMonth(m => m - 1)
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) }
    else setViewMonth(m => m + 1)
  }
  function goToday() {
    setViewMonth(today.getMonth())
    setViewYear(today.getFullYear())
  }

  // Apply dept filter (client-side)
  const filteredCases = cases.filter(c => {
    if (profile?.role === 'staff') return true // staff always sees own dept (filtered server-side)
    if (deptFilter === 'all') return true
    return c.department === deptFilter
  })

  // Build calendar grid (Monday-first, like iCal)
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay() // 0=Sun
  const startOffset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate()

  type Cell = { date: Date; isCurrentMonth: boolean }
  const cells: Cell[] = []

  for (let i = startOffset - 1; i >= 0; i--) {
    cells.push({ date: new Date(viewYear, viewMonth - 1, daysInPrevMonth - i), isCurrentMonth: false })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(viewYear, viewMonth, d), isCurrentMonth: true })
  }
  const remaining = (7 - (cells.length % 7)) % 7
  for (let d = 1; d <= remaining; d++) {
    cells.push({ date: new Date(viewYear, viewMonth + 1, d), isCurrentMonth: false })
  }

  // Group cases by day key (using filtered cases)
  const casesByDate: Record<string, KaizenCase[]> = {}
  filteredCases.forEach(c => {
    const d = new Date(c.created_at)
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (!casesByDate[key]) casesByDate[key] = []
    casesByDate[key].push(c)
  })

  function cellKey(date: Date) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
  }

  function isToday(date: Date) {
    return date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
  }

  function getCaseColor(c: KaizenCase) {
    if (['closed'].includes(c.status)) return 'bg-gray-200 text-gray-400'
    return PRIORITY_COLORS[c.priority] || 'bg-gray-400 text-white'
  }

  const legend = [
    { label: t.priority.low,      color: 'bg-green-500' },
    { label: t.priority.medium,   color: 'bg-blue-400' },
    { label: t.priority.high,     color: 'bg-orange-500' },
    { label: t.priority.critical, color: 'bg-red-500' },
    { label: t.status.closed,     color: 'bg-gray-200 border border-gray-300' },
  ]

  const showDeptFilter = profile?.role === 'super_admin' || profile?.role === 'manager'

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto animate-fade-in">

      {/* Header */}
      <div className="mb-5 space-y-3">
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">
          {t.calendar.casesCalendar}
        </h1>
        {/* Controls row — single line on mobile */}
        <div className="flex items-center gap-2">
          {/* Department filter */}
          {showDeptFilter && (
            <Select value={deptFilter} onValueChange={(v) => setDeptFilter(v as Department | 'all')}>
              <SelectTrigger className="h-9 w-36 text-sm flex-shrink-0">
                <SelectValue placeholder={t.calendar.allDepts} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t.calendar.allDepts}</SelectItem>
                {DEPARTMENTS.filter(d => d.value !== 'top_management').map((d) => (
                  <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* Month navigation — centred, takes remaining space */}
          <div className="flex items-center gap-1 flex-1 justify-center">
            <button onClick={prevMonth} className="p-2 rounded-lg hover:bg-gray-100 transition-colors border border-gray-200">
              <ChevronLeft className="h-4 w-4 text-gray-600" />
            </button>
            <span className="text-sm font-semibold text-gray-900 whitespace-nowrap px-1">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <button onClick={nextMonth} className="p-2 rounded-lg hover:bg-gray-100 transition-colors border border-gray-200">
              <ChevronRight className="h-4 w-4 text-gray-600" />
            </button>
          </div>
          <button
            onClick={goToday}
            className="flex-shrink-0 px-3 py-1.5 text-sm font-medium border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            {t.calendar.today}
          </button>
        </div>
      </div>

      {/* Calendar */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {/* Day header row */}
        <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
          {DAY_LABELS.map((d, i) => (
            <div
              key={d}
              className={`py-2.5 text-xs font-semibold uppercase tracking-wider text-center ${
                i >= 5 ? 'text-blue-400' : 'text-gray-500'
              }`}
            >
              {d}
            </div>
          ))}
        </div>

        {/* Day cells */}
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-7 divide-x divide-y divide-gray-100">
            {cells.map((cell, i) => {
              const cellCases = casesByDate[cellKey(cell.date)] || []
              const today_ = isToday(cell.date)
              const isWeekend = i % 7 >= 5
              return (
                <div
                  key={i}
                  onClick={() => { const dayCases = casesByDate[cellKey(cell.date)] || []; if (dayCases.length > 0) { setSelectedDate(cell.date); setSelectedCases(dayCases) } }}
                  className={cn(
                    `min-h-[90px] md:min-h-[110px] p-1 md:p-1.5`,
                    (casesByDate[cellKey(cell.date)] || []).length > 0 ? 'cursor-pointer' : '',
                    !cell.isCurrentMonth ? 'bg-gray-50/70' : isWeekend ? 'bg-blue-50/20' : 'bg-white'
                  )}
                >
                  {/* Day number */}
                  <div className="flex justify-end mb-1">
                    <span
                      className={`text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full leading-none ${
                        today_
                          ? 'bg-[var(--brand-primary)] text-white font-bold'
                          : cell.isCurrentMonth
                          ? isWeekend ? 'text-blue-500' : 'text-gray-700'
                          : 'text-gray-300'
                      }`}
                    >
                      {cell.date.getDate()}
                    </span>
                  </div>

                  {/* Case strips */}
                  <div className="space-y-0.5">
                    {cellCases.slice(0, 3).map(c => (
                      <button
                        key={c.id}
                        onClick={() => navigate(`/cases/${c.id}`)}
                        className={`w-full text-left px-1.5 py-0.5 rounded text-[10px] font-medium truncate block leading-4 ${getCaseColor(c)} hover:opacity-75 transition-opacity`}
                        title={`${c.case_number} · ${c.title}`}
                      >
                        {c.case_number}
                      </button>
                    ))}
                    {cellCases.length > 3 && (
                      <p className="text-[10px] text-gray-400 pl-1 leading-4">
                        +{cellCases.length - 3} {t.calendar.more}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Day detail modal */}
      {selectedDate && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setSelectedDate(null)} />
          <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-50 bg-white rounded-2xl shadow-2xl max-w-md mx-auto overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">
                {selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              </h3>
              <button onClick={() => setSelectedDate(null)} className="p-1 hover:bg-gray-100 rounded-lg">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
              {selectedCases.map((c) => (
                <div key={c.id} onClick={() => { navigate(`/cases/${c.id}`); setSelectedDate(null) }}
                  className="flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 cursor-pointer">
                  <div className={cn('w-2 h-2 rounded-full flex-shrink-0', getCaseColor(c).includes('green') ? 'bg-green-500' : getCaseColor(c).includes('blue') ? 'bg-blue-400' : getCaseColor(c).includes('orange') ? 'bg-orange-500' : getCaseColor(c).includes('red') ? 'bg-red-500' : 'bg-gray-300')} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{c.title}</p>
                    <p className="text-xs text-gray-400">{c.case_number} · {c.department}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        <span className="text-xs text-gray-400 font-medium">
          {t.calendar.priorityLabel}
        </span>
        {legend.map(({ label, color }) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className={`w-3 h-2.5 rounded-sm ${color}`} />
            <span className="text-xs text-gray-500">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
