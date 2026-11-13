import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ChevronDown, Hotel, LayoutDashboard, Settings, X } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts'
import { differenceInHours } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { bangkokDate, isSLABreached, CATEGORIES, cn } from '@/lib/utils'
import { deptLabel } from '@/types'
import { DisplaySettings } from '@/components/DisplaySettings'
import { Panel } from '@/components/PanelCard'
import { HotelBoard } from '@/components/HotelBoard'
import {
  PANEL, inWindow, loadPanelSettings, savePanelSettings,
  type PanelSettings,
} from '@/lib/panelTheme'
import type { KaizenCase, Department } from '@/types'

// ─────────────────────────────────────────────────────────────────────────────
// Wall-panel dashboard. Read-only, no navigation, no controls — designed for a
// 1024×600 landscape screen left on all day (the Guition JC1060P470C class of
// panel, a kiosk tablet, or a headless-Chrome screenshot at that exact size).
//
// It deliberately does NOT reuse DashboardPage: that page is interactive (month
// picker, status dropdown, deep-links into /cases) and laid out to scroll on a
// phone. A wall board has no pointer, must never scroll, and has to be legible
// from several metres away — different constraints, so different component.
//
// Everything is drawn inside a fixed 1024×600 box which is then scaled to fit
// whatever viewport it lands in (?fit=none disables that for pixel-exact
// capture). A screenshot service set to a 1024×600 viewport gets scale 1.
// ─────────────────────────────────────────────────────────────────────────────

const W = 1024
const H = 600

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const C = PANEL
const CAT_COLORS: Record<string, string> = {
  maintenance: '#3b82f6', cleanliness: '#14b8a6', safety: '#ef4444',
  guest_complaint: '#a855f7', equipment: '#f97316', other: '#6b7280',
  preventive_maintenance: '#0ea5e9',
}
const CAT_FALLBACK = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#6366f1']
const PRIORITY_COLORS: Record<string, string> = {
  low: '#6b7280', medium: '#3b82f6', high: '#f97316', critical: '#ef4444',
}

// What the board is currently drilled into. `key` is interpreted per kind:
// a status bucket name, a category slug ('__other__' for the orphan bucket),
// or the literal 'attention'.
type Drill = { kind: 'status' | 'category' | 'attention'; key: string; label: string; color: string }

// Bangkok wall-clock parts, so the panel shows site time wherever it is hung
// and whatever the device's own timezone happens to be set to.
function bkkParts(d: Date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short', day: '2-digit', month: 'short',
  }).formatToParts(d)
  const get = (t: string) => f.find(p => p.type === t)?.value ?? ''
  return {
    time: `${get('hour')}:${get('minute')}`,
    date: `${get('weekday')} ${get('day')} ${get('month')}`,
  }
}

