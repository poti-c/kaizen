import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link, Navigate } from 'react-router-dom'
import { ArrowLeft, User, Mail, FolderOpen, Clock, CheckCircle2, AlertTriangle, TrendingUp, CalendarDays, LogIn } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { StatusBadge, PriorityBadge } from '@/components/StatusBadge'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { getInitials, formatDateTime, isSLABreached, getSLAHours, activityLabel, companyHasFeature, companyHasAddon, bangkokDate } from '@/lib/utils'
import { loadPerfConfig, DEFAULT_PERF_CONFIG, type PerfConfig } from '@/lib/perfConfig'
import { cn } from '@/lib/utils'
import { usePresence } from '@/contexts/PresenceContext'
import { deptLabel, getEffectiveDepts } from '@/types'
import type { KaizenProfile, KaizenCase, KaizenCaseTimeline, Department } from '@/types'
import { differenceInHours } from 'date-fns'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function PerformanceDetailPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const { profile: myProfile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()

  const isStaffViewer = myProfile?.role === 'staff'
  const { isOnline } = usePresence()

  const [user, setUser] = useState<KaizenProfile | null>(null)
  const [cases, setCases] = useState<KaizenCase[]>([])            // their reported cases (KPI cards + list)
  const [scoreCases, setScoreCases] = useState<KaizenCase[]>([])  // scoring caseload (staff: own; manager: dept)
  const [reopenedIds, setReopenedIds] = useState<Set<string>>(new Set())  // scoring-caseload case ids EVER reopened (durable, from timeline)
  const [resolvedAtMap, setResolvedAtMap] = useState<Map<string, string[]>>(new Map())  // case id -> all 'resolved' timestamps sorted asc (durable; survives reopen clearing resolved_at)
  const [activity, setActivity] = useState<(KaizenCaseTimeline & { case_number?: string; case_title?: string })[]>([])
  const [activeDays, setActiveDays] = useState(0)                 // distinct active days in last 30
  const [cfg, setCfg] = useState<PerfConfig>(DEFAULT_PERF_CONFIG) // configurable indicator weights
  const [pmsValue, setPmsValue] = useState<number | null>(null)   // PMS on-time completion % (null = no relevant tasks)
  const [rrValue, setRrValue] = useState<number | null>(null)     // RR on-time fulfilment % (null = none acted on)
  const [loading, setLoading] = useState(true)
  const [openInfo, setOpenInfo] = useState<string | null>(null)  // which indicator's explainer is open

  useEffect(() => {
    if (!userId || isStaffViewer) return
    let cancelled = false
    load(() => cancelled)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, isStaffViewer, activeCompany?.id])  // re-load if the active company changes

  // Staff: no access (returned after hooks so hook order stays stable)
  if (isStaffViewer) return <Navigate to="/dashboard" replace />

  async function load(isCancelled: () => boolean) {
    setLoading(true)
    const profileRes = await supabase.from('kaizen_profiles').select('*').eq('id', userId!).single()
    if (isCancelled()) return
    const u = profileRes.data as KaizenProfile | null
    if (!u) { setLoading(false); return }
    setUser(u)

    const companyId = activeCompany?.id ?? u.company_id ?? ''
    const since30 = bangkokDate(new Date(Date.now() - 30 * 86400000))

    // Role-specific scoring caseload: managers are scored on every department they cover
    // (primary + managed_departments, PERF-001), not just their primary one; others on
    // their own work.
    const scoreCasesQuery = u.role === 'manager'
      ? supabase.from('kaizen_cases').select('*').eq('company_id', companyId).in('department', getEffectiveDepts(u)).limit(5000)
      : supabase.from('kaizen_cases').select('*').eq('company_id', companyId).or(`created_by.eq.${userId},pic_ids.cs.{${userId}}`).limit(5000)

    const [ownCasesRes, activityRes, activeDaysRes, scoreCasesRes] = await Promise.all([
      supabase.from('kaizen_cases').select('*').eq('created_by', userId!).eq('company_id', companyId).order('created_at', { ascending: false }).limit(5000),
      supabase.from('kaizen_case_timeline').select('*, case:kaizen_cases(case_number, title, company_id)').eq('performed_by', userId!).order('created_at', { ascending: false }).limit(5000),
      supabase.from('kaizen_user_activity').select('active_date').eq('user_id', userId!).gte('active_date', since30).limit(5000),
      scoreCasesQuery,
    ])
    if (isCancelled()) return
    setCases((ownCasesRes.data || []) as KaizenCase[])
    setActivity((activityRes.data || [])
      .filter((a: any) => !a.case || (a.case as any).company_id === companyId)
      .map((a: any) => ({ ...a, case_number: a.case?.case_number, case_title: a.case?.title })))
    setActiveDays((activeDaysRes.data || []).length)
    const scList = (scoreCasesRes.data || []) as KaizenCase[]
    setScoreCases(scList)

    // Durable "ever reopened" signal: count distinct scoring-caseload cases with a 'reopened'
    // timeline event. A case reopened then re-closed reverts to status 'closed', so current
    // status alone undercounts quality issues — the timeline is the source of truth.
    const scIds = scList.map(c => c.id)
    if (scIds.length) {
      // PERF-003: page the id list. A single .in() with up to 5000 ids can exceed the
      // request URL length limit; the result was destructured as `data` only, so a failed
      // request silently became "zero reopens" — inflating Quality/Leadership scores.
      // Chunk into small batches, check errors, and merge.
      const chunk = <T,>(arr: T[], n: number) => {
        const out: T[][] = []
        for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
        return out
      }
      const roIds = new Set<string>()
      const rmap = new Map<string, string[]>()
      for (const ids of chunk(scIds, 200)) {
        const { data: ro, error: roErr } = await supabase
          .from('kaizen_case_timeline').select('case_id').eq('action', 'reopened').in('case_id', ids)
        if (roErr) console.error('[PerformanceDetail] reopened lookup failed', roErr.message)
        for (const r of (ro || []) as { case_id: string }[]) roIds.add(r.case_id)

        // Durable resolution timestamps from the timeline. A reopen clears
        // kaizen_cases.resolved_at, so a case this manager approved that was later
        // reopened would otherwise vanish from the approval-speed metric. Keep the
        // 'resolved' event times per case as a fallback.
        const { data: resEv, error: resErr } = await supabase
          .from('kaizen_case_timeline').select('case_id, created_at').eq('action', 'resolved').in('case_id', ids)
        if (resErr) console.error('[PerformanceDetail] resolved lookup failed', resErr.message)
        for (const e of (resEv || []) as { case_id: string; created_at: string }[]) {
          const list = rmap.get(e.case_id) ?? []
          list.push(e.created_at)
          rmap.set(e.case_id, list)
        }
      }
      rmap.forEach((v, k) => rmap.set(k, v.sort()))
      setReopenedIds(roIds)
      setResolvedAtMap(rmap)
    } else {
      setReopenedIds(new Set())
      setResolvedAtMap(new Map())
    }

    if (isCancelled()) return

    // ── Configurable scoring: load weights + optional PMS / RR reliability ──
    const perfCfg = await loadPerfConfig(activeCompany?.id)
    if (isCancelled()) return
    setCfg(perfCfg)

    // PMS reliability: on-time completion %. Staff = own tasks; manager = dept-wide.
    // Mirrors the all-time window the scoring caseload uses.
    if (perfCfg.includePms && companyHasAddon(activeCompany, 'pms')) {
      let pmRows: { status: string; due_date: string; performed_at: string | null }[] = []
      if (u.role === 'manager') {
        const { data } = await supabase
          .from('kaizen_pm_tasks')
          .select('status, due_date, performed_at, asset:kaizen_pm_assets!inner(department)')
          .eq('company_id', companyId)
          .in('asset.department', getEffectiveDepts(u))
        pmRows = (data || []) as typeof pmRows
      } else {
        const { data } = await supabase
          .from('kaizen_pm_tasks')
          .select('status, due_date, performed_at')
          .eq('company_id', companyId)
          .or(`performed_by.eq.${userId},assigned_to.eq.${userId}`)
        pmRows = (data || []) as typeof pmRows
      }
      // Only judge tasks that have actually been completed — counting not-yet-done
      // tasks as failures would deflate the score for anyone with open work.
      const completed = pmRows.filter(r =>
        (r.status === 'done' || r.status === 'approved') && r.performed_at != null
      )
      if (completed.length) {
        const onTimeDone = completed.filter(r =>
          bangkokDate(new Date(r.performed_at!)) <= r.due_date  // due_date is a Bangkok-local date; compare in the same TZ (not UTC slice)
        ).length
        setPmsValue(Math.round((onTimeDone / completed.length) * 100))
      } else {
        setPmsValue(null)
      }
    } else {
      setPmsValue(null)
    }

    // RR reliability: on-time fulfilment %. Staff = orders this user acted on;
    // manager = dept-wide orders (request or fulfill department).
    if (perfCfg.includeRr && companyHasAddon(activeCompany, 'routine_roster')) {
      let rrRows: { status: string; due_at: string | null; delivered_at: string | null; confirmed_at: string | null }[] = []
      const rrSel = 'status, due_at, delivered_at, confirmed_at'
      if (u.role === 'manager') {
        // PERF-001: score every department the manager covers (primary + managed), and
        // filter client-side — a raw .or() over custom dept LABELS would break on labels
        // containing commas/parens. RLS already scopes to the company.
        const depts = getEffectiveDepts(u)
        const { data } = await supabase
          .from('kaizen_rr_orders')
          .select(rrSel + ', request_department, fulfill_department')
          .eq('company_id', companyId)
          .neq('status', 'cancelled')
        rrRows = ((data ?? []) as unknown as Array<typeof rrRows[number] & { request_department: Department; fulfill_department: Department }>)
          .filter(o => depts.includes(o.request_department) || depts.includes(o.fulfill_department))
      } else {
        const { data } = await supabase
          .from('kaizen_rr_orders')
          .select(rrSel)
          .eq('company_id', companyId)
          .neq('status', 'cancelled')
          .or(`sent_by.eq.${userId},accepted_by.eq.${userId},delivered_by.eq.${userId},confirmed_by.eq.${userId}`)
        rrRows = (data || []) as typeof rrRows
      }
      // Denominator = only orders that reached a fulfilled state with a due time
      // (the population that can be judged on-time vs late). In-flight orders and
      // delivered-without-due rows can't be late, so they must not count as misses.
      const judged = rrRows.filter(r =>
        (r.status === 'delivered' || r.status === 'confirmed') && !!r.due_at && !!(r.confirmed_at ?? r.delivered_at)
      )
      if (judged.length) {
        const onTime = judged.filter(r => {
          const ts = (r.confirmed_at ?? r.delivered_at)!
          return new Date(ts).getTime() <= new Date(r.due_at!).getTime()
        }).length
        setRrValue(Math.round((onTime / judged.length) * 100))
      } else {
        setRrValue(null)
      }
    } else {
      setRrValue(null)
    }

    setLoading(false)
  }

  // ── KPIs ──
  const totalCases = cases.length
  const closedCases = cases.filter((c) => c.status === 'closed')
  const resolutionRate = totalCases > 0 ? Math.round((closedCases.length / totalCases) * 100) : 0
  const overdueCases = cases.filter((c) => isSLABreached(c))
  const avgResolutionHours = (() => {
    const timed = closedCases.filter(c => c.closed_at != null)
    return timed.length > 0 ? timed.reduce((sum, c) => sum + differenceInHours(new Date(c.closed_at!), new Date(c.created_at)), 0) / timed.length : null
  })()

  function formatRes(h: number | null) {
    if (h === null) return '—'
    if (h < 24) return `${Math.round(h)}h`
    return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`
  }

  // Anchor "now" to the Bangkok calendar so month bucketing matches the hotel's
  // timezone for every viewer (cases bucket by bangkokDate(created_at) below).
  const [bkkY, bkkM] = bangkokDate().split('-').map(Number) // bkkM is 1-based
  const thisMonthKey = `${bkkY}-${String(bkkM).padStart(2, '0')}`
  const casesThisMonth = cases.filter((c) => bangkokDate(new Date(c.created_at)).slice(0, 7) === thisMonthKey).length

  // Key buckets by YEAR-month (Bangkok) so same-month cases from prior years don't pile
  // into the visible bucket (cases is fetched all-time). Display label stays the month name.
  const ym = (d: Date) => bangkokDate(d).slice(0, 7)
  const months = Array.from({ length: 6 }, (_, i) => {
    let mY = bkkY; let mM = bkkM - 5 + i
    while (mM < 1) { mM += 12; mY-- }
    while (mM > 12) { mM -= 12; mY++ }
    return { key: `${mY}-${String(mM).padStart(2, '0')}`, label: MONTH_SHORT[mM - 1] }
  })
  const monthMap: Record<string, number> = {}
  months.forEach(({ key }) => { monthMap[key] = 0 })
  cases.forEach((c) => {
    const key = ym(new Date(c.created_at))
    if (key in monthMap) monthMap[key]++
  })
  const monthlyData = months.map(({ key, label }) => ({ month: label, count: monthMap[key] }))

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!user) return <div className="p-6 text-center text-gray-400">{t.caseDetail.notFound}</div>

  // Access control (after user loaded)
  if (myProfile?.role === 'super_admin' && user.role === 'super_admin' && userId !== myProfile.id) {
    return <Navigate to="/performance" replace />
  }
  if (myProfile?.role === 'manager') {
    const isHR = myProfile.department === 'human_resource'
    const canView = userId === myProfile.id ||
      (isHR ? user.role === 'manager' || user.role === 'staff'
            : user.role === 'staff' && user.department === myProfile.department)
    if (!canView) return <Navigate to="/performance" replace />
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto animate-fade-in space-y-5">
      {/* Back */}
      <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" />
      </Button>

      {/* Profile card */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-center gap-4">
          <Avatar className="h-14 w-14 flex-shrink-0">
            {user.avatar_url && <AvatarImage src={user.avatar_url} alt={user.full_name} className="object-cover" />}
            <AvatarFallback className="text-lg font-semibold">{getInitials(user.full_name)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-gray-900">{user.full_name}</h1>
            {user.position && <p className="text-sm font-medium text-gray-700">{user.position}</p>}
            <p className="text-sm text-gray-500">{t.roles[user.role]} · {deptLabel(user.department, lang)}</p>
            {!user.is_active && <span className="text-xs text-red-500 font-medium">{t.users.inactive}</span>}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-gray-600">
          {user.email && (
            <span className="flex items-center gap-2"><Mail className="h-4 w-4 text-gray-400 flex-shrink-0" />{user.email}</span>
          )}
          {user.username && (
            <span className="flex items-center gap-2"><User className="h-4 w-4 text-gray-400 flex-shrink-0" />@{user.username}</span>
          )}
          <span className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-gray-400 flex-shrink-0" />
            {lang === 'th' ? 'เริ่มงาน' : 'Joined'}: {new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(user.created_at))}
          </span>
          {/* Last active (with real-time online indicator) */}
          <span className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full flex-shrink-0', isOnline(user.id) ? 'bg-green-500' : 'bg-gray-300')} />
            <span className={isOnline(user.id) ? 'text-green-600 font-medium' : ''}>
              {lang === 'th' ? 'ใช้งานล่าสุด' : 'Last active'}: {activityLabel(user.last_active_at, isOnline(user.id))}
            </span>
          </span>
          {/* Last login */}
          <span className="flex items-center gap-2">
            <LogIn className="h-4 w-4 text-gray-400 flex-shrink-0" />
            {lang === 'th' ? 'เข้าระบบล่าสุด' : 'Last login'}: {user.last_login_at ? formatDateTime(user.last_login_at) : (lang === 'th' ? 'ไม่เคย' : 'Never')}
          </span>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center"><FolderOpen className="h-3.5 w-3.5 text-blue-600" /></div>
            <p className="text-xs font-medium text-gray-500">{lang === 'th' ? 'เคสที่รายงาน' : 'Cases Reported'}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{totalCases}</p>
          <p className="text-xs text-gray-400 mt-0.5">{lang === 'th' ? `${casesThisMonth} เดือนนี้` : `${casesThisMonth} this month`}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-green-50 flex items-center justify-center"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /></div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.resolutionRate}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{resolutionRate}%</p>
          <p className="text-xs text-gray-400 mt-0.5">{closedCases.length} {lang === 'th' ? 'ปิดแล้ว' : 'closed'}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-purple-50 flex items-center justify-center"><Clock className="h-3.5 w-3.5 text-purple-600" /></div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.avgResolution}</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatRes(avgResolutionHours)}</p>
          <p className="text-xs text-gray-400 mt-0.5">{lang === 'th' ? 'เวลาเฉลี่ย' : 'avg. time'}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-red-50 flex items-center justify-center"><AlertTriangle className="h-3.5 w-3.5 text-red-600" /></div>
            <p className="text-xs font-medium text-gray-500">{t.dashboard.overdueSLA}</p>
          </div>
          <p className={`text-2xl font-bold ${overdueCases.length > 0 ? 'text-red-600' : 'text-gray-900'}`}>{overdueCases.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">{lang === 'th' ? 'เกินกำหนด' : 'overdue now'}</p>
        </div>
      </div>

      {/* Overall Performance Score — role-specific (manager vs staff) with click-to-explain indicators */}
      {(() => {
        const sc = scoreCases
        const scClosed = sc.filter(c => c.status === 'closed')
        // PERF-002: judge a CLOSED case against the same source of truth as isSLABreached —
        // honour an explicit due_date when set, otherwise the priority SLA from creation —
        // instead of a second hardcoded table that ignored the agreed deadline.
        const wasClosedLate = (c: KaizenCase) => {
          if (c.status !== 'closed' || !c.closed_at) return false
          if (c.due_date) {
            const raw = String(c.due_date)
            const due = new Date(raw.length <= 10 ? `${raw}T23:59:59` : raw)
            if (!isNaN(due.getTime())) return new Date(c.closed_at) > due
          }
          return differenceInHours(new Date(c.closed_at), new Date(c.created_at)) > getSLAHours(c.priority)
        }
        const scOverdue = sc.filter(c => isSLABreached(c) || wasClosedLate(c))
        const reopenedCount = sc.filter(c => reopenedIds.has(c.id)).length  // distinct cases ever reopened (durable)
        // Cases that ever reached a resolution. A reopened case has resolved_at cleared, so
        // include it via the durable reopen set — otherwise the quality denominator can be
        // smaller than reopenedCount and the score breaks.
        const completedEver = sc.filter(c => c.resolved_at != null || reopenedIds.has(c.id)).length

        // Shared engagement: 50% active-days regularity (15 days = full), 50% in-system actions (20 = full)
        const activeDaysScore = Math.min(100, Math.round((activeDays / 15) * 100))
        // PERF-004: compare on a real instant — a.created_at is a full ISO timestamp, so a
        // lexical compare against a bare 'YYYY-MM-DD' cut at UTC midnight (07:00 Bangkok).
        const activity30Cnt = activity.filter(a => bangkokDate(new Date(a.created_at)) >= since30).length
        const actionsScore = Math.min(100, Math.round((activity30Cnt / 20) * 100))
        const engagementScore = Math.round(activeDaysScore * 0.5 + actionsScore * 0.5)
        const engagementNote = `${activeDays} ${activeDays === 1 ? t.perf.activeDay : t.perf.activeDays} · ${activity30Cnt} ${t.perf.actions}`

        type Crit = { key: string; label: string; value: number | null; weight: number; color: string; note: string; info: string }
        let criteria: Crit[]

        if (user.role === 'manager') {
          // Use a durable resolution timestamp (case row, else the timeline) so a
          // case this manager approved still counts after it was reopened (which
          // clears resolved_at). Without this the approval sample silently shrinks.
          const resolvedTs = (c: KaizenCase) => {
            if (c.resolved_at) return c.resolved_at
            const tsList = resolvedAtMap.get(c.id)
            if (!tsList?.length) return null
            // Pick the latest resolved event that is at or before manager_approved_at so a
            // case that was approved then reopened and re-resolved doesn't produce a negative
            // approval lag and get silently dropped from the approval-speed metric.
            if (c.manager_approved_at) {
              const before = tsList.filter(ts => ts <= c.manager_approved_at!)
              return before.length ? before[before.length - 1] : null
            }
            return tsList[tsList.length - 1]
          }
          const approved = sc.filter(c =>
            c.manager_approved_by === userId && c.manager_approved_at && resolvedTs(c) &&
            differenceInHours(new Date(c.manager_approved_at), new Date(resolvedTs(c)!)) >= 0
          )
          const avgApprovalH = approved.length
            ? approved.reduce((s, c) => s + differenceInHours(new Date(c.manager_approved_at!), new Date(resolvedTs(c)!)), 0) / approved.length
            : null
          const approvalScore = avgApprovalH == null ? null : avgApprovalH <= 24 ? 100 : Math.max(0, Math.round((24 / avgApprovalH) * 100))
          const teamTotal = sc.length
          const teamResRate = teamTotal ? Math.round((scClosed.length / teamTotal) * 100) : null
          const teamSlaScore = teamTotal ? Math.round(((teamTotal - scOverdue.length) / teamTotal) * 100) : null
          const reopenRate = teamTotal ? (reopenedCount / teamTotal) * 100 : 0
          const overdueRate = teamTotal ? (scOverdue.length / teamTotal) * 100 : 0
          const leadershipScore = teamTotal ? Math.round(((100 - reopenRate) + (100 - overdueRate)) / 2) : null
          criteria = [
            { key: 'approval', label: t.perf.approval, value: approvalScore, weight: cfg.manager.approval, color: '#3b82f6', note: approved.length ? `~${formatRes(avgApprovalH)} ${t.perf.avg}` : t.perf.noApprovals, info: t.perf.approvalInfo },
            { key: 'teamres', label: t.perf.teamRes, value: teamResRate, weight: cfg.manager.teamres, color: '#22c55e', note: `${scClosed.length}/${teamTotal} ${t.perf.closed}`, info: t.perf.teamResInfo },
            { key: 'teamsla', label: t.perf.teamSla, value: teamSlaScore, weight: cfg.manager.teamsla, color: '#0ea5e9', note: `${scOverdue.length} ${t.perf.overdue}`, info: t.perf.teamSlaInfo },
            { key: 'leadership', label: t.perf.leadership, value: leadershipScore, weight: cfg.manager.leadership, color: '#a855f7', note: `${reopenedCount} ${t.perf.reopened}`, info: t.perf.leadershipInfo },
            { key: 'engagement', label: t.perf.oversight, value: engagementScore, weight: cfg.manager.oversight, color: '#f59e0b', note: engagementNote, info: t.perf.oversightInfo },
          ]
          if (cfg.includePms && companyHasAddon(activeCompany, 'pms')) {
            criteria.push({ key: 'pms', label: t.perf.pmsScore, value: pmsValue, weight: cfg.manager.pms, color: '#14b8a6', note: '', info: t.perf.pmsScoreInfo })
          }
          if (cfg.includeRr && companyHasAddon(activeCompany, 'routine_roster')) {
            criteria.push({ key: 'rr', label: t.perf.rrScore, value: rrValue, weight: cfg.manager.rr, color: '#f97316', note: '', info: t.perf.rrScoreInfo })
          }
        } else {
          const total = sc.length
          const resRate = total ? Math.round((scClosed.length / total) * 100) : null
          const onTime = total ? Math.round(((total - scOverdue.length) / total) * 100) : null
          const avgResH = (() => {
            const timed = scClosed.filter(c => c.closed_at != null)
            return timed.length > 0 ? timed.reduce((s, c) => s + differenceInHours(new Date(c.closed_at!), new Date(c.created_at)), 0) / timed.length : null
          })()
          const speedScore = avgResH == null ? null : avgResH <= 48 ? 100 : Math.max(0, Math.round((48 / avgResH) * 100))
          // Quality = share of completed work that did NOT bounce back (ever reopened).
          const qualityScore = completedEver ? Math.max(0, Math.round(100 - (reopenedCount / completedEver) * 100)) : null
          criteria = [
            { key: 'resolution', label: t.perf.resolutionRate, value: resRate, weight: cfg.staff.resolution, color: '#22c55e', note: `${scClosed.length}/${total} ${t.perf.closed}`, info: t.perf.resolutionRateInfo },
            { key: 'ontime', label: t.perf.onTime, value: onTime, weight: cfg.staff.ontime, color: '#3b82f6', note: `${scOverdue.length} ${t.perf.overdue}`, info: t.perf.onTimeInfo },
            { key: 'speed', label: t.perf.speed, value: speedScore, weight: cfg.staff.speed, color: '#0ea5e9', note: avgResH != null ? `${formatRes(avgResH)} ${t.perf.avg}` : t.perf.noClosed, info: t.perf.speedInfo },
            { key: 'quality', label: t.perf.quality, value: qualityScore, weight: cfg.staff.quality, color: '#a855f7', note: `${reopenedCount} ${t.perf.reopened}`, info: t.perf.qualityInfo },
            { key: 'engagement', label: t.perf.engagement, value: engagementScore, weight: cfg.staff.engagement, color: '#f59e0b', note: engagementNote, info: t.perf.engagementInfo },
          ]
          if (cfg.includePms && companyHasAddon(activeCompany, 'pms')) {
            criteria.push({ key: 'pms', label: t.perf.pmsScore, value: pmsValue, weight: cfg.staff.pms, color: '#14b8a6', note: '', info: t.perf.pmsScoreInfo })
          }
          if (cfg.includeRr && companyHasAddon(activeCompany, 'routine_roster')) {
            criteria.push({ key: 'rr', label: t.perf.rrScore, value: rrValue, weight: cfg.staff.rr, color: '#f97316', note: '', info: t.perf.rrScoreInfo })
          }
        }

        const scored = criteria.filter(c => c.value != null)
        const weightSum = scored.reduce((s, c) => s + c.weight, 0)
        const overall = weightSum ? Math.round(scored.reduce((s, c) => s + (c.value! * c.weight), 0) / weightSum) : 0
        const tier = overall >= 85
          ? { label: lang === 'th' ? 'ดีเยี่ยม' : 'Excellent', color: '#22c55e', bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' }
          : overall >= 70
          ? { label: lang === 'th' ? 'ดี' : 'Good', color: '#3b82f6', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' }
          : overall >= 50
          ? { label: lang === 'th' ? 'ปานกลาง' : 'Fair', color: '#f59e0b', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' }
          : { label: lang === 'th' ? 'ต้องปรับปรุง' : 'Needs Attention', color: '#ef4444', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' }

        return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="flex items-center gap-3 mb-1">
              <div className="flex items-center gap-2 flex-1">
                <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" />
                <h3 className="font-semibold text-sm text-gray-900">{t.perf.overallTitle}</h3>
              </div>
              <span className={`px-3 py-1 rounded-full text-sm font-bold border ${tier.bg} ${tier.text} ${tier.border}`}>{tier.label}</span>
            </div>
            <p className="text-[11px] text-gray-400 mb-4">{user.role === 'manager' ? t.perf.leadershipCard : t.perf.staffCard} · {t.perf.tapHint}</p>
            <div className="flex items-center gap-4 mb-5">
              <div className="relative flex-shrink-0 w-16 h-16">
                <svg className="w-16 h-16 -rotate-90" viewBox="0 0 56 56">
                  <circle cx="28" cy="28" r="22" fill="none" stroke="#f3f4f6" strokeWidth="6" />
                  <circle cx="28" cy="28" r="22" fill="none" stroke={tier.color} strokeWidth="6" strokeDasharray={`${(overall / 100) * 138.2} 138.2`} strokeLinecap="round" />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center"><span className="text-lg font-bold text-gray-900">{overall}</span></div>
              </div>
              <div className="flex-1">
                <p className="text-xs text-gray-400 mb-1">{t.perf.scoreOutOf}</p>
                <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${overall}%`, backgroundColor: tier.color }} />
                </div>
              </div>
            </div>
            <div className="space-y-3 border-t border-gray-100 pt-4">
              {criteria.map((c) => (
                <div key={c.key}>
                  <button type="button" onClick={() => setOpenInfo(openInfo === c.key ? null : c.key)} className="w-full text-left group">
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-xs font-medium text-gray-700 flex items-center gap-1.5">
                        {c.label}
                        <span className="text-[9px] text-gray-400 font-normal">{c.weight}%</span>
                        <span className="text-gray-300 group-hover:text-[var(--brand-primary)] text-[11px]">ⓘ</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-400">{c.note}</span>
                        <span className="text-xs font-bold" style={{ color: c.value == null ? '#9ca3af' : c.color }}>{c.value == null ? '—' : `${c.value}%`}</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${c.value ?? 0}%`, backgroundColor: c.color }} />
                    </div>
                  </button>
                  {openInfo === c.key && (
                    <div className="mt-2 text-[11px] leading-relaxed text-gray-600 bg-gray-50 border border-gray-100 rounded-lg p-2.5">
                      <span className="font-semibold text-gray-700">{t.perf.weight} {c.weight}%. </span>{c.info}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Monthly trend */}
      {totalCases > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <h3 className="font-semibold text-sm text-gray-900 mb-3">{lang === 'th' ? 'เคสรายเดือน (6 เดือนล่าสุด)' : 'Monthly Cases (last 6 months)'}</h3>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={monthlyData} margin={{ top: 0, right: 0, left: -28, bottom: 0 }}>
              <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v: number) => [v, lang === 'th' ? 'เคส' : 'Cases']} />
              <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={32}>
                {monthlyData.map((_, i) => <Cell key={i} fill="var(--brand-primary)" fillOpacity={i === 5 ? 1 : 0.45} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Cases reported */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-900">{lang === 'th' ? 'เคสที่รายงาน' : 'Cases Reported'}</h3>
          <span className="text-xs text-gray-400">{totalCases}</span>
        </div>
        {cases.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-400 text-center">{lang === 'th' ? 'ยังไม่มีเคส' : 'No cases yet'}</p>
        ) : (
          <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
            {cases.map((c) => (
              <Link key={c.id} to={`/cases/${c.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-xs font-mono text-gray-400 whitespace-nowrap">{c.case_number}</span>
                    <StatusBadge status={c.status} />
                    <PriorityBadge priority={c.priority} />
                  </div>
                  <p className="text-sm font-medium text-gray-900 truncate">{c.title}</p>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">{new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short' }).format(new Date(c.created_at))}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Recent activity */}
      {companyHasFeature(activeCompany, 'activity_log') && (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-900">{lang === 'th' ? 'กิจกรรมล่าสุด' : 'Recent Activity'}</h3>
          <span className="text-xs text-gray-400">{activity.length}</span>
        </div>
        {activity.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-400 text-center">{t.caseDetail.noActivity}</p>
        ) : (
          <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
            {activity.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-5 py-3">
                <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)] mt-1.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{a.action.replace(/_/g, ' ')}</p>
                  {a.case_number && (
                    <Link to={`/cases/${a.case_id}`} className="text-xs text-[var(--brand-primary)] hover:underline">{a.case_number} · {a.case_title}</Link>
                  )}
                  {a.description && <p className="text-xs text-gray-500 mt-0.5">{a.description}</p>}
                  <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(a.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  )
}
