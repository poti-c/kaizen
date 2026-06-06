import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Wrench, ChevronRight, ShieldCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { assetStatus } from '@/lib/pm'

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface AssetRow { next_maintenance_date: string | null; is_active: boolean; department: string | null }
interface TaskRow { due_date: string; status: string; performed_at: string | null; asset?: { department: string | null } | null }

export function PMSummaryCard() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t } = useLanguage()
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
    return <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 mb-4 h-20 animate-pulse" />
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
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5 text-[var(--brand-primary)]" />{t.nav.maintenance}</h2>
        <Link to="/maintenance" className="flex items-center gap-0.5 text-xs font-medium text-[var(--brand-primary)] hover:opacity-75">{t.pm.open}<ChevronRight className="h-3.5 w-3.5" /></Link>
      </div>

      {active.length === 0 ? (
        <div className="text-center py-3">
          <p className="text-xs text-gray-500">{t.pm.noAssets} <Link to="/maintenance" className="font-medium text-[var(--brand-primary)]">{t.pm.setupScheduler}</Link></p>
        </div>
      ) : (
        <div className="flex items-stretch gap-2">
          {/* Compliance hero */}
          <Link to="/maintenance" className="flex flex-col items-center justify-center rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors px-3 py-1.5 w-24 flex-shrink-0">
            <p className={`text-2xl font-bold leading-none ${complianceColor}`}>{compliance == null ? '—' : `${compliance}%`}</p>
            <p className="text-[10px] text-gray-500 mt-0.5 text-center leading-tight flex items-center gap-0.5"><ShieldCheck className={`h-3 w-3 ${complianceColor}`} />{t.pm.compliance}</p>
          </Link>

          {/* Stats grid */}
          <div className="flex-1 grid grid-cols-3 auto-rows-fr gap-1.5">
            <Tile label={t.pm.good} value={good} tone="green" to="/maintenance?status=good" />
            <Tile label={t.pm.dueSoon} value={dueSoon} tone="amber" to="/maintenance?status=due_soon" />
            <Tile label={t.pm.overdue} value={overdueAssets} tone="red" to="/maintenance?status=overdue" />
            <Tile label={t.pm.dueThisWeek} value={dueThisWeek} tone="slate" to="/cases/calendar?tab=pm" />
            <Tile label={t.pm.doneThisMonth} value={completedThisMonth} tone="slate" to="/cases/calendar?tab=pm" />
            {isApprover
              ? <Tile label={t.pm.awaitingApproval} value={pendingApproval} tone={pendingApproval > 0 ? 'violet' : 'slate'} to="/cases/calendar?tab=pm" />
              : <Tile label={t.pm.onTimeRate} value={onTimeRate == null ? '—' : `${onTimeRate}%`} tone="slate" />}
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

function Tile({ label, value, tone, to }: { label: string; value: number | string; tone: string; to?: string }) {
  const inner = (
    <>
      <p className="text-base font-bold leading-none">{value}</p>
      <p className="text-[10px] mt-0.5 opacity-80 leading-tight">{label}</p>
    </>
  )
  const cls = `flex flex-col justify-center h-full rounded-md px-2 py-1 ${TONES[tone]}`
  return to
    ? <Link to={to} className={`${cls} hover:brightness-95 transition-all`}>{inner}</Link>
    : <div className={cls}>{inner}</div>
}