export function DisplayPage() {
  const { profile, loading: authLoading } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const [params] = useSearchParams()

  const [allCases, setAllCases] = useState<KaizenCase[]>([])
  const [catList, setCatList] = useState<{ slug: string; label: string }[]>([])
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  // Per-device, from localStorage — see panelTheme.ts for why these never touch
  // the profile. URL params still win, so a kiosk URL can pin a panel's
  // behaviour regardless of what someone set on the screen.
  const [panel, setPanelState] = useState<PanelSettings>(() => loadPanelSettings())
  function setPanel(next: PanelSettings) { setPanelState(next); savePanelSettings(next) }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [board, setBoard] = useState<'kaizen' | 'hotel'>('kaizen')
  // id → full_name, so the drill-down can name the people on a case.
  // kaizen_cases stores PICs as profile ids (person_in_charge is just pic_ids[0]),
  // and a wall board showing a UUID is worse than showing nothing.
  const [people, setPeople] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => new Date())
  const fetchSeq = useRef(0)

  // ── Scale the fixed 1024×600 canvas into whatever viewport we get ──────────
  const fit = params.get('fit') !== 'none'
  const [scale, setScale] = useState(1)
  useEffect(() => {
    if (!fit) { setScale(1); return }
    const recompute = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H))
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [fit])

  // ── Clock ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(id)
  }, [])

  // ── Data, re-polled on an interval (?refresh=<seconds>, default 60) ────────
  const refreshMs = useMemo(() => {
    const raw = Number(params.get('refresh'))
    const secs = Number.isFinite(raw) && raw > 0 ? raw : panel.refreshSecs
    return Math.min(3600, Math.max(15, secs)) * 1000
  }, [params, panel.refreshSecs])

  useEffect(() => {
    if (!profile || !activeCompany) return
    let cancelled = false

    async function fetchAll() {
      if (!profile) return
      const seq = ++fetchSeq.current
      let query = supabase
        .from('kaizen_cases')
        .select('*, creator:kaizen_profiles!kaizen_cases_created_by_fkey(full_name, department)')
      if (activeCompany) query = query.eq('company_id', activeCompany.id)
      const { data, error } = await query.order('created_at', { ascending: false })
      if (cancelled || seq !== fetchSeq.current) return
      if (error) {
        // Leave the last good data on screen rather than blanking the wall, and
        // let the stale badge in the header tell the room the feed is behind.
        console.error('[Display] fetch error', error.message)
        return
      }
      const rows = (data || []) as KaizenCase[]
      const staffDept = profile.department ?? ''
      setAllCases(profile.role === 'staff'
        ? rows.filter(c =>
            c.department === staffDept
            || (!!staffDept && (c.assigned_departments ?? []).includes(staffDept as Department))
            || (c.pic_ids ?? []).includes(profile.id))
        : rows)
      setFetchedAt(new Date())

      const { data: profileRows } = await supabase.from('kaizen_profiles')
        .select('id, full_name').eq('company_id', activeCompany!.id)
      if (cancelled || seq !== fetchSeq.current) return
      if (profileRows) {
        setPeople(Object.fromEntries(
          (profileRows as { id: string; full_name: string }[]).map(r => [r.id, r.full_name]),
        ))
      }

      const { data: catRow } = await supabase.from('kaizen_settings').select('value')
        .eq('company_id', activeCompany!.id).eq('key', 'custom_categories').maybeSingle()
      if (cancelled || seq !== fetchSeq.current) return
      const labels = Array.isArray(catRow?.value) ? (catRow!.value as string[]) : []
      setCatList(labels.map(l => ({ slug: l.toLowerCase().replace(/ /g, '_'), label: l })))
    }

    fetchAll()
    const id = setInterval(fetchAll, refreshMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [profile, activeCompany, refreshMs])

  // ── Current Bangkok month is the reporting window (no picker on a wall) ────
  const [bkkY, bkkM] = bangkokDate(now).split('-').map(Number)
  const monthCases = useMemo(() => allCases.filter(c => {
    const [y, m] = bangkokDate(new Date(c.created_at)).split('-').map(Number)
    return y === bkkY && m === bkkM
  }), [allCases, bkkY, bkkM])

  const stats = useMemo(() => ({
    total: monthCases.length,
    open: monthCases.filter(c => c.status === 'open').length,
    reopened: monthCases.filter(c => c.status === 'reopened').length,
    inProgress: monthCases.filter(c => ['assigned', 'in_progress'].includes(c.status)).length,
    pending: monthCases.filter(c => ['pending_manager_approval', 'pending_admin_approval'].includes(c.status)).length,
    closed: monthCases.filter(c => c.status === 'closed').length,
    overdue: monthCases.filter(c => isSLABreached(c)).length,
  }), [monthCases])

  const avgResolution = useMemo(() => {
    const closed = monthCases.filter(c => c.status === 'closed' && c.closed_at)
    if (!closed.length) return null
    const h = closed.reduce((s, c) => s + differenceInHours(new Date(c.closed_at!), new Date(c.created_at)), 0) / closed.length
    const total = Math.round(h)
    return total < 24 ? `${total}h` : `${Math.floor(total / 24)}d ${total % 24}h`
  }, [monthCases])

  const resolutionRate = stats.total > 0 ? Math.round((stats.closed / stats.total) * 100) : 0

  // ── Trailing 9 months, from all cases ─────────────────────────────────────
  const monthlyData = useMemo(() => {
    const months = Array.from({ length: 9 }, (_, i) => {
      let y = bkkY, m = bkkM - 8 + i
      while (m < 1) { m += 12; y-- }
      while (m > 12) { m -= 12; y++ }
      return { key: `${y}-${m}`, label: MONTH_SHORT[m - 1] }
    })
    const counts: Record<string, number> = {}
    months.forEach(m => { counts[m.key] = 0 })
    allCases.forEach(c => {
      const [y, m] = bangkokDate(new Date(c.created_at)).split('-').map(Number)
      const k = `${y}-${m}`
      if (k in counts) counts[k]++
    })
    return months.map(m => ({ month: m.label, count: counts[m.key], current: m.key === `${bkkY}-${bkkM}` }))
  }, [allCases, bkkY, bkkM])

  // ── Status donut ──────────────────────────────────────────────────────────
  const pieData = [
    { name: t.dashboard.open,            value: stats.open,       color: C.open },
    { name: t.dashboard.inProgress,      value: stats.inProgress, color: C.inProgress },
    { name: t.dashboard.waitingApproval, value: stats.pending,    color: C.pending },
    { name: t.dashboard.resolved,        value: stats.closed,     color: C.resolved },
    { name: t.status.reopened,           value: stats.reopened,   color: C.reopened },
  ]
  const pieSlices = pieData.filter(d => d.value > 0)

  // ── Categories (company's own list, falling back to the built-ins) ────────
  // Kept separate from the visible rows: the rows are filtered to non-zero and
  // capped at five, so they are NOT the taxonomy. Drill-down needs the full slug
  // set to work out what belongs in the "Other" (orphan) bucket.
  const allCats = useMemo(() => {
    const base = catList.length
      ? catList
      : CATEGORIES.map(c => ({ slug: c, label: t.categories[c as keyof typeof t.categories] || c }))
    return allCases.some(c => c.category === 'preventive_maintenance')
      && !base.some(c => c.slug === 'preventive_maintenance')
      ? [...base, { slug: 'preventive_maintenance', label: t.categories?.preventive_maintenance ?? 'Preventive Maintenance' }]
      : base
  }, [catList, allCases, t])
  const knownSlugs = useMemo(() => new Set(allCats.map(c => c.slug)), [allCats])

  const categoryRows = useMemo(() => {
    const cats = allCats
    const counts: Record<string, number> = {}
    cats.forEach(c => { counts[c.slug] = 0 })
    let other = 0
    monthCases.forEach(c => {
      const slug = (c.category || '').toLowerCase().replace(/ /g, '_')
      if (slug in counts) counts[slug]++
      else other++
    })
    const rows = cats.map((c, i) => ({
      slug: c.slug,
      label: c.label,
      count: counts[c.slug],
      color: CAT_COLORS[c.slug] || CAT_FALLBACK[i % CAT_FALLBACK.length],
    }))
    if (other > 0) {
      rows.push({
        slug: '__other__',
        label: t.categories?.other ?? 'Other',
        count: other,
        color: CAT_FALLBACK[cats.length % CAT_FALLBACK.length],
      })
    }
    return rows.filter(r => r.count > 0).sort((a, b) => b.count - a.count).slice(0, 4)
  }, [allCats, monthCases, t])
  const catMax = Math.max(1, ...categoryRows.map(r => r.count))

  // ── Needs attention: overdue first, then critical, oldest first ───────────
  const attention = useMemo(() => {
    const live = monthCases.filter(c => c.status !== 'closed')
    const scored = live
      .map(c => ({ c, overdue: isSLABreached(c), crit: c.priority === 'critical' }))
      .filter(x => x.overdue || x.crit)
    scored.sort((a, b) =>
      (Number(b.overdue) - Number(a.overdue))
      || (Number(b.crit) - Number(a.crit))
      || (new Date(a.c.created_at).getTime() - new Date(b.c.created_at).getTime()))
    return scored.slice(0, 3)
  }, [monthCases])

  // ── Drill-down ────────────────────────────────────────────────────────────
  // The board is glanceable first; this exists so someone standing in front of
  // it can answer "which ones?" without walking back to a desk. It always
  // returns to the summary by itself after ?idle=<seconds> of no touch — a panel
  // left on a filtered list is worse than no panel, because the room reads the
  // filtered count as the real one. ?touch=off disables it outright, which is
  // what the screenshot/ESP32 path wants: there, a tap can't reach this code.
  const touchEnabled = params.get('touch') === 'off' ? false : panel.touch
  const idleMs = useMemo(() => {
    const raw = Number(params.get('idle'))
    const secs = Number.isFinite(raw) && raw > 0 ? raw : panel.idleSecs
    return Math.min(300, Math.max(10, secs)) * 1000
  }, [params, panel.idleSecs])

  const [drill, setDrill] = useState<Drill | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const idleTimer = useRef<number | null>(null)
  // Bumping this restarts the countdown bar's CSS animation (remount via key).
  const [idleKey, setIdleKey] = useState(0)

  function closeDrill() {
    if (idleTimer.current) window.clearTimeout(idleTimer.current)
    idleTimer.current = null
    setDrill(null)
    setExpanded(null)
  }
  function bumpIdle() {
    if (idleTimer.current) window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(closeDrill, idleMs)
    setIdleKey(k => k + 1)
  }
  function openDrill(d: Drill, expandId?: string) {
    if (!touchEnabled) return
    setDrill(d)
    setExpanded(expandId ?? null)
    bumpIdle()
  }
  useEffect(() => () => { if (idleTimer.current) window.clearTimeout(idleTimer.current) }, [])

  const drillCases = useMemo(() => {
    if (!drill) return []
    if (drill.kind === 'attention') return attention.map(a => a.c)
    if (drill.kind === 'category') {
      return monthCases.filter(c => {
        const slug = (c.category || '').toLowerCase().replace(/ /g, '_')
        return drill.key === '__other__' ? !knownSlugs.has(slug) : slug === drill.key
      })
    }
    const match: Record<string, (c: KaizenCase) => boolean> = {
      total:      () => true,
      open:       c => c.status === 'open',
      inProgress: c => ['assigned', 'in_progress'].includes(c.status),
      pending:    c => ['pending_manager_approval', 'pending_admin_approval'].includes(c.status),
      resolved:   c => c.status === 'closed',
      overdue:    c => isSLABreached(c),
    }
    return monthCases.filter(match[drill.key] ?? (() => true))
  }, [drill, monthCases, attention, knownSlugs])

  function statusMeta(status: string): { label: string; color: string } {
    switch (status) {
      case 'open':                     return { label: t.status.open, color: C.open }
      case 'assigned':                 return { label: t.status.assigned, color: '#a855f7' }
      case 'in_progress':              return { label: t.status.in_progress, color: C.inProgress }
      case 'pending_manager_approval': return { label: t.status.pending_manager_approval, color: C.pending }
      case 'pending_admin_approval':   return { label: t.status.pending_admin_approval, color: C.pending }
      case 'closed':                   return { label: t.status.closed, color: C.resolved }
      case 'reopened':                 return { label: t.status.reopened, color: C.reopened }
      default:                         return { label: status, color: C.muted }
    }
  }

  // Settings gets its own, longer idle than a drill-down: someone may be
  // halfway through typing a device name, and 30s would eat the input. It still
  // expires, so a panel can never be left parked on the settings screen.
  const settingsIdle = useRef<number | null>(null)
  function closeSettings() {
    if (settingsIdle.current) window.clearTimeout(settingsIdle.current)
    settingsIdle.current = null
    setSettingsOpen(false)
  }
  function bumpSettingsIdle() {
    if (settingsIdle.current) window.clearTimeout(settingsIdle.current)
    settingsIdle.current = window.setTimeout(() => setSettingsOpen(false), 120_000)
  }
  function openSettings() {
    closeDrill()
    setSettingsOpen(true)
    bumpSettingsIdle()
  }
  useEffect(() => () => { if (settingsIdle.current) window.clearTimeout(settingsIdle.current) }, [])

  const clock = bkkParts(now)
  const stale = fetchedAt ? (now.getTime() - fetchedAt.getTime()) > refreshMs * 3 : false
  // Backlight: a PWM duty on hardware, a filter here — it dims what the viewer
  // sees without disturbing any colour relationship on the board.
  const dimmed = panel.nightDim && inWindow(clock.time, panel.nightFrom, panel.nightTo)
  const backlight = (dimmed ? panel.nightLevel : panel.brightness) / 100
  // ?touch=off is the screenshot/ESP32 path: nothing on the board may open.
  // panel.touch alone only disables drill-down — Settings has to stay reachable,
  // or turning touch off on the device would lock the panel out of its own
  // settings screen with no way back except the URL.
  const kioskLocked = params.get('touch') === 'off'

  if (authLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: C.bg }}>
        <div className="w-8 h-8 border-2 rounded-full animate-spin"
             style={{ borderColor: C.muted, borderTopColor: 'transparent' }} />
      </div>
    )
  }
  // A wall panel is signed in once, by hand, and then left alone; the Supabase
  // session auto-refreshes from localStorage across reboots.
  if (!profile) return <Navigate to="/login" replace />

  return (
    <div className="fixed inset-0 overflow-hidden flex items-center justify-center" style={{ background: C.bg }}>
      <div
        className="flex flex-col"
        style={{
          width: W, height: H, padding: 16, color: C.text, position: 'relative',
          transform: [fit ? `scale(${scale})` : '', panel.orientation === 180 ? 'rotate(180deg)' : '']
            .filter(Boolean).join(' ') || undefined,
          transformOrigin: 'center',
          filter: backlight < 1 ? `brightness(${backlight})` : undefined,
          flex: '0 0 auto',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between flex-shrink-0" style={{ height: 52 }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="text-[22px] font-bold leading-none truncate">
                {activeCompany?.name ?? 'Kaizen'}
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider flex-shrink-0"
                    style={{ background: 'var(--brand-primary, #0891b2)', color: '#fff' }}>
                {t.dashboard.title}
              </span>
              {board === 'hotel' && params.get('sandbox') === '1' && (
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider flex-shrink-0"
                      style={{ background: 'rgba(245,158,11,0.18)', color: C.pending }}>
                  {lang === 'th' ? 'sandbox' : 'sandbox'}
                </span>
              )}
              {stale && (
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider flex-shrink-0"
                      style={{ background: 'rgba(245,158,11,0.18)', color: C.pending }}>
                  {lang === 'th' ? 'ข้อมูลค้าง' : 'stale'}
                </span>
              )}
            </div>
            <div className="text-[12px] mt-1" style={{ color: C.muted }}>
              {board === 'kaizen'
                ? <>{MONTH_SHORT[bkkM - 1]} {bkkY} · {t.dashboard.avgResolution} {avgResolution ?? '—'} · {t.dashboard.resolutionRate} {resolutionRate}%</>
                : <>{MONTH_SHORT[bkkM - 1]} {bkkY} · {lang === 'th' ? 'ผลประกอบการโรงแรม' : 'Hotel performance'}</>}
            </div>
          </div>
          <div className="text-right flex-shrink-0 ml-4">
            <div className="text-[30px] font-bold leading-none tabular-nums">{clock.time}</div>
            <div className="text-[11px] mt-1" style={{ color: C.muted }}>{clock.date}</div>
          </div>
        </div>

        {board === 'kaizen' ? (
          <>
        {/* ── KPI row ──────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-6 gap-3 flex-shrink-0" style={{ height: 86, marginTop: 12 }}>
          {[
            { key: 'total',      label: t.dashboard.totalCases,      value: stats.total,      color: C.text },
            { key: 'open',       label: t.dashboard.open,            value: stats.open,       color: C.open },
            { key: 'inProgress', label: t.dashboard.inProgress,      value: stats.inProgress, color: C.inProgress },
            { key: 'pending',    label: t.dashboard.waitingApproval, value: stats.pending,    color: C.pending },
            { key: 'resolved',   label: t.dashboard.resolved,        value: stats.closed,     color: C.resolved },
            { key: 'overdue',    label: t.dashboard.overdueSLA,      value: stats.overdue,    color: C.critical },
          ].map(k => {
            // An empty bucket is not a drill target — opening an empty list is
            // just a dead end someone has to dismiss.
            const live = touchEnabled && k.value > 0
            return (
              <button
                key={k.key}
                disabled={!live}
                onClick={() => openDrill({ kind: 'status', key: k.key, label: k.label, color: k.color })}
                className={cn('rounded-xl px-3 flex flex-col justify-center min-w-0 text-left transition',
                  live && 'active:brightness-150')}
                style={{ background: C.card, border: `1px solid ${C.border}` }}
              >
                <div className="text-[36px] font-bold leading-none tabular-nums" style={{ color: k.color }}>
                  {k.value}
                </div>
                <div className="text-[10px] font-semibold uppercase tracking-wider mt-1.5 truncate w-full"
                     style={{ color: C.muted }} title={k.label}>
                  {k.label}
                </div>
              </button>
            )
          })}
        </div>

        {/* ── Row A: trend + status donut ──────────────────────────────────── */}
        <div className="flex gap-3 flex-shrink-0" style={{ height: 202, marginTop: 12 }}>
          <Panel title={t.dashboard.monthlyCases} className="flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyData} margin={{ top: 16, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} width={40} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false} label={{ position: 'top', fill: C.text, fontSize: 11 }}>
                  {monthlyData.map((d, i) => (
                    <Cell key={i} fill={d.current ? 'var(--brand-primary, #0891b2)' : 'rgba(255,255,255,0.16)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title={t.dashboard.caseOverview} style={{ width: 384 }} className="flex-shrink-0">
            <div className="flex items-center h-full gap-2">
              <div className="relative flex-shrink-0" style={{ width: 150, height: 150 }}>
                {pieSlices.length === 0 ? (
                  <div className="w-full h-full rounded-full flex items-center justify-center text-[11px]"
                       style={{ border: `14px solid rgba(255,255,255,0.06)`, color: C.muted }}>
                    {t.dashboard.noData}
                  </div>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={pieSlices} cx="50%" cy="50%" innerRadius={48} outerRadius={70}
                             paddingAngle={pieSlices.length > 1 ? 3 : 0} dataKey="value"
                             startAngle={90} endAngle={-270} isAnimationActive={false}>
                          {pieSlices.map((d, i) => <Cell key={i} fill={d.color} stroke="none" />)}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span className="text-[26px] font-bold leading-none tabular-nums">{stats.total}</span>
                      <span className="text-[10px] mt-1" style={{ color: C.muted }}>{t.dashboard.totalShort}</span>
                    </div>
                  </>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                {pieData.map(d => (
                  <div key={d.name} className="flex items-center gap-2 text-[12px]">
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
                    <span className="flex-1 truncate" style={{ color: C.muted }}>{d.name}</span>
                    <span className="font-semibold tabular-nums flex-shrink-0">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </div>

        {/* ── Row B: attention list + categories ───────────────────────────── */}
        <div className="flex gap-3 flex-shrink-0" style={{ height: 130, marginTop: 12 }}>
          <Panel
            title={lang === 'th' ? 'ต้องดำเนินการ' : 'Needs Attention'}
            className="flex-1"
            right={attention.length > 0
              ? <span className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: C.critical }}>
                  <AlertTriangle className="h-3 w-3" />{attention.length}
                </span>
              : undefined}
          >
            {attention.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[12px]" style={{ color: C.muted }}>
                {lang === 'th' ? 'ไม่มีเคสเกินกำหนดหรือวิกฤต' : 'Nothing overdue or critical'}
              </div>
            ) : (
              <div className="space-y-1">
                {attention.map(({ c, overdue }) => (
                  <button
                    key={c.id}
                    disabled={!touchEnabled}
                    onClick={() => openDrill(
                      { kind: 'attention', key: 'attention', color: C.critical,
                        label: lang === 'th' ? 'ต้องดำเนินการ' : 'Needs Attention' },
                      c.id,
                    )}
                    className={cn('w-full flex items-center gap-2 rounded-md px-2 text-left transition',
                      touchEnabled && 'active:brightness-150')}
                    style={{ height: 26, background: 'rgba(255,255,255,0.03)' }}>
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ background: overdue ? C.critical : C.pending }} />
                    <span className="text-[11px] font-mono flex-shrink-0 tabular-nums" style={{ color: C.muted }}>
                      {c.case_number}
                    </span>
                    <span className="text-[12px] flex-1 truncate">{c.title}</span>
                    <span className="text-[10px] flex-shrink-0 px-1.5 py-0.5 rounded"
                          style={{ background: 'rgba(255,255,255,0.06)', color: C.muted }}>
                      {deptLabel(c.department, lang)}
                    </span>
                    <span className="text-[11px] font-semibold flex-shrink-0 tabular-nums w-10 text-right"
                          style={{ color: overdue ? C.critical : C.pending }}>
                      {differenceInHours(now, new Date(c.created_at))}h
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={t.dashboard.casesByCategory} style={{ width: 384 }} className="flex-shrink-0">
            {categoryRows.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[12px]" style={{ color: C.muted }}>
                {t.dashboard.noData}
              </div>
            ) : (
              <div className="space-y-1.5">
                {categoryRows.map(r => (
                  <button
                    key={r.slug}
                    disabled={!touchEnabled}
                    onClick={() => openDrill({ kind: 'category', key: r.slug, label: r.label, color: r.color })}
                    className={cn('w-full flex items-center gap-2 transition',
                      touchEnabled && 'active:brightness-150')}
                  >
                    <span className="text-[11px] truncate text-left" style={{ width: 118, color: C.muted }} title={r.label}>
                      {r.label}
                    </span>
                    <span className="flex-1 h-2.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <span className="block h-full rounded-full"
                            style={{ width: `${(r.count / catMax) * 100}%`, background: r.color }} />
                    </span>
                    <span className="text-[12px] font-semibold tabular-nums w-7 text-right flex-shrink-0">{r.count}</span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>
          </>
        ) : (
          <HotelBoard refreshMs={refreshMs} lang={lang} sandbox={params.get('sandbox') === '1'} />
        )}

        {/* ── Dashboard switcher ───────────────────────────────────────────
            Five fixed slots. The middle three are reserved for dashboards that
            do not exist yet and are deliberately inert — keeping them in the
            grid now means the row never reflows (and nothing moves under a
            finger) as they are filled in. */}
        <div className="grid grid-cols-5 gap-3 flex-shrink-0" style={{ height: 52, marginTop: 10 }}>
          {([
            { id: 'kaizen', icon: LayoutDashboard, label: 'Kaizen System' },
            { id: 'hotel',  icon: Hotel,           label: lang === 'th' ? 'โรงแรม' : 'Hotel' },
          ] as const).map(b => {
            const active = board === b.id
            const Icon = b.icon
            return (
              <button
                key={b.id}
                aria-current={active ? 'page' : undefined}
                disabled={kioskLocked}
                onClick={() => { closeDrill(); setBoard(b.id) }}
                className="rounded-xl flex items-center justify-center gap-2 transition active:brightness-150"
                style={active
                  ? { background: 'var(--brand-primary, #0891b2)', color: '#fff' }
                  : { background: C.card, border: `1px solid ${C.border}`, color: C.muted }}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="text-[12px] font-semibold truncate">{b.label}</span>
              </button>
            )
          })}

          {[0, 1].map(i => (
            <div
              key={i}
              aria-hidden
              className="rounded-xl"
              style={{ border: '1px dashed rgba(255,255,255,0.10)' }}
            />
          ))}

          <button
            onClick={openSettings}
            disabled={kioskLocked}
            className="rounded-xl flex items-center justify-center gap-2 transition active:brightness-150"
            style={{ background: C.card, border: `1px solid ${C.border}`, color: C.muted }}
          >
            <Settings className="h-4 w-4 flex-shrink-0" />
            <span className="text-[12px] font-semibold truncate">
              {lang === 'th' ? 'ตั้งค่าระบบ' : 'System Settings'}
            </span>
          </button>
        </div>

        {/* ── Drill-down overlay ───────────────────────────────────────────
            Covers the whole canvas rather than opening a side panel: from two
            metres away a half-covered board is unreadable either way, and this
            keeps one clear "I am looking at a subset" state. Any touch inside
            restarts the idle countdown; the bar across the top shows how long
            the board will keep showing it. */}
        {drill && (
          <div
            className="absolute flex flex-col rounded-xl overflow-hidden"
            style={{ inset: 16, background: C.bg, border: `1px solid ${C.border}` }}
            onPointerDown={bumpIdle}
          >
            <style>{`@keyframes kzn-idle { from { width: 100% } to { width: 0% } }`}</style>
            <div className="flex-shrink-0" style={{ height: 3, background: 'rgba(255,255,255,0.06)' }}>
              <div key={idleKey} style={{ height: '100%', background: drill.color, animation: `kzn-idle ${idleMs}ms linear forwards` }} />
            </div>

            <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0"
                 style={{ borderBottom: `1px solid ${C.border}` }}>
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: drill.color }} />
                <span className="text-[17px] font-bold truncate">{drill.label}</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{ background: 'rgba(255,255,255,0.07)', color: C.muted }}>
                  {t.cases.caseCount(drillCases.length)}
                </span>
              </div>
              <button
                onClick={closeDrill}
                aria-label={lang === 'th' ? 'ปิด' : 'Close'}
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 active:brightness-150 transition"
                style={{ background: 'rgba(255,255,255,0.07)' }}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2" style={{ scrollbarWidth: 'thin' }}>
              {drillCases.length === 0 ? (
                <div className="h-full flex items-center justify-center text-[13px]" style={{ color: C.muted }}>
                  {t.dashboard.noCases}
                </div>
              ) : drillCases.map(c => {
                const sm = statusMeta(c.status)
                const isOpen = expanded === c.id
                const overdue = isSLABreached(c)
                return (
                  <div key={c.id} className="mb-1 rounded-md overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <button
                      onClick={() => setExpanded(isOpen ? null : c.id)}
                      className="w-full flex items-center gap-2.5 px-2.5 text-left active:brightness-150 transition"
                      style={{ height: 34 }}
                    >
                      <span className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ background: PRIORITY_COLORS[c.priority] ?? C.muted }}
                            title={t.priority[c.priority as keyof typeof t.priority] ?? c.priority} />
                      <span className="text-[11px] font-mono tabular-nums flex-shrink-0" style={{ color: C.muted }}>
                        {c.case_number}
                      </span>
                      <span className="text-[13px] flex-1 truncate">{c.title}</span>
                      <span className="text-[10px] flex-shrink-0 px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(255,255,255,0.06)', color: C.muted }}>
                        {deptLabel(c.department, lang)}
                      </span>
                      <span className="text-[10px] flex-shrink-0 px-1.5 py-0.5 rounded font-semibold"
                            style={{ background: `${sm.color}22`, color: sm.color }}>
                        {sm.label}
                      </span>
                      <span className="text-[11px] font-semibold tabular-nums w-10 text-right flex-shrink-0"
                            style={{ color: overdue ? C.critical : C.muted }}>
                        {differenceInHours(now, new Date(c.created_at))}h
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 transition-transform"
                                   style={{ color: C.muted, transform: isOpen ? 'rotate(180deg)' : undefined }} />
                    </button>
                    {isOpen && (
                      <div className="px-2.5 pb-2.5 pt-0.5 text-[12px] space-y-1.5" style={{ color: C.muted }}>
                        <p className="whitespace-pre-wrap leading-snug" style={{ color: C.text }}>
                          {c.description || (lang === 'th' ? 'ไม่มีรายละเอียด' : 'No description')}
                        </p>
                        {c.proposed_solution && (
                          <p className="leading-snug">
                            <span className="font-semibold">{lang === 'th' ? 'แนวทางแก้ไข: ' : 'Proposed: '}</span>
                            {c.proposed_solution}
                          </p>
                        )}
<div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                          {(() => {
                            const ids = c.pic_ids?.length ? c.pic_ids : (c.person_in_charge ? [c.person_in_charge] : [])
                            // Drop ids with no matching profile (removed users) rather
                            // than falling back to the raw id.
                            const names = ids.map(id => people[id]).filter(Boolean)
                            return names.length ? <span>PIC: {names.join(', ')}</span> : null
                          })()}
                          {c.location && <span>{c.location}</span>}
                          {c.creator?.full_name && (
                            <span>{lang === 'th' ? 'แจ้งโดย' : 'by'} {c.creator.full_name}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {settingsOpen && (
          <DisplaySettings
            settings={panel}
            onChange={setPanel}
            onClose={closeSettings}
            onActivity={bumpSettingsIdle}
            lang={lang}
          />
        )}
      </div>
    </div>
  )
}
