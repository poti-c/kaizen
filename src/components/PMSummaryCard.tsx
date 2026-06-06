import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Wrench, ChevronRight, ShieldCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { assetStatus } from '@/lib/pm'

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface AssetRow { next_maintenance_date: string | null; is_active: boolean; department: string | null }
interface TaskRow { due_date: string; status: string; performed_at: string | null; asset?: { department: string | null } | null }

export function PMSummaryCard() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const companyId = activeCompany?.id ?? null
  const isStaff = profile?.role === 'staff'
  const isApprover = profile?.role === 'super_admin' || profile?.role === 'manager'

  const [loading, setLoading] = useState(true)
  const [assets, setAssets] = useState<AssetRow[]>([])
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [dueSoonDays, setDueSoonDays] = useState(7)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const from = isoDate(new Date(Date.now() - 95 * 86400000))
      const to = isoDate(new Date(Date.now() + 35 * 86400000))
      const [a, tk, s] = await Promise.all([
        supabase.from('kaizen_pm_assets').select('next_maintenance_date, is_active, department').eq('company_id', companyId),
        supabase.from('kaizen_pm_tasks').select('due_date, status, performed_at, asset:kaizen_pm_assets(department)').eq('company_id', companyId).gte('due_date', from).lte('due_date', to),
        supabase.from('kaizen_pm_settings').select('due_soon_days').eq('company_id', companyId).maybeSingle(),
      ])
      if (cancelled) return
      let aRows = (a.data as AssetRow[]) ?? []
      let tRows = (tk.data as unknown as TaskRow[]) ?? []
      // Staff see only their department's slice.
      if (isStaff && profile?.department) {
        aRows = aRows.filter(r => r.department === profile.department)
        tRows = tRows.filter(r => r.asset?.department === profile.department)
      }
      setAssets(aRows); setTasks(tRows)
      if (s.data?.due_soon_days != null) setDueSoonDays(s.data.due_soon_days)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [companyId, isStaff, profile?.department])

  if (loading) {
    return <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-6 h-28 animate-pulse" />
  }

  const active = assets.filter(a => a.is_active)
  let good = 0, dueSoon = 0, overdueAssets = 0
  for (const a of active) {
    const s = assetStatus(a.next_maintenance_date, a.is_active, dueSoonDays)
    if (s === 'good') good++
    else if (s === 'due_soon') dueSoon++
    else if (s === 'overdue') overdueAssets++
  }
  const scheduled = good + dueSoon + overdueAssets
  const compliance = scheduled === 0 ? null : Math.round(((scheduled - overdueAssets) / scheduled) * 100)

  const todayKey = isoDate(new Date())
  const weekKey = isoDate(new Date(Date.now() + dueSoonDays * 86400000))
  const open = (s: string) => s === 'scheduled' || s === 'in_progress'
  const dueThisWeek = tasks.filter(t => open(t.status) && t.due_date >= todayKey && t.due_date <= weekKey).length
  const completedTasks = tasks.filter(t => t.status === 'done' || t.status === 'approved')
  const monthPrefix = todayKey.slice(0, 7)
  const completedThisMonth = completedTasks.filter(t => t.performed_at && t.performed_at.slice(0, 7) === monthPrefix).length
  const onTime = completedTasks.filter(t => t.performed_at && isoDate(new Date(t.performed_at)) <= t.due_date).length
  const onTimeRate = completedTasks.length === 0 ? null : Math.round((onTime / completedTasks.length) * 100)
  const pendingApproval = tasks.filter(t => t.status === 'pending_approval').length

  const complianceColor = compliance == null ? 'text-gray-400' : compliance >= 90 ? 'text-green-600' : compliance >= 70 ? 'text-amber-600' : 'text-red-600'

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-gray-900 flex items-center gap-2"><Wrench className="h-4 w-4 text-[var(--brand-primary)]" />Preventive Maintenance</h2>
        <Link to="/maintenance" className="flex items-center gap-0.5 text-xs font-medium text-[var(--brand-primary)] hover:opacity-75">Open<ChevronRight className="h-3.5 w-3.5" /></Link>
      </div>

      {active.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500">No assets registered yet.</p>
          <Link to="/maintenance" className="text-sm font-medium text-[var(--brand-primary)]">Set up your maintenance schedule →</Link>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row items-stretch gap-4">
          {/* Compliance hero */}
          <Link to="/maintenance" className="flex sm:flex-col items-center justify-center gap-2 sm:gap-1 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors px-4 py-3 sm:w-40 flex-shrink-0">
            <ShieldCheck className={`h-6 w-6 ${complianceColor}`} />
            <div className="text-center">
              <p className={`text-3xl font-bold leading-none ${complianceColor}`}>{compliance == null ? '—' : `${compliance}%`}</p>
              <p className="text-[11px] text-gray-500 mt-1">On-schedule compliance</p>
            </div>
          </Link>

          {/* Stats grid */}
          <div className="flex-1 grid grid-cols-3 gap-2">
            <Tile label="Up to date" value={good} tone="green" />
            <Tile label="Due soon" value={dueSoon} tone="amber" />
            <Tile label="Overdue" value={overdueAssets} tone="red" />
            <Tile label="Due this week" value={dueThisWeek} tone="slate" />
            <Tile label="Done this month" value={completedThisMonth} tone="slate" />
            {isApprover
              ? <Tile label="Awaiting approval" value={pendingApproval} tone={pendingApproval > 0 ? 'violet' : 'slate'} />
              : <Tile label="On-time rate" value={onTimeRate == null ? '—' : `${onTimeRate}%`} tone="slate" />}
          </div>
        </div>
      )}
    </div>
  )
}

const TONES: Record<string, string> = {
  green: 'bg-green-50 text-green-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  violet: 'bg-violet-50 text-violet-700',
  slate: 'bg-gray-50 text-gray-700',
}

function Tile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className={`rounded-lg px-3 py-2 ${TONES[tone]}`}>
      <p className="text-xl font-bold leading-none">{value}</p>
      <p className="text-[11px] mt-1 opacity-80">{label}</p>
    </div>
  )
}
