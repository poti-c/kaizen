import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Lock, Loader2, LogOut, Plus, Building2, Crown, Power,
  Trash2, X, Eye, EyeOff, Users, UserCog, ScrollText, AlertTriangle, Check,
  ChevronRight, ChevronLeft, ChevronDown, Pencil, CalendarDays, ArrowLeft, Receipt, Upload, ImageIcon, Clock, Link2, KeyRound,
  Settings, Mail, UserPlus, Building, FileText, Package,
  LayoutDashboard, Bell, ListChecks, TrendingUp, TrendingDown, Wallet, Sparkles,
} from 'lucide-react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { FormGeneratorView } from './console/FormGenerator'
import { ProductsView } from './console/Products'
import { CalendarView } from './console/Calendar'

// ── Console API client ───────────────────────────────────────────────────────
const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kaizen-console`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const TOKEN_KEY = 'kaizen-console-token'
const NAME_KEY = 'kaizen-console-name'

async function callConsole<T = any>(action: string, payload: Record<string, unknown> = {}, token?: string | null): Promise<T> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON,
      'Authorization': `Bearer ${ANON}`,
      ...(token ? { 'x-console-token': token } : {}),
    },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error || 'Request failed') as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return data as T
}

// ── Types ────────────────────────────────────────────────────────────────────
interface Subscription {
  period_end: string | null; days_remaining: number | null; overdue: boolean; has_payment: boolean
  is_trial?: boolean; start?: string | null; end?: string | null
}
interface ClientDocument {
  id: string; form_type: 'quotation' | 'invoice' | 'tax_invoice_receipt' | 'receipt'
  doc_number: string; issue_date: string; total: number; currency: string; status: string; created_at: string
}
interface ConsoleCompany {
  id: string; name: string; slug: string; is_active: boolean
  plan: string; max_super_admins: number | null; max_managers: number | null; max_staff: number | null
  live_super_admins: number; live_managers: number; live_staff: number; created_at: string
  login_code: string | null
  contact_person: string | null; contact_phone: string | null; contact_email: string | null
  address: string | null; tax_id: string | null
  addons?: Record<string, boolean> | null
  subscription?: Subscription
}
interface ConsoleOwner {
  id: string; full_name: string; email: string | null; job_title: string | null
  is_active: boolean; created_at: string; company_id: string | null; companies: ConsoleCompany[]
}
interface Invoice {
  id: string; company_id: string; payee: string | null; amount: number | null
  currency: string; payment_date: string; period_start: string; period_end: string
  proof_url: string | null; notes: string | null; created_at: string
}
interface AuditEntry {
  id: string; action: string; ip: string | null; success: boolean
  detail: Record<string, unknown>; created_at: string
}

// SaaS package tiers
const PACKAGES = [
  { key: 'premium', label: 'Premium', desc: 'All features unlocked', term: '1-year subscription' },
  { key: 'gold',    label: 'Gold',    desc: 'Core features',         term: '1-year subscription' },
  { key: 'trial',   label: 'Starter', desc: 'Entry package',         term: '30-day free trial' },
] as const

const FORM_TYPE_LABEL: Record<string, string> = {
  quotation: 'Quotation', invoice: 'Invoice', tax_invoice_receipt: 'Tax Invoice / Receipt', receipt: 'Receipt',
}

// Purchasable add-ons (entitlements stored in kaizen_companies.addons).
const ADDONS: { key: string; label: string; price: string }[] = [
  { key: 'pms', label: 'Preventive Maintenance Scheduler', price: '฿10,000 / year' },
]

function packageBadgeCls(plan: string) {
  if (plan === 'premium') return 'bg-amber-500/15 text-amber-400 border-amber-500/30'
  if (plan === 'gold')    return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30'
  if (plan === 'trial')   return 'bg-slate-800 text-slate-300 border-slate-700'
  return 'bg-slate-800 text-slate-400 border-slate-700'
}
function packageLabel(plan: string) {
  return PACKAGES.find(p => p.key === plan)?.label ?? plan.charAt(0).toUpperCase() + plan.slice(1)
}
function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d.length <= 10 ? d + 'T00:00:00Z' : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
function money(amount: number | null, currency: string) {
  if (amount == null) return '—'
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
}

// Compress an image file to a JPEG data-URL for upload
function fileToCompressedDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const maxDim = 1400
      let { width, height } = img
      if (Math.max(width, height) > maxDim) {
        const s = maxDim / Math.max(width, height)
        width = Math.round(width * s); height = Math.round(height * s)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', 0.7))
    }
    img.onerror = reject
    img.src = url
  })
}

// ── Root ─────────────────────────────────────────────────────────────────────
export function ConsolePage() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY))
  const [adminName, setAdminName] = useState<string>(() => sessionStorage.getItem(NAME_KEY) || '')
  const [booting, setBooting] = useState(true)

  useEffect(() => {
    document.title = 'System Console'
    const meta = document.createElement('meta')
    meta.name = 'robots'; meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => { document.head.removeChild(meta) }
  }, [])

  useEffect(() => {
    let active = true
    async function check() {
      const stored = sessionStorage.getItem(TOKEN_KEY)
      if (!stored) { setBooting(false); return }
      try { await callConsole('verify', {}, stored); if (active) setToken(stored) }
      catch { sessionStorage.removeItem(TOKEN_KEY); if (active) setToken(null) }
      finally { if (active) setBooting(false) }
    }
    check()
    return () => { active = false }
  }, [])

  function handleLogin(t: string, name: string) {
    sessionStorage.setItem(TOKEN_KEY, t)
    sessionStorage.setItem(NAME_KEY, name || '')
    setAdminName(name || ''); setToken(t)
  }
  function handleLogout() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(NAME_KEY); setAdminName(''); setToken(null) }

  if (booting) {
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
  }
  return token ? <Dashboard token={token} adminName={adminName} onLogout={handleLogout} /> : <LoginScreen onLogin={handleLogin} />
}

// ── Login screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (t: string, name: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const { token, name } = await callConsole<{ token: string; name?: string }>('login', { username: username.trim(), password })
      onLogin(token, name || username.trim())
    } catch (err) { setError(err instanceof Error ? err.message : 'Login failed.') }
    finally { setLoading(false) }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <img src="/kaizen-icon.svg" alt="Kaizen" className="w-14 h-14 rounded-2xl object-contain shadow-lg shadow-amber-500/20 mb-4" />
          <h1 className="text-xl font-bold text-white">Kaizen System Console</h1>
          <p className="text-slate-400 text-sm mt-1">Restricted · Authorised personnel only</p>
        </div>
        <form onSubmit={submit} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoFocus
              className="w-full h-10 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/60" placeholder="admin" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Password</label>
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off"
                className="w-full h-10 rounded-lg bg-slate-800 border border-slate-700 px-3 pr-10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/60" placeholder="••••••••" />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-300">
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-400 text-sm rounded-lg px-3 py-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
          <button type="submit" disabled={loading || !username || !password}
            className="w-full h-10 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 text-sm font-semibold flex items-center justify-center gap-2 transition-colors">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Lock className="h-4 w-4" />Sign In</>}
          </button>
        </form>
        <p className="text-center text-[11px] text-slate-400 mt-6">© {new Date().getFullYear()} NNR Solutions · All activity is logged</p>
      </div>
    </div>
  )
}

// ── Dashboard ────────────────────────────────────────────────────────────────
type View = 'dashboard' | 'notifications' | 'clients' | 'calendar' | 'payments' | 'products' | 'forms' | 'audit' | 'todos' | 'settings'
interface Metrics {
  revenue: number; opportunity: number; lost: number
  conversions?: { trial_to_gold: number; trial_to_premium: number; gold_to_premium: number }
}

function Dashboard({ token, adminName, onLogout }: { token: string; adminName: string; onLogout: () => void }) {
  const [view, setView] = useState<View>('dashboard')
  const [owners, setOwners] = useState<ConsoleOwner[]>([])
  const [companies, setCompanies] = useState<ConsoleCompany[]>([])
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showCreateCompany, setShowCreateCompany] = useState(false)
  const [preselectCompany, setPreselectCompany] = useState<string | null>(null)
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null)
  const [payCount, setPayCount] = useState(0)
  const [formPreviewId, setFormPreviewId] = useState<string | null>(null)

  const call = useCallback(async <T,>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
    try { return await callConsole<T>(action, payload, token) }
    catch (err) { if ((err as { status?: number }).status === 401) onLogout(); throw err }
  }, [token, onLogout])

  const openForm = useCallback((formId: string) => { setFormPreviewId(formId); setSelectedCompanyId(null); setView('forms') }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await call<{ owners: ConsoleOwner[]; companies: ConsoleCompany[]; payments_pending?: number; metrics?: Metrics }>('list')
      setOwners(data.owners); setCompanies(data.companies); setPayCount(data.payments_pending ?? 0); setMetrics(data.metrics ?? null)
      try { const s = await call<{ company: ConsoleSettings | null }>('get_settings'); setTodos(s.company?.todos ?? []) } catch { /* ignore */ }
    } catch (e) { console.error('Console load failed:', e) } finally { setLoading(false) }
  }, [call])

  useEffect(() => { load() }, [load])

  const selectedCompany = companies.find(c => c.id === selectedCompanyId) || null
  const go = (v: View) => { setSelectedCompanyId(null); setView(v) }

  const NAV: { key: View; label: string; icon: typeof Building2; badge?: number }[] = [
    { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { key: 'notifications', label: 'Notifications', icon: Bell, badge: payCount },
    { key: 'clients', label: 'Clients', icon: Building2 },
    { key: 'calendar', label: 'Calendar', icon: CalendarDays },
    { key: 'payments', label: 'Payments', icon: Receipt, badge: payCount },
    { key: 'products', label: 'Products', icon: Package },
    { key: 'forms', label: 'Form Generator', icon: FileText },
    { key: 'audit', label: 'Audit Logs', icon: ScrollText },
    { key: 'todos', label: 'To-Do Lists', icon: ListChecks },
    { key: 'settings', label: 'Settings', icon: Settings },
  ]
  const openTodos = todos.filter(t => !t.done)
  const todayStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 border-r border-slate-800 bg-slate-900 flex flex-col h-screen sticky top-0">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-slate-800 flex-shrink-0">
          <img src="/kaizen-icon.svg" alt="Kaizen" className="w-8 h-8 rounded-lg object-contain" />
          <div className="min-w-0"><p className="text-sm font-bold text-white leading-tight">Kaizen System</p><p className="text-[10px] text-slate-400 leading-tight">System Console</p></div>
        </div>
        <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {NAV.map(({ key, label, icon: Icon, badge }) => (
            <button key={key} onClick={() => go(key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${view === key && !selectedCompany ? 'bg-amber-500/15 text-amber-400 font-medium' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
              <Icon className="h-4 w-4 flex-shrink-0" /><span className="flex-1 text-left truncate">{label}</span>
              {badge ? <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{badge}</span> : null}
            </button>
          ))}
        </nav>
        <button onClick={onLogout} className="flex items-center gap-2.5 px-4 py-3 border-t border-slate-800 text-sm text-slate-400 hover:text-white flex-shrink-0"><LogOut className="h-4 w-4" />Sign Out</button>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col h-screen overflow-hidden">
        <header className="border-b border-slate-800 bg-slate-900/60 px-6 py-3 flex items-center justify-between gap-4 flex-shrink-0">
          <div>
            <p className="text-sm font-semibold text-white">{adminName ? `Welcome, ${adminName} 👋` : 'Welcome back 👋'}</p>
            <p className="text-[11px] text-slate-400">{todayStr}</p>
          </div>
          <button onClick={() => go('todos')} className="text-right text-[11px] text-slate-400 hover:text-white max-w-[60%] truncate">
            {openTodos.length ? <><span className="text-amber-400 font-medium">{openTodos.length} to-do{openTodos.length === 1 ? '' : 's'}</span> · {openTodos[0].text}</> : 'No pending to-dos 🎉'}
          </button>
        </header>

        <main className="flex-1 overflow-y-auto px-6 py-6">
          {loading ? (
            <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
          ) : selectedCompany ? (
            <CompanyDetailView company={selectedCompany} owners={owners} allCompanies={companies} call={call} reload={load}
              onBack={() => setSelectedCompanyId(null)} onAddOwner={() => { setPreselectCompany(selectedCompany.id); setShowCreate(true) }} onOpenForm={openForm} />
          ) : view === 'dashboard' ? (
            <DashboardHome companies={companies} metrics={metrics} call={call} onView={go} onOpenClient={setSelectedCompanyId} />
          ) : view === 'notifications' ? (
            <NotificationsView call={call} onGo={go} onOpenClient={setSelectedCompanyId} />
          ) : view === 'clients' ? (
            <CompaniesListTab companies={companies} owners={owners} onOpen={setSelectedCompanyId} onCreate={() => setShowCreateCompany(true)} />
          ) : view === 'calendar' ? (
            <CalendarView call={call} onOpenForm={openForm} />
          ) : view === 'payments' ? (
            <PaymentsView call={call} onBack={() => go('dashboard')} reload={load} />
          ) : view === 'products' ? (
            <ProductsView call={call} onBack={() => go('dashboard')} />
          ) : view === 'forms' ? (
            <FormGeneratorView call={call} onBack={() => go('dashboard')} initialPreviewId={formPreviewId} onPreviewConsumed={() => setFormPreviewId(null)} />
          ) : view === 'audit' ? (
            <AuditTab call={call} />
          ) : view === 'todos' ? (
            <TodosView call={call} />
          ) : (
            <AdminSettingsView call={call} onBack={() => go('dashboard')} />
          )}
          <p className="text-center text-[11px] text-slate-500 mt-8">© 2026 NNR Solutions · All rights reserved · Version 1.0</p>
        </main>
      </div>

      {showCreate && (
        <CreateOwnerDialog
          preselectCompanyId={preselectCompany}
          call={call}
          onClose={() => { setShowCreate(false); setPreselectCompany(null) }}
          onCreated={() => { setShowCreate(false); setPreselectCompany(null); load() }}
        />
      )}

      {showCreateCompany && (
        <CreateCompanyDialog
          call={call}
          onClose={() => setShowCreateCompany(false)}
          onCreated={async (id) => { setShowCreateCompany(false); await load(); setSelectedCompanyId(id) }}
        />
      )}

    </div>
  )
}

// ── Companies list ───────────────────────────────────────────────────────────
function CompaniesListTab({ companies, owners, onOpen, onCreate }: {
  companies: ConsoleCompany[]
  owners: ConsoleOwner[]
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  // Number of Super Admins appointed to a company: those homed here plus any
  // granted cross-company access to it.
  function superAdminCount(id: string) {
    return owners.filter(o => o.company_id === id || o.companies.some(c => c.id === id)).length
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-white">Clients</h2>
          <p className="text-xs text-slate-400">{companies.length} client{companies.length !== 1 ? 's' : ''} · click to open</p>
        </div>
        <button onClick={onCreate} className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold px-3 py-2 rounded-lg transition-colors">
          <Plus className="h-3.5 w-3.5" />Add Client
        </button>
      </div>
      <div className="space-y-3">
        {companies.map((c) => (
          <button key={c.id} onClick={() => onOpen(c.id)}
            className="w-full flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4 text-left hover:border-slate-700 transition-colors">
            <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0">
              <Building2 className="h-5 w-5 text-slate-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-white truncate">{c.name}</p>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${c.is_active ? 'bg-green-500/15 text-green-400' : 'bg-slate-700 text-slate-300'}`}>
                  {c.is_active ? 'Active' : 'Suspended'}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold border ${packageBadgeCls(c.plan)}`}>{packageLabel(c.plan)}</span>
                <SubscriptionBadge sub={c.subscription} />
              </div>
              <p className="text-[11px] text-slate-400 truncate mt-0.5">
                /{c.slug} · {superAdminCount(c.id)} super admin{superAdminCount(c.id) !== 1 ? 's' : ''} · {c.live_managers}M / {c.live_staff}S
              </p>
            </div>
            <ChevronRight className="h-4 w-4 text-slate-400 flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  )
}

function SubscriptionBadge({ sub }: { sub?: Subscription }) {
  if (sub?.is_trial) {
    if (sub.overdue) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30 font-semibold">Trial expired</span>
    const warn = (sub.days_remaining ?? 0) <= 7
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${warn ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' : 'bg-sky-500/15 text-sky-300 border-sky-500/30'}`}>Trial · {sub.days_remaining ?? 0}d left</span>
  }
  if (!sub || !sub.has_payment) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700 font-medium">No payment</span>
  if (sub.overdue) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30 font-semibold">Overdue {Math.abs(sub.days_remaining ?? 0)}d</span>
  const soon = (sub.days_remaining ?? 0) <= 30
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${soon ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' : 'bg-green-500/15 text-green-400 border-green-500/30'}`}>{sub.days_remaining ?? 0}d left</span>
}

// ── Company detail page ──────────────────────────────────────────────────────
function CompanyDetailView({ company, owners, allCompanies, call, reload, onBack, onAddOwner, onOpenForm }: {
  company: ConsoleCompany
  owners: ConsoleOwner[]
  allCompanies: ConsoleCompany[]
  call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>
  reload: () => void
  onBack: () => void
  onAddOwner: () => void
  onOpenForm: (formId: string) => void
}) {
  const c = company
  // Top Management of this company: members homed here, plus anyone granted
  // cross-company access to it. Each can also be linked to other companies.
  const teamMembers = owners.filter((o) =>
    o.company_id === c.id || o.companies.some((lc) => lc.id === c.id)
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(c.name)
  const [editingCode, setEditingCode] = useState(false)
  const [codeValue, setCodeValue] = useState(c.login_code ?? c.slug)
  const [editingBilling, setEditingBilling] = useState(false)
  const [billingOpen, setBillingOpen] = useState(false)
  const [bill, setBill] = useState({
    contact_person: c.contact_person ?? '', contact_phone: c.contact_phone ?? '',
    contact_email: c.contact_email ?? '', address: c.address ?? '', tax_id: c.tax_id ?? '',
  })
  const [confirmDeleteOwner, setConfirmDeleteOwner] = useState<ConsoleOwner | null>(null)
  // Remove-company flow: 'confirm' (first prompt) → 'password' (admin password)
  const [removeStep, setRemoveStep] = useState<null | 'confirm' | 'password'>(null)
  const [removePw, setRemovePw] = useState('')
  const [removeErr, setRemoveErr] = useState('')

  // Invoices + generated documents (Transaction History)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [documents, setDocuments] = useState<ClientDocument[]>([])
  const [sub, setSub] = useState<Subscription | null>(c.subscription ?? null)
  const [invLoading, setInvLoading] = useState(true)
  const [showPay, setShowPay] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [confirmDeleteInv, setConfirmDeleteInv] = useState<Invoice | null>(null)

  const loadInvoices = useCallback(async () => {
    setInvLoading(true)
    try {
      const d = await call<{ invoices: Invoice[]; documents: ClientDocument[]; subscription: Subscription }>('list_invoices', { company_id: c.id })
      setInvoices(d.invoices); setDocuments(d.documents ?? []); setSub(d.subscription)
    } catch (e) { console.error('Invoice load failed:', e) } finally { setInvLoading(false) }
  }, [call, c.id])
  useEffect(() => { loadInvoices() }, [loadInvoices])

  async function patch(p: Record<string, unknown>, key: string) {
    setBusy(key)
    try { await call('update_company', { company_id: c.id, ...p }); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(null) }
  }
  async function saveName() {
    const v = nameValue.trim()
    if (!v || v === c.name) { setEditingName(false); return }
    await patch({ name: v }, 'name'); setEditingName(false)
  }
  function startBillingEdit() {
    setBill({
      contact_person: c.contact_person ?? '', contact_phone: c.contact_phone ?? '',
      contact_email: c.contact_email ?? '', address: c.address ?? '', tax_id: c.tax_id ?? '',
    })
    setBillingOpen(true)
    setEditingBilling(true)
  }
  async function saveBilling() {
    setBusy('billing')
    try {
      await call('update_company', {
        company_id: c.id,
        contact_person: bill.contact_person, contact_phone: bill.contact_phone,
        contact_email: bill.contact_email, address: bill.address, tax_id: bill.tax_id,
      })
      setEditingBilling(false); reload()
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function deleteCompany() {
    setRemoveErr('')
    if (!removePw) { setRemoveErr('Enter your admin password.'); return }
    setBusy('remove')
    try {
      await call('delete_company', { company_id: c.id, password: removePw })
      setRemoveStep(null); setRemovePw('')
      reload(); onBack()
    } catch (e) { setRemoveErr(e instanceof Error ? e.message : 'Failed to remove company.') }
    finally { setBusy(null) }
  }
  async function saveCode() {
    const v = codeValue.trim()
    if (!v || v === (c.login_code ?? c.slug)) { setEditingCode(false); return }
    setBusy('code')
    try {
      const r = await call<{ repointed: number }>('update_company', { company_id: c.id, login_code: v })
      setEditingCode(false)
      if (r.repointed > 0) alert(`Login code updated. ${r.repointed} staff login${r.repointed > 1 ? 's were' : ' was'} re-pointed to the new code.`)
      reload()
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(null) }
  }
  async function toggleOwner(o: ConsoleOwner) {
    setBusy(o.id)
    try { await call('set_owner_status', { owner_id: o.id, is_active: !o.is_active }); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function deleteOwner(o: ConsoleOwner) {
    setBusy(o.id)
    try { await call('delete_owner', { owner_id: o.id }); setConfirmDeleteOwner(null); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function deleteInvoice(inv: Invoice) {
    setBusy(inv.id)
    try { await call('delete_invoice', { invoice_id: inv.id }); setConfirmDeleteInv(null); loadInvoices(); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function linkOwner(ownerId: string, companyId: string) {
    setBusy('link-' + ownerId)
    try { await call('link_owner_company', { owner_id: ownerId, company_id: companyId }); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function unlinkOwner(ownerId: string, companyId: string) {
    setBusy('link-' + ownerId)
    try { await call('unlink_owner_company', { owner_id: ownerId, company_id: companyId }); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white mb-4">
        <ArrowLeft className="h-4 w-4" />All companies
      </button>

      {/* Company header */}
      <div className="flex items-start gap-3 mb-5">
        <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center flex-shrink-0">
          <Building2 className="h-6 w-6 text-slate-400" />
        </div>
        <div className="flex-1 min-w-0">
          {editingName ? (
            <div className="flex items-center gap-2">
              <input value={nameValue} onChange={(e) => setNameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setEditingName(false); setNameValue(c.name) } }}
                className="h-8 rounded-lg bg-slate-800 border border-slate-700 px-2.5 text-base font-bold text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50" autoFocus />
              <button onClick={saveName} disabled={busy === 'name'} className="p-1.5 rounded-lg text-green-400 hover:bg-green-500/10">
                {busy === 'name' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
              <button onClick={() => { setEditingName(false); setNameValue(c.name) }} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800"><X className="h-4 w-4" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white truncate">{c.name}</h1>
              <button onClick={() => { setNameValue(c.name); setEditingName(true) }} className="p-1 rounded text-slate-400 hover:text-amber-400 hover:bg-slate-800"><Pencil className="h-4 w-4" /></button>
            </div>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${c.is_active ? 'bg-green-500/15 text-green-400' : 'bg-slate-700 text-slate-300'}`}>{c.is_active ? 'Active' : 'Suspended'}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold border ${packageBadgeCls(c.plan)}`}>{packageLabel(c.plan)}</span>
            <SubscriptionBadge sub={sub ?? undefined} />
            <span className="text-[11px] text-slate-400">· /{c.slug}</span>
          </div>
        </div>
        <button onClick={() => patch({ is_active: !c.is_active }, 'status')} disabled={busy === 'status'} title={c.is_active ? 'Suspend company' : 'Activate company'}
          className={`p-2 rounded-lg flex-shrink-0 ${c.is_active ? 'text-green-400 hover:bg-green-500/10' : 'text-slate-400 hover:bg-slate-800'}`}>
          {busy === 'status' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
        </button>
      </div>

      {/* Staff Login Code — compact single row */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 mb-4 flex items-center gap-2.5 flex-wrap">
        <KeyRound className="h-4 w-4 text-amber-400 flex-shrink-0" />
        <h3 className="text-sm font-semibold text-white whitespace-nowrap">Staff Login Code</h3>
        {editingCode ? (
          <>
            <input
              value={codeValue}
              onChange={(e) => setCodeValue(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') saveCode(); if (e.key === 'Escape') { setEditingCode(false); setCodeValue(c.login_code ?? c.slug) } }}
              className="h-8 w-44 rounded-lg bg-slate-800 border border-slate-700 px-2.5 text-sm font-mono text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
              autoFocus
            />
            <button onClick={saveCode} disabled={busy === 'code'} className="p-1.5 rounded-lg text-green-400 hover:bg-green-500/10">
              {busy === 'code' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </button>
            <button onClick={() => { setEditingCode(false); setCodeValue(c.login_code ?? c.slug) }} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800"><X className="h-4 w-4" /></button>
            {c.live_staff > 0 && <span className="text-[11px] text-amber-600/80">⚠ re-points {c.live_staff} staff</span>}
          </>
        ) : (
          <>
            <code className="text-sm font-mono font-semibold text-amber-400 bg-slate-800 border border-slate-700 px-2.5 py-1 rounded-lg">{c.login_code ?? c.slug}</code>
            <button onClick={() => { setCodeValue(c.login_code ?? c.slug); setEditingCode(true) }} className="p-1 rounded text-slate-400 hover:text-amber-400 hover:bg-slate-800"><Pencil className="h-3.5 w-3.5" /></button>
            <span className="text-[11px] text-slate-400 ml-auto hidden md:block">Staff enter this with their username &amp; password</span>
          </>
        )}
      </div>

      {/* Contact & Billing — used for invoicing */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (!editingBilling) setBillingOpen((o) => !o) }}
            className="flex items-center gap-2 flex-1 min-w-0 text-left group"
          >
            <Receipt className="h-4 w-4 text-slate-400 shrink-0" />
            <h3 className="text-sm font-semibold text-white">Contact &amp; Billing</h3>
            {!editingBilling && (
              <ChevronDown className={`h-4 w-4 text-slate-400 group-hover:text-slate-300 transition-transform ${billingOpen ? 'rotate-180' : ''}`} />
            )}
          </button>
          {!editingBilling ? (
            <button onClick={startBillingEdit} className="p-1 rounded text-slate-400 hover:text-amber-400 hover:bg-slate-800"><Pencil className="h-3.5 w-3.5" /></button>
          ) : (
            <div className="flex items-center gap-1">
              <button onClick={saveBilling} disabled={busy === 'billing'} className="p-1.5 rounded-lg text-green-400 hover:bg-green-500/10">
                {busy === 'billing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
              <button onClick={() => setEditingBilling(false)} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800"><X className="h-4 w-4" /></button>
            </div>
          )}
        </div>
        {(billingOpen || editingBilling) && (
        <div className="mt-3">
        {editingBilling ? (
          <div className="space-y-2.5">
            <Field label="Contact Person"><input value={bill.contact_person} onChange={(e) => setBill({ ...bill, contact_person: e.target.value })} className={inputCls} placeholder="e.g. Khun Somchai" /></Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Phone Number"><input value={bill.contact_phone} onChange={(e) => setBill({ ...bill, contact_phone: e.target.value })} className={inputCls} placeholder="+66 …" /></Field>
              <Field label="Email Address"><input type="email" value={bill.contact_email} onChange={(e) => setBill({ ...bill, contact_email: e.target.value })} className={inputCls} placeholder="billing@company.com" autoComplete="off" /></Field>
            </div>
            <Field label="Thai Tax ID"><input value={bill.tax_id} onChange={(e) => setBill({ ...bill, tax_id: e.target.value })} className={inputCls} placeholder="13-digit tax ID" /></Field>
            <Field label="Address"><textarea value={bill.address} onChange={(e) => setBill({ ...bill, address: e.target.value })} rows={2} className={inputCls + ' h-auto py-2 resize-none'} placeholder="Billing address" /></Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Detail label="Contact Person">{c.contact_person || '—'}</Detail>
            <Detail label="Phone Number">{c.contact_phone || '—'}</Detail>
            <Detail label="Email Address">{c.contact_email || '—'}</Detail>
            <Detail label="Thai Tax ID">{c.tax_id || '—'}</Detail>
            <div className="col-span-2"><Detail label="Address">{c.address || '—'}</Detail></div>
          </div>
        )}
        </div>
        )}
      </div>

      {/* Package + created + quota */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-4 space-y-4">
        <div>
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Package</p>
          <div className="grid grid-cols-3 gap-2">
            {PACKAGES.map((p) => {
              const active = c.plan === p.key
              return (
                <button key={p.key} onClick={() => patch({ plan: p.key }, 'plan')} disabled={busy === 'plan'}
                  className={`rounded-lg border px-2 py-2 text-left transition-colors ${active ? packageBadgeCls(p.key) : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}>
                  <div className="flex items-center gap-1">
                    {p.key === 'premium' && <Crown className="h-3 w-3" />}
                    <span className="text-xs font-semibold">{p.label}</span>
                    {active && <Check className="h-3 w-3 ml-auto" />}
                  </div>
                  <p className="text-[9px] opacity-70 mt-0.5">{p.desc}</p>
                  <p className="text-[9px] font-medium opacity-90 mt-0.5">{p.term}</p>
                </button>
              )
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Detail label="Date Created" icon={CalendarDays}>{fmtDate(c.created_at)}</Detail>
          <Stat icon={Crown} label="Top Mgmt" live={c.live_super_admins ?? 0} max={c.max_super_admins} />
          <Stat icon={UserCog} label="Managers" live={c.live_managers} max={c.max_managers} />
          <Stat icon={Users} label="Staff" live={c.live_staff} max={c.max_staff} />
        </div>
      </div>

      {/* Subscription / Trial card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-slate-400" />
            <h3 className="text-sm font-semibold text-white">{sub?.is_trial ? 'Free Trial' : 'Subscription'}</h3>
            {sub?.is_trial && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 font-medium">Trial</span>}
          </div>
          <button onClick={() => setShowPay(true)} className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-lg">
            <Plus className="h-3.5 w-3.5" />{sub?.is_trial ? 'Activate Subscription' : 'Record Payment'}
          </button>
        </div>
        {sub?.is_trial ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Detail label="Trial Started" icon={CalendarDays}>{fmtDate(sub.start ?? null)}</Detail>
              <Detail label="Trial Ends" icon={CalendarDays}>{fmtDate(sub.end ?? null)}</Detail>
              <Detail label="Status">
                {sub.overdue
                  ? <span className="text-red-400 font-semibold">Trial expired {Math.abs(sub.days_remaining ?? 0)}d ago</span>
                  : <span className={(sub.days_remaining ?? 0) <= 7 ? 'text-amber-400 font-semibold' : 'text-green-400 font-semibold'}>{sub.days_remaining ?? 0} days left</span>}
              </Detail>
            </div>
            <p className="text-[11px] text-slate-400 mt-3">Starter is a 30-day free trial. The client app shows a countdown and a reminder in the final 7 days to upgrade to Gold or Premium. Record a payment to convert to a paid subscription.</p>
          </>
        ) : !sub || !sub.has_payment ? (
          <p className="text-sm text-slate-400">No payment recorded yet. Record a payment to start the subscription for this package.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Detail label="Subscription Start" icon={Receipt}>{fmtDate(invoices[0]?.payment_date ?? sub.start ?? null)}</Detail>
            <Detail label="Valid Until" icon={CalendarDays}>{fmtDate(sub.period_end)}</Detail>
            <Detail label="Status">
              {sub.overdue
                ? <span className="text-red-400 font-semibold">Expired {Math.abs(sub.days_remaining ?? 0)} days ago</span>
                : <span className={(sub.days_remaining ?? 0) <= 30 ? 'text-amber-400 font-semibold' : 'text-green-400 font-semibold'}>{sub.days_remaining ?? 0} days remaining</span>}
            </Detail>
          </div>
        )}

        {/* Add-ons */}
        <div className="mt-4 pt-3 border-t border-slate-800">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Add-ons</p>
          <div className="space-y-2">
            {ADDONS.map((a) => {
              const on = !!c.addons?.[a.key]
              return (
                <label key={a.key} className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy === `addon:${a.key}`}
                    onChange={() => patch({ addons: { ...(c.addons ?? {}), [a.key]: !on } }, `addon:${a.key}`)}
                    className="accent-amber-500 h-4 w-4"
                  />
                  <span className="text-sm text-slate-200">{a.label}</span>
                  <span className="text-[11px] text-slate-500">{a.price}</span>
                  {on && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-300 border border-green-500/30">Active</span>}
                  {busy === `addon:${a.key}` && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
                </label>
              )
            })}
          </div>
        </div>
      </div>

      {/* Transaction History — generated documents + recorded payments */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-4">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <Receipt className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-white">Transaction History</h3>
          <span className="text-[11px] text-slate-400">{invoices.length + documents.length}</span>
        </div>
        {invLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-slate-300" /></div>
        ) : (invoices.length + documents.length) === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-300">No transactions yet. Documents from the Form Generator and recorded payments will appear here.</p>
        ) : (
          <div className="divide-y divide-slate-800">
            {/* Generated documents (Form Generator) — click to open the PDF */}
            {documents.map((doc) => (
              <button key={`d-${doc.id}`} onClick={() => onOpenForm(doc.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/50 transition-colors">
                <div className="w-11 h-11 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0">
                  <FileText className="h-4 w-4 text-sky-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-white truncate">{FORM_TYPE_LABEL[doc.form_type]} · {doc.doc_number}</p>
                    <span className="text-[11px] text-slate-400 flex-shrink-0">{fmtDate(doc.issue_date)}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 truncate">{money(doc.total, doc.currency)} · <span className="capitalize">{doc.status}</span> · from Form Generator</p>
                </div>
                <ChevronRight className="h-4 w-4 text-slate-500 flex-shrink-0" />
              </button>
            ))}
            {/* Recorded subscription payments */}
            {invoices.map((inv) => (
              <div key={`p-${inv.id}`} className="flex items-center gap-3 px-4 py-3">
                {inv.proof_url ? (
                  <button onClick={() => setLightbox(inv.proof_url)} className="w-11 h-11 rounded-lg overflow-hidden border border-slate-700 flex-shrink-0 hover:ring-2 hover:ring-amber-500/50">
                    <img src={inv.proof_url} alt="Proof" className="w-full h-full object-cover" />
                  </button>
                ) : (
                  <div className="w-11 h-11 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0">
                    <Receipt className="h-4 w-4 text-green-400" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-white">{money(inv.amount, inv.currency)}</p>
                    <span className="text-[11px] text-slate-400">{fmtDate(inv.payment_date)}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-300 border border-green-500/30">Payment</span>
                  </div>
                  <p className="text-[11px] text-slate-400 truncate">
                    {inv.payee || 'Payee not set'} · covers {fmtDate(inv.period_start)} → {fmtDate(inv.period_end)}
                    {inv.notes ? ` · ${inv.notes}` : ''}
                  </p>
                </div>
                <button onClick={() => setConfirmDeleteInv(inv)} title="Delete payment" className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top Management — accounts + cross-company access */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <Crown className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-white">Top Management</h3>
          <span className="text-[11px] text-slate-400">{teamMembers.length}</span>
          <button onClick={onAddOwner} className="ml-auto flex items-center gap-1.5 text-xs font-medium text-amber-400 hover:text-amber-300">
            <Plus className="h-3.5 w-3.5" />Add Top Management
          </button>
        </div>
        <div className="px-4 py-3">
          <p className="text-[11px] text-slate-400 mb-3">Top Management accounts for this company. Use “+ Link company” on a member to give them access to other companies so they can switch between them in the app.</p>
          {teamMembers.length === 0 ? (
            <p className="text-sm text-slate-300 py-2 text-center">No top management accounts yet. Use “Add Top Management” to create one.</p>
          ) : (
            <div className="space-y-3">
              {teamMembers.map((o) => {
                const isHome = o.company_id === c.id
                const linkOptions = allCompanies.filter(ac => ac.id !== o.company_id && !o.companies.some(lc => lc.id === ac.id))
                return (
                  <div key={o.id} className="bg-slate-800 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Crown className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
                      <p className="text-sm font-medium text-white truncate">{o.full_name}</p>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${o.is_active ? 'bg-green-500/15 text-green-400' : 'bg-slate-700 text-slate-300'}`}>{o.is_active ? 'Active' : 'Suspended'}</span>
                      {o.job_title && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">{o.job_title}</span>}
                      {busy === 'link-' + o.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
                      <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                        {isHome ? (
                          <>
                            <button onClick={() => toggleOwner(o)} disabled={busy === o.id} title={o.is_active ? 'Suspend' : 'Activate'}
                              className={`p-1.5 rounded-lg ${o.is_active ? 'text-amber-400 hover:bg-amber-500/10' : 'text-slate-400 hover:bg-slate-800'}`}>
                              {busy === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                            </button>
                            <button onClick={() => setConfirmDeleteOwner(o)} title="Delete account" className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        ) : (
                          <button onClick={() => unlinkOwner(o.id, c.id)} disabled={busy === 'link-' + o.id} title="Remove this member’s access to this company"
                            className="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-red-500/10">
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 truncate mb-2">{o.email}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-slate-400 mr-0.5">Access:</span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] rounded-md px-2 py-1 border bg-amber-500/10 border-amber-500/30 text-amber-300">
                        <Building2 className="h-3 w-3 opacity-70" />{c.name}
                      </span>
                      {o.companies.filter(lc => lc.id !== c.id).map((lc) => (
                        <span key={lc.id} className="inline-flex items-center gap-1.5 text-[11px] rounded-md pl-2 pr-1 py-1 border bg-slate-800 border-slate-700 text-slate-200">
                          <Building2 className="h-3 w-3 opacity-70" />{lc.name}
                          <button onClick={() => unlinkOwner(o.id, lc.id)} disabled={busy === 'link-' + o.id} title="Remove access to this company"
                            className="rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 p-0.5">
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                      {linkOptions.length > 0 && (
                        <select value="" onChange={(e) => { if (e.target.value) linkOwner(o.id, e.target.value) }} disabled={busy === 'link-' + o.id}
                          className="text-[11px] bg-slate-800 border border-dashed border-slate-700 rounded-md px-2 py-1 text-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-500/50">
                          <option value="">+ Link company</option>
                          {linkOptions.map(co => <option key={co.id} value={co.id} className="text-slate-200 bg-slate-800">{co.name}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Danger zone — only for suspended companies */}
      {!c.is_active && (
        <div className="bg-red-500/5 border border-red-500/30 rounded-xl p-4 mt-6">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-red-400" />
            <h3 className="text-sm font-semibold text-red-300">Danger Zone</h3>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[11px] text-slate-400 max-w-md">Permanently remove <span className="text-white font-medium">{c.name}</span> and all of its data — users, cases, invoices and settings. This cannot be undone.</p>
            <button onClick={() => { setRemoveErr(''); setRemovePw(''); setRemoveStep('confirm') }}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/40 text-red-300 hover:bg-red-500/20 flex-shrink-0">
              <Trash2 className="h-3.5 w-3.5" />Remove Client
            </button>
          </div>
        </div>
      )}

      {/* Remove company — step 1: confirm */}
      {removeStep === 'confirm' && (
        <Overlay onClose={() => setRemoveStep(null)}>
          <div className="flex items-center gap-2 mb-3"><AlertTriangle className="h-5 w-5 text-red-400" /><h3 className="text-sm font-semibold text-white">Remove {c.name}?</h3></div>
          <p className="text-sm text-slate-400 mb-5">This permanently deletes the company and <strong className="text-white">all of its data</strong> — every user account, case, invoice and setting. This action cannot be undone.</p>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setRemoveStep(null)} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
            <button onClick={() => { setRemoveErr(''); setRemoveStep('password') }} className="px-4 py-2 text-sm bg-red-500 hover:bg-red-400 text-white font-semibold rounded-lg flex items-center gap-1.5">
              <Trash2 className="h-4 w-4" />Continue
            </button>
          </div>
        </Overlay>
      )}

      {/* Remove company — step 2: admin password */}
      {removeStep === 'password' && (
        <Overlay onClose={() => { setRemoveStep(null); setRemovePw('') }}>
          <div className="flex items-center gap-2 mb-3"><KeyRound className="h-5 w-5 text-red-400" /><h3 className="text-sm font-semibold text-white">Confirm with your password</h3></div>
          <p className="text-sm text-slate-400 mb-4">Enter your admin login password to permanently remove <strong className="text-white">{c.name}</strong>.</p>
          <Field label="Admin Password">
            <input type="password" value={removePw} autoFocus autoComplete="off"
              onChange={(e) => { setRemovePw(e.target.value); setRemoveErr('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') deleteCompany() }}
              className={inputCls} placeholder="••••••••" />
          </Field>
          {removeErr && <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg px-3 py-2 mt-3"><AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{removeErr}</span></div>}
          <div className="flex gap-2 justify-end mt-5">
            <button onClick={() => { setRemoveStep(null); setRemovePw('') }} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
            <button onClick={deleteCompany} disabled={busy === 'remove' || !removePw} className="px-4 py-2 text-sm bg-red-500 hover:bg-red-400 disabled:opacity-40 text-white font-semibold rounded-lg flex items-center gap-1.5">
              {busy === 'remove' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Remove Company
            </button>
          </div>
        </Overlay>
      )}

      {/* Dialogs */}
      {showPay && <RecordPaymentDialog companyId={c.id} plan={c.plan} call={call} onClose={() => setShowPay(false)} onSaved={() => { setShowPay(false); loadInvoices(); reload() }} />}
      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={() => setLightbox(null)}>
          <button className="absolute top-4 right-4 text-white/70 hover:text-white" onClick={() => setLightbox(null)}><X className="h-6 w-6" /></button>
          <img src={lightbox} alt="Payment proof" className="max-w-full max-h-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
      {confirmDeleteOwner && (
        <Overlay onClose={() => setConfirmDeleteOwner(null)}>
          <div className="flex items-center gap-2 mb-3"><AlertTriangle className="h-5 w-5 text-red-400" /><h3 className="text-sm font-semibold text-white">Delete owner account?</h3></div>
          <p className="text-sm text-slate-400 mb-5">Permanently deletes <strong className="text-white">{confirmDeleteOwner.full_name}</strong> ({confirmDeleteOwner.email}) and revokes access.</p>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setConfirmDeleteOwner(null)} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
            <button onClick={() => deleteOwner(confirmDeleteOwner)} disabled={busy === confirmDeleteOwner.id} className="px-3 py-2 text-sm bg-red-500 hover:bg-red-400 text-white rounded-lg flex items-center gap-1.5">
              {busy === confirmDeleteOwner.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete
            </button>
          </div>
        </Overlay>
      )}
      {confirmDeleteInv && (
        <Overlay onClose={() => setConfirmDeleteInv(null)}>
          <div className="flex items-center gap-2 mb-3"><AlertTriangle className="h-5 w-5 text-red-400" /><h3 className="text-sm font-semibold text-white">Delete invoice?</h3></div>
          <p className="text-sm text-slate-400 mb-5">Removes the {money(confirmDeleteInv.amount, confirmDeleteInv.currency)} payment from {fmtDate(confirmDeleteInv.payment_date)} and its proof image.</p>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setConfirmDeleteInv(null)} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
            <button onClick={() => deleteInvoice(confirmDeleteInv)} disabled={busy === confirmDeleteInv.id} className="px-3 py-2 text-sm bg-red-500 hover:bg-red-400 text-white rounded-lg flex items-center gap-1.5">
              {busy === confirmDeleteInv.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete
            </button>
          </div>
        </Overlay>
      )}
    </div>
  )
}

// ── Record payment dialog ────────────────────────────────────────────────────
// Subscription term per plan (mirrors kaizen_products.duration_days seed; the
// server is authoritative and recomputes period_end on save).
const PLAN_TERM_DAYS: Record<string, number> = { trial: 30, gold: 365, premium: 365 }

function RecordPaymentDialog({ companyId, plan, call, onClose, onSaved }: {
  companyId: string
  plan: string
  call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>
  onClose: () => void
  onSaved: () => void
}) {
  const isTrialPlan = plan === 'trial'
  const termDays = PLAN_TERM_DAYS[plan] ?? 365
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('THB')
  const [paymentDate, setPaymentDate] = useState('')
  const [notes, setNotes] = useState('')
  const [proofData, setProofData] = useState<string | null>(null)
  const [proofName, setProofName] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function pickProof(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    try { setProofData(await fileToCompressedDataUrl(file)); setProofName(file.name) }
    catch { setError('Could not read that image.') }
  }

  async function submit() {
    setError('')
    if (!paymentDate) { setError('Select the payment date.'); return }
    setSaving(true)
    try {
      await call('add_invoice', {
        company_id: companyId,
        payee: payee.trim() || undefined,
        amount: amount ? Number(amount) : undefined,
        currency,
        payment_date: paymentDate,
        notes: notes.trim() || undefined,
        proof_base64: proofData || undefined,
        proof_ext: proofData ? 'jpg' : undefined,
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to record payment.') }
    finally { setSaving(false) }
  }

  const termLabel = termDays % 365 === 0 ? `${termDays / 365}-year` : `${termDays}-day`
  const periodEndPreview = paymentDate ? (() => { const d = new Date(paymentDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + termDays); return fmtDate(d.toISOString().slice(0, 10)) })() : null

  return (
    <Overlay onClose={onClose} wide>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2"><Receipt className="h-5 w-5 text-amber-400" /><h3 className="text-sm font-semibold text-white">Record Payment</h3></div>
        <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3 max-h-[62vh] overflow-y-auto pr-1">
        {isTrialPlan && (
          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>This client is still on the <strong>Starter</strong> trial. Recording a payment now starts a <strong>30-day</strong> term. Switch the package to <strong>Gold</strong> or <strong>Premium</strong> first for a 1-year subscription.</span>
          </div>
        )}
        <Field label={`Payment Date * (starts a ${termLabel} subscription)`}>
          <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className={inputCls} autoFocus />
          {periodEndPreview && <p className="text-[11px] text-slate-400 mt-1">Valid until <span className="text-amber-400 font-medium">{periodEndPreview}</span></p>}
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2"><Field label="Amount"><input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} className={inputCls} placeholder="35000" inputMode="decimal" /></Field></div>
          <Field label="Currency"><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 4))} className={inputCls} /></Field>
        </div>
        <Field label="Payee"><input value={payee} onChange={(e) => setPayee(e.target.value)} className={inputCls} placeholder="Who paid (company / person)" /></Field>
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} placeholder="e.g. Annual renewal, bank transfer ref…" /></Field>
        <Field label="Transaction Proof (image)">
          {proofData ? (
            <div className="flex items-center gap-3">
              <img src={proofData} alt="Proof" className="w-16 h-16 rounded-lg object-cover border border-slate-700" />
              <div className="flex-1 min-w-0"><p className="text-xs text-slate-300 truncate">{proofName}</p><button onClick={() => { setProofData(null); setProofName('') }} className="text-[11px] text-red-400 hover:text-red-300">Remove</button></div>
            </div>
          ) : (
            <label className="flex items-center gap-2 justify-center h-20 rounded-lg border-2 border-dashed border-slate-700 hover:border-slate-600 cursor-pointer text-slate-400 hover:text-slate-400">
              <Upload className="h-4 w-4" /><span className="text-xs">Upload bank slip / receipt</span>
              <input type="file" accept="image/*" className="hidden" onChange={pickProof} />
            </label>
          )}
        </Field>
        {error && <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg px-3 py-2"><AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{error}</span></div>}
      </div>
      <div className="flex gap-2 justify-end pt-4 mt-2 border-t border-slate-800">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
        <button onClick={submit} disabled={saving} className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold rounded-lg flex items-center gap-1.5">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save Payment
        </button>
      </div>
    </Overlay>
  )
}

// ── Audit tab ────────────────────────────────────────────────────────────────
interface AppError {
  id: string; company_id: string | null; company_name: string | null; user_id: string | null
  source: string; message: string; detail: Record<string, unknown> | null; url: string | null
  user_agent: string | null; resolved: boolean; created_at: string
}

function AuditTab({ call }: { call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T> }) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [appErrors, setAppErrors] = useState<AppError[]>([])
  const [loading, setLoading] = useState(true)
  const [sub, setSub] = useState<'activity' | 'errors'>('activity')
  const [expanded, setExpanded] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    Promise.all([
      call<{ entries: AuditEntry[] }>('audit_log').then(d => d.entries).catch(() => [] as AuditEntry[]),
      call<{ errors: AppError[] }>('list_errors').then(d => d.errors).catch(() => [] as AppError[]),
    ]).then(([a, e]) => { setEntries(a); setAppErrors(e) }).finally(() => setLoading(false))
  }, [call])
  useEffect(() => { reload() }, [reload])

  async function resolve(id: string, resolved: boolean) {
    setAppErrors(prev => prev.map(e => e.id === id ? { ...e, resolved } : e))
    try { await call('resolve_error', { error_id: id, resolved }) } catch { reload() }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
  const activity = entries.filter(e => e.success)
  const consoleErrors = entries.filter(e => !e.success)
  const openAppErrors = appErrors.filter(e => !e.resolved)
  const errCount = consoleErrors.length + openAppErrors.length

  return (
    <div>
      <h2 className="text-base font-semibold text-white mb-1">Audit Logs</h2>
      <p className="text-xs text-slate-400 mb-3">Console events &amp; client-app errors</p>
      <div className="flex gap-1 border-b border-slate-800 mb-3">
        {([['activity', 'Activity'], ['errors', `Errors${errCount ? ` (${errCount})` : ''}`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setSub(k)} className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${sub === k ? 'border-amber-500 text-amber-400' : 'border-transparent text-slate-400 hover:text-slate-300'}`}>{label}</button>
        ))}
      </div>

      {sub === 'activity' ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl divide-y divide-slate-800 overflow-hidden">
          {activity.map((e) => (
            <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-green-400" />
              <span className="font-mono text-slate-300 w-40 flex-shrink-0">{e.action}</span>
              <span className="text-slate-400 flex-1 truncate">{JSON.stringify(e.detail)}</span>
              <span className="text-slate-300 flex-shrink-0">{e.ip}</span>
              <span className="text-slate-300 flex-shrink-0 w-32 text-right">{new Date(e.created_at).toLocaleString()}</span>
            </div>
          ))}
          {activity.length === 0 && <div className="px-4 py-8 text-center text-sm text-slate-300">No events yet.</div>}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Client-app errors */}
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Client app errors</p>
            <div className="bg-slate-900 border border-slate-800 rounded-xl divide-y divide-slate-800 overflow-hidden">
              {appErrors.map((e) => (
                <div key={e.id} className={`px-4 py-2.5 text-xs ${e.resolved ? 'opacity-50' : ''}`}>
                  <div className="flex items-center gap-3">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.resolved ? 'bg-slate-500' : 'bg-red-400'}`} />
                    <span className="font-mono text-[10px] text-slate-400 w-16 flex-shrink-0 uppercase">{e.source}</span>
                    <button onClick={() => setExpanded(expanded === e.id ? null : e.id)} className="text-slate-200 flex-1 truncate text-left hover:text-white">{e.message}</button>
                    <span className="text-slate-400 flex-shrink-0 w-32 truncate text-right">{e.company_name ?? '—'}</span>
                    <span className="text-slate-400 flex-shrink-0 w-32 text-right">{new Date(e.created_at).toLocaleString()}</span>
                    <button onClick={() => resolve(e.id, !e.resolved)} className="flex-shrink-0 text-[10px] px-2 py-0.5 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">{e.resolved ? 'Reopen' : 'Resolve'}</button>
                  </div>
                  {expanded === e.id && (
                    <div className="mt-2 ml-7 space-y-1 text-[11px] text-slate-400">
                      {e.url && <div className="truncate"><span className="text-slate-500">URL:</span> {e.url}</div>}
                      {e.detail && <pre className="whitespace-pre-wrap break-words bg-slate-950 border border-slate-800 rounded-lg p-2 text-[10px] text-slate-400 max-h-48 overflow-y-auto">{JSON.stringify(e.detail, null, 2)}</pre>}
                      {e.user_agent && <div className="truncate"><span className="text-slate-500">UA:</span> {e.user_agent}</div>}
                    </div>
                  )}
                </div>
              ))}
              {appErrors.length === 0 && <div className="px-4 py-8 text-center text-sm text-slate-300">No client-app errors logged. 🎉</div>}
            </div>
          </div>

          {/* Console errors */}
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Console errors</p>
            <div className="bg-slate-900 border border-slate-800 rounded-xl divide-y divide-slate-800 overflow-hidden">
              {consoleErrors.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-red-400" />
                  <span className="font-mono text-slate-300 w-40 flex-shrink-0">{e.action}</span>
                  <span className="text-slate-400 flex-1 truncate">{JSON.stringify(e.detail)}</span>
                  <span className="text-slate-300 flex-shrink-0">{e.ip}</span>
                  <span className="text-slate-300 flex-shrink-0 w-32 text-right">{new Date(e.created_at).toLocaleString()}</span>
                </div>
              ))}
              {consoleErrors.length === 0 && <div className="px-4 py-8 text-center text-sm text-slate-300">No console errors. 🎉</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Payments inbox ───────────────────────────────────────────────────────────
interface PaymentSub {
  id: string; company_id: string; company_name: string | null; kind: string; target: string
  target_label: string | null; amount: number | null; currency: string; proof_url: string | null
  note: string | null; status: string; created_at: string
  company_plan?: string | null; company_sub_end?: string | null; company_created_at?: string | null
  contact_person?: string | null; contact_email?: string | null; contact_phone?: string | null
  submitter_name?: string | null; submitter_role?: string | null
  list_price?: number | null; term_days?: number | null; term_label?: string | null
  pay_count?: number; last_paid?: string | null
}
interface ReceiptReq { id: string; company_id: string; company_name: string | null; amount: number | null; currency: string; payment_date: string; receipt_issued: boolean }

const PLAN_LABEL: Record<string, string> = { trial: 'Starter', gold: 'Gold', premium: 'Premium' }
const PAY_ROLE_LABEL: Record<string, string> = { super_admin: 'Top Management', manager: 'Manager', staff: 'Staff' }
const planLabel = (p?: string | null) => (p ? PLAN_LABEL[p] ?? p : '—')
const fmtDateTime = (iso?: string | null) => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

function PaymentDetail({ p }: { p: PaymentSub }) {
  const amt = p.amount ?? null
  const list = p.list_price ?? null
  const match = amt != null && list != null ? Math.abs(amt - list) < 1 : null
  const newEnd = p.term_days ? new Date(Date.now() + p.term_days * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null
  return (
    <div className="mt-2.5 pt-2.5 border-t border-slate-800 grid sm:grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-slate-500 w-20 flex-shrink-0">Amount</span>
        <span className="text-slate-200">{money(amt, p.currency)}</span>
        {list != null && (match
          ? <span className="text-green-400">✓ matches list price</span>
          : <span className="text-amber-400">⚠ list is {money(list, p.currency)}</span>)}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-slate-500 w-20 flex-shrink-0">Verification</span>
        <span className="text-amber-400">Not auto-verified — review slip</span>
      </div>
      <div className="flex items-start gap-1.5">
        <span className="text-slate-500 w-20 flex-shrink-0">{p.kind === 'subscription' ? 'Change' : 'Add-on'}</span>
        <span className="text-slate-200">
          {p.kind === 'subscription'
            ? <>{planLabel(p.company_plan)} → {p.target_label ?? p.target}{newEnd ? ` · until ${newEnd}` : ''}</>
            : <>Enables {p.target_label ?? p.target}</>}
        </span>
      </div>
      <div className="flex items-start gap-1.5">
        <span className="text-slate-500 w-20 flex-shrink-0">Current</span>
        <span className="text-slate-200">{planLabel(p.company_plan)}{p.company_sub_end ? ` · ends ${fmtDate(p.company_sub_end)}` : ''}</span>
      </div>
      <div className="flex items-start gap-1.5">
        <span className="text-slate-500 w-20 flex-shrink-0">Submitted by</span>
        <span className="text-slate-200 truncate">{p.submitter_name ?? '—'}{p.submitter_role ? ` (${PAY_ROLE_LABEL[p.submitter_role] ?? p.submitter_role})` : ''}</span>
      </div>
      <div className="flex items-start gap-1.5">
        <span className="text-slate-500 w-20 flex-shrink-0">Submitted</span>
        <span className="text-slate-200">{fmtDateTime(p.created_at)}</span>
      </div>
      <div className="flex items-start gap-1.5 sm:col-span-2">
        <span className="text-slate-500 w-20 flex-shrink-0">Contact</span>
        <span className="text-slate-200 truncate">{[p.contact_person, p.contact_phone, p.contact_email].filter(Boolean).join(' · ') || '—'}</span>
      </div>
      <div className="flex items-start gap-1.5 sm:col-span-2">
        <span className="text-slate-500 w-20 flex-shrink-0">History</span>
        <span className="text-slate-200">{p.pay_count ? `${p.pay_count} prior payment${p.pay_count === 1 ? '' : 's'}${p.last_paid ? ` · last ${fmtDate(p.last_paid)}` : ''}` : 'First payment from this client'}</span>
      </div>
      {p.note && (
        <div className="flex items-start gap-1.5 sm:col-span-2">
          <span className="text-slate-500 w-20 flex-shrink-0">Note</span>
          <span className="text-slate-200">{p.note}</span>
        </div>
      )}
      <div className="sm:col-span-2 mt-0.5 text-[10px] text-slate-500">
        Approving sets the plan{newEnd ? `, extends the subscription to ${newEnd}` : ''}, generates an invoice, and emails a receipt if email is configured.
      </div>
    </div>
  )
}
function PaymentsView({ call, onBack, reload }: { call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>; onBack: () => void; reload: () => void }) {
  const [items, setItems] = useState<PaymentSub[]>([])
  const [receipts, setReceipts] = useState<ReceiptReq[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const d = await call<{ payments: PaymentSub[]; receipt_requests: ReceiptReq[] }>('list_payments'); setItems(d.payments); setReceipts(d.receipt_requests ?? []) }
    catch (e) { console.error('Payments load failed:', e) } finally { setLoading(false) }
  }, [call])
  useEffect(() => { load() }, [load])

  async function issueReceipt(r: ReceiptReq) {
    if (!confirm(`Generate and email the receipt for ${r.company_name} to their registered email?`)) return
    setBusy(r.id)
    try { const res = await call<{ to: string }>('issue_receipt', { invoice_id: r.id }); alert(`Receipt emailed to ${res.to}`); await load(); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }

  async function approve(p: PaymentSub) {
    if (!confirm(`Approve this payment and ${p.kind === 'subscription' ? `activate the ${p.target_label ?? p.target}` : `enable ${p.target_label ?? p.target}`} for ${p.company_name}?`)) return
    setBusy(p.id)
    try { await call('approve_payment', { submission_id: p.id }); await load(); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function reject(p: PaymentSub) {
    if (!confirm('Reject this payment submission?')) return
    setBusy(p.id)
    try { await call('reject_payment', { submission_id: p.id }); await load() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }

  const pending = items.filter(i => i.status === 'pending')
  const reviewed = items.filter(i => i.status !== 'pending')

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white mb-4"><ArrowLeft className="h-3.5 w-3.5" />Back</button>
      <h2 className="text-lg font-bold text-white mb-1">Payments</h2>
      <p className="text-xs text-slate-400 mb-4">Client PromptPay submissions awaiting review. Approving activates the subscription or add-on instantly.</p>

      {/* Receipt / tax requests */}
      {receipts.filter(r => !r.receipt_issued).length > 0 && (
        <div className="mb-5">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Receipt / Tax requests</p>
          <div className="space-y-2">
            {receipts.filter(r => !r.receipt_issued).map((r) => (
              <div key={r.id} className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-3">
                <div className="w-12 h-12 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0"><FileText className="h-4 w-4 text-amber-400" /></div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{r.company_name ?? '—'}</p>
                  <p className="text-[11px] text-slate-400 truncate">{money(r.amount, r.currency)} · {fmtDate(r.payment_date)}</p>
                </div>
                <button onClick={() => issueReceipt(r)} disabled={busy === r.id} className="px-2.5 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold disabled:opacity-50">{busy === r.id ? '…' : 'Issue & send'}</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
      ) : items.length === 0 && receipts.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-400">No payment submissions yet.</p>
      ) : items.length === 0 ? null : (
        <div className="space-y-4">
          {[{ label: 'Pending', rows: pending }, { label: 'Reviewed', rows: reviewed }].filter(g => g.rows.length).map((g) => (
            <div key={g.label}>
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">{g.label}</p>
              <div className="space-y-2">
                {g.rows.map((p) => (
                  <div key={p.id} className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                    <div className="flex items-start gap-3">
                      {p.proof_url
                        ? <button onClick={() => setLightbox(p.proof_url)} className="w-12 h-12 rounded-lg overflow-hidden border border-slate-700 flex-shrink-0 hover:ring-2 hover:ring-amber-500/50"><img src={p.proof_url} alt="Slip" className="w-full h-full object-cover" /></button>
                        : <div className="w-12 h-12 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0"><Receipt className="h-4 w-4 text-slate-500" /></div>}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-white truncate">{p.company_name ?? '—'}</p>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">{p.kind === 'subscription' ? 'Subscription' : 'Add-on'}</span>
                          {p.status === 'approved' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/30">Approved</span>}
                          {p.status === 'rejected' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">Rejected</span>}
                        </div>
                        <p className="text-[11px] text-slate-400 truncate">{p.target_label ?? p.target} · {money(p.amount, p.currency)} · {fmtDate(p.created_at)}</p>
                      </div>
                      {p.status === 'pending' && (
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <button onClick={() => approve(p)} disabled={busy === p.id} className="px-2.5 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold disabled:opacity-50">{busy === p.id ? '…' : 'Approve'}</button>
                          <button onClick={() => reject(p)} disabled={busy === p.id} className="px-2.5 h-8 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 text-xs">Reject</button>
                        </div>
                      )}
                    </div>
                    {p.status === 'pending' && <PaymentDetail p={p} />}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={() => setLightbox(null)}>
          <button className="absolute top-4 right-4 text-white/70 hover:text-white" onClick={() => setLightbox(null)}><X className="h-6 w-6" /></button>
          <img src={lightbox} alt="Payment slip" className="max-w-full max-h-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}

// ── Dashboard home ───────────────────────────────────────────────────────────
function StatTile({ label, value, tone = 'slate', hint, onClick, className = '' }: { label: string; value: number | string; tone?: string; hint?: string; onClick?: () => void; className?: string }) {
  const tones: Record<string, string> = { slate: 'text-white', green: 'text-green-400', sky: 'text-sky-400', amber: 'text-amber-400', violet: 'text-violet-400' }
  const C = onClick ? 'button' : 'div'
  return (
    <C onClick={onClick} title={hint} className={`bg-slate-900 border border-slate-800 rounded-xl p-4 text-left ${className} ${onClick ? 'hover:border-slate-700 transition-colors' : ''}`}>
      <p className={`text-2xl font-bold leading-none ${tones[tone]}`}>{value}</p>
      <p className="text-[11px] text-slate-400 mt-1.5">{label}</p>
      {hint && <p className="text-[10px] text-slate-500 mt-0.5 truncate">{hint}</p>}
    </C>
  )
}
function MoneyCard({ icon: Icon, label, value, tone, onClick }: { icon: typeof Wallet; label: string; value: string; tone: string; onClick?: () => void }) {
  const ring: Record<string, string> = { green: 'text-green-400 bg-green-500/10', amber: 'text-amber-400 bg-amber-500/10', red: 'text-red-400 bg-red-500/10' }
  const C = onClick ? 'button' : 'div'
  return (
    <C onClick={onClick} className={`bg-slate-900 border border-slate-800 rounded-xl p-4 text-left flex items-center gap-3 ${onClick ? 'hover:border-slate-700 transition-colors' : ''}`}>
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${ring[tone]}`}><Icon className="h-5 w-5" /></div>
      <div className="min-w-0"><p className="text-lg font-bold text-white leading-none truncate">{value}</p><p className="text-[11px] text-slate-400 mt-1">{label}</p></div>
    </C>
  )
}
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const PIE_PALETTE = ['#f59e0b', '#8b5cf6', '#22c55e', '#06b6d4', '#ec4899', '#f97316', '#14b8a6', '#64748b']

interface FinRow { amount: number | null; payment_date?: string; created_at?: string; status?: string; kind?: string; target?: string; target_label?: string | null }

function DashboardHome({ companies, metrics, call, onView, onOpenClient }: { companies: ConsoleCompany[]; metrics: Metrics | null; call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>; onView: (v: View) => void; onOpenClient: (id: string) => void }) {
  const total = companies.length
  const active = companies.filter(c => c.is_active).length
  const starter = companies.filter(c => c.plan === 'trial').length
  const gold = companies.filter(c => c.plan === 'gold').length
  const premium = companies.filter(c => c.plan === 'premium').length
  // Conversion = clients who upgraded to a paid tier (Trial→Gold, Trial→Premium,
  // Gold→Premium are all captured by being on Gold or Premium now) ÷ all clients on a plan.
  const planned = starter + gold + premium
  const converted = gold + premium
  const conversionRate = planned > 0 ? Math.round((converted / planned) * 100) : 0
  const conv = metrics?.conversions
  const baht = (n: number) => `฿${(n || 0).toLocaleString()}`
  // Conversion transition percentages (denominator = the source population).
  const pct = (n: number, base: number) => base > 0 ? Math.round((n / base) * 100) : 0
  const goldEver = gold + (conv?.gold_to_premium ?? 0) // clients who ever reached Gold
  const tgPct = pct(conv?.trial_to_gold ?? 0, planned)
  const tpPct = pct(conv?.trial_to_premium ?? 0, planned)
  const gpPct = pct(conv?.gold_to_premium ?? 0, goldEver)
  // Clients whose subscription is expiring soon (≤14 days) or expired.
  const attention = companies.filter(c => c.subscription && (c.subscription.overdue || (c.subscription.days_remaining != null && c.subscription.days_remaining <= 14)))

  // ── Revenue period filter (Month / Year / All-time) ────────────────────────
  const now = new Date()
  const [mode, setMode] = useState<'month' | 'year' | 'all'>('month')
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [invoices, setInvoices] = useState<FinRow[]>([])
  const [submissions, setSubmissions] = useState<FinRow[]>([])
  useEffect(() => {
    call<{ invoices: FinRow[]; submissions: FinRow[] }>('finance')
      .then(d => { setInvoices(d.invoices ?? []); setSubmissions(d.submissions ?? []) })
      .catch(() => { /* leave empty */ })
  }, [call])

  const years = useMemo(() => {
    const s = new Set<number>([now.getFullYear()])
    invoices.forEach(r => { if (r.payment_date) s.add(new Date(r.payment_date).getFullYear()) })
    submissions.forEach(r => { if (r.created_at) s.add(new Date(r.created_at).getFullYear()) })
    return Array.from(s).sort((a, b) => b - a)
  }, [invoices, submissions, now])

  const inPeriod = (iso?: string) => {
    if (mode === 'all') return true
    if (!iso) return false
    const d = new Date(iso)
    if (d.getFullYear() !== year) return false
    return mode === 'year' ? true : d.getMonth() === month
  }
  const sum = (arr: FinRow[], ok: (r: FinRow) => boolean) => arr.reduce((s, r) => s + (ok(r) ? Number(r.amount) || 0 : 0), 0)
  const pRevenue = sum(invoices, r => inPeriod(r.payment_date))
  const pOpportunity = sum(submissions, r => r.status === 'pending' && inPeriod(r.created_at))
  const pLost = sum(submissions, r => r.status === 'rejected' && inPeriod(r.created_at))

  // Revenue composition = approved sales grouped by product (Gold, Premium, PMS, add-ons, …).
  const prodMap: Record<string, number> = {}
  submissions.forEach(s => {
    if (s.status !== 'approved' || !inPeriod(s.created_at)) return
    const name = (s.target_label || s.target || 'Other').toString()
    prodMap[name] = (prodMap[name] || 0) + (Number(s.amount) || 0)
  })
  const pieData = Object.entries(prodMap)
    .map(([name, value], i) => ({ name, value, color: PIE_PALETTE[i % PIE_PALETTE.length] }))
    .sort((a, b) => b.value - a.value)
  const pieSlices = pieData.filter(d => d.value > 0)
  const pieTotal = pieSlices.reduce((s, d) => s + d.value, 0)

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth()
  const periodLabel = mode === 'all' ? 'All time' : mode === 'year' ? String(year) : `${MONTHS_LONG[month]} ${year}`
  const stepMonth = (delta: number) => {
    let m = month + delta, y = year
    if (m < 0) { m = 11; y -= 1 } else if (m > 11) { m = 0; y += 1 }
    setMonth(m); setYear(y)
  }

  return (
    <div>
      <h2 className="text-lg font-bold text-white mb-4">Dashboard</h2>

      {/* Clients · plans (row 1) · conversion rate · transitions (row 2) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatTile label="Total clients" value={total} onClick={() => onView('clients')} />
        <StatTile label="Active" value={active} tone="green" />
        <StatTile label="Starter" value={starter} tone="sky" />
        <StatTile label="Gold" value={gold} tone="amber" />
        <StatTile label="Premium" value={premium} tone="violet" />

        <div className="col-span-2 sm:col-span-3 lg:col-span-5 h-px bg-slate-700/70 my-1" />

        <StatTile label="Conversion rate" value={`${conversionRate}%`} tone="green" hint={`${converted} of ${planned} on a paid tier`} className="col-span-2" />
        <StatTile label="Trial → Gold" value={`${tgPct}%`} tone="sky" hint={`${conv?.trial_to_gold ?? 0} of ${planned} clients`} />
        <StatTile label="Trial → Premium" value={`${tpPct}%`} tone="amber" hint={`${conv?.trial_to_premium ?? 0} of ${planned} clients`} />
        <StatTile label="Gold → Premium" value={`${gpPct}%`} tone="violet" hint={`${conv?.gold_to_premium ?? 0} of ${goldEver} gold clients`} />
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5">
          {(['month', 'year', 'all'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-2.5 h-7 rounded-md text-xs font-medium transition-colors ${mode === m ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'}`}>
              {m === 'month' ? 'Month' : m === 'year' ? 'Year' : 'All time'}
            </button>
          ))}
        </div>
        {mode !== 'all' && (
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="h-8 rounded-lg bg-slate-900 border border-slate-800 text-sm text-white px-2 focus:outline-none focus:ring-2 focus:ring-amber-500/50">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        )}
        {mode === 'month' && (
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg px-1 h-8">
            <button onClick={() => stepMonth(-1)} className="p-1 text-slate-400 hover:text-white"><ChevronLeft className="h-4 w-4" /></button>
            <span className="min-w-[96px] text-center text-sm font-medium text-white">{isCurrentMonth ? 'This Month' : MONTHS_LONG[month]}</span>
            <button onClick={() => stepMonth(1)} className="p-1 text-slate-400 hover:text-white"><ChevronRight className="h-4 w-4" /></button>
          </div>
        )}
        <span className="text-[11px] text-slate-500 ml-1">{periodLabel}</span>
      </div>

      {/* Revenue composition + figures */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-0.5">Revenue composition</h3>
          <p className="text-[11px] text-slate-400 mb-3">Approved sales by product · {periodLabel}</p>
          <div className="flex items-center gap-4">
            <div className="relative flex-shrink-0" style={{ width: 130, height: 130 }}>
              {pieTotal === 0 ? (
                <div className="w-full h-full rounded-full border-[14px] border-slate-800 flex items-center justify-center"><span className="text-slate-500 text-[10px]">No data</span></div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieSlices} cx="50%" cy="50%" innerRadius={40} outerRadius={62} paddingAngle={pieSlices.length > 1 ? 3 : 0} dataKey="value" startAngle={90} endAngle={-270}>
                        {pieSlices.map((e, i) => <Cell key={i} fill={e.color} stroke="none" />)}
                      </Pie>
                      <Tooltip formatter={(v: number, n: string) => [baht(v), n]} contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-sm font-bold text-white leading-none">{baht(pieTotal)}</span>
                    <span className="text-[9px] text-slate-500 mt-0.5">Total</span>
                  </div>
                </>
              )}
            </div>
            <div className="flex-1 min-w-0 space-y-2">
              {pieData.map(d => (
                <div key={d.name} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0"><span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} /><span className="text-xs text-slate-300 truncate">{d.name}</span></div>
                  <span className="text-xs font-semibold text-white flex-shrink-0">{baht(d.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <MoneyCard icon={Wallet} label="Revenue recorded" value={baht(pRevenue)} tone="green" />
          <MoneyCard icon={TrendingUp} label="Sales opportunity (pending)" value={baht(pOpportunity)} tone="amber" onClick={() => onView('payments')} />
          <MoneyCard icon={TrendingDown} label="Opportunity lost" value={baht(pLost)} tone="red" />
        </div>
      </div>

      {attention.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-2">Needs attention · renewals</h3>
          <div className="space-y-1.5">
            {attention.slice(0, 6).map((c) => (
              <button key={c.id} onClick={() => onOpenClient(c.id)} className="w-full flex items-center gap-2 text-left text-sm hover:bg-slate-800 rounded-lg px-2 py-1.5">
                <span className="flex-1 truncate text-slate-200">{c.name}</span>
                <SubscriptionBadge sub={c.subscription} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Notifications ────────────────────────────────────────────────────────────
interface ConsoleNotif { id: string; type: string; company_id: string | null; company_name: string | null; title: string; body: string | null; read: boolean; created_at: string }
function NotificationsView({ call, onGo, onOpenClient }: { call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>; onGo: (v: View) => void; onOpenClient: (id: string) => void }) {
  const [pay, setPay] = useState<{ payments: PaymentSub[]; receipt_requests: ReceiptReq[] } | null>(null)
  const [errors, setErrors] = useState<AuditEntry[]>([])
  const [notifs, setNotifs] = useState<ConsoleNotif[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    (async () => {
      try {
        const [p, a, n] = await Promise.all([
          call<{ payments: PaymentSub[]; receipt_requests: ReceiptReq[] }>('list_payments'),
          call<{ entries: AuditEntry[] }>('audit_log'),
          call<{ notifications: ConsoleNotif[] }>('list_notifications'),
        ])
        setPay(p); setErrors((a.entries ?? []).filter(e => !e.success).slice(0, 8)); setNotifs(n.notifications ?? [])
      } catch (e) { console.error(e) } finally { setLoading(false) }
    })()
  }, [call])
  async function openNotif(n: ConsoleNotif) {
    if (!n.read) { setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x)); try { await call('mark_notification_read', { notification_id: n.id }) } catch { /* ignore */ } }
    if (n.company_id) onOpenClient(n.company_id)
  }
  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
  const pendingPay = (pay?.payments ?? []).filter(p => p.status === 'pending')
  const pendingRcpt = (pay?.receipt_requests ?? []).filter(r => !r.receipt_issued)
  const nothing = !pendingPay.length && !pendingRcpt.length && !errors.length && !notifs.length
  return (
    <div>
      <h2 className="text-lg font-bold text-white mb-4">Notifications</h2>
      {nothing && <p className="py-12 text-center text-sm text-slate-400">You're all caught up. 🎉</p>}
      {notifs.map((n) => (
        <button key={n.id} onClick={() => openNotif(n)} className="w-full flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4 mb-2 text-left hover:border-slate-700">
          <div className="w-10 h-10 rounded-lg bg-violet-500/10 text-violet-400 flex items-center justify-center flex-shrink-0"><Sparkles className="h-5 w-5" /></div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white flex items-center gap-2">{n.title}{!n.read && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />}</p>
            <p className="text-[11px] text-slate-400 truncate">{n.body}</p>
            <p className="text-[10px] text-slate-500 mt-0.5">{new Date(n.created_at).toLocaleString()}</p>
          </div>
          <ChevronRight className="h-4 w-4 text-slate-500 flex-shrink-0" />
        </button>
      ))}
      {pendingPay.length > 0 && (
        <button onClick={() => onGo('payments')} className="w-full flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4 mb-2 text-left hover:border-slate-700">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center"><Receipt className="h-5 w-5" /></div>
          <div className="flex-1"><p className="text-sm font-semibold text-white">{pendingPay.length} payment{pendingPay.length === 1 ? '' : 's'} awaiting review</p><p className="text-[11px] text-slate-400">Approve to activate the client's plan or add-on.</p></div>
          <ChevronRight className="h-4 w-4 text-slate-500" />
        </button>
      )}
      {pendingRcpt.length > 0 && (
        <button onClick={() => onGo('payments')} className="w-full flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4 mb-2 text-left hover:border-slate-700">
          <div className="w-10 h-10 rounded-lg bg-sky-500/10 text-sky-400 flex items-center justify-center"><FileText className="h-5 w-5" /></div>
          <div className="flex-1"><p className="text-sm font-semibold text-white">{pendingRcpt.length} receipt request{pendingRcpt.length === 1 ? '' : 's'}</p><p className="text-[11px] text-slate-400">Issue &amp; send a tax invoice / receipt.</p></div>
          <ChevronRight className="h-4 w-4 text-slate-500" />
        </button>
      )}
      {errors.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mt-2">
          <div className="flex items-center gap-2 mb-2"><AlertTriangle className="h-4 w-4 text-red-400" /><h3 className="text-sm font-semibold text-white">Recent errors</h3><button onClick={() => onGo('audit')} className="ml-auto text-[11px] text-amber-400">View all</button></div>
          <div className="space-y-1">
            {errors.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-xs"><span className="w-1.5 h-1.5 rounded-full bg-red-400" /><span className="font-mono text-slate-300 w-36 truncate">{e.action}</span><span className="text-slate-500 flex-1 truncate">{JSON.stringify(e.detail)}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── To-Do Lists ──────────────────────────────────────────────────────────────
function TodosView({ call }: { call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T> }) {
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [autoFix, setAutoFix] = useState(false)
  const [newTodo, setNewTodo] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try { const s = await call<{ company: ConsoleSettings | null }>('get_settings'); setTodos(s.company?.todos ?? []); setAutoFix(!!(s.company as { auto_fix?: boolean } | null)?.auto_fix) }
    catch (e) { console.error(e) } finally { setLoading(false) }
  }, [call])
  useEffect(() => { load() }, [load])
  async function saveTodos(next: TodoItem[]) { setTodos(next); try { await call('update_settings', { todos: next }) } catch (e) { alert(e instanceof Error ? e.message : 'Failed') } }
  async function toggleAuto() { const v = !autoFix; setAutoFix(v); try { await call('update_settings', { auto_fix: v }) } catch (e) { alert(e instanceof Error ? e.message : 'Failed') } }
  function add() { const t = newTodo.trim(); if (!t) return; saveTodos([...todos, { id: `t${Date.now()}`, text: t, done: false }]); setNewTodo('') }
  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
  const open = todos.filter(t => !t.done); const done = todos.filter(t => t.done)
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-bold text-white mb-1">To-Do Lists</h2>
      <p className="text-xs text-slate-400 mb-4">Pending work, ideas and future plans. Tick when done, or ask to build any of these.</p>

      <div className="flex items-center gap-2 mb-4">
        <input value={newTodo} onChange={(e) => setNewTodo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add a task or idea…" className={inputCls + ' flex-1'} />
        <button onClick={add} className="flex items-center gap-1 px-3 h-9 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold"><Plus className="h-3.5 w-3.5" />Add</button>
      </div>

      <div className="space-y-1.5">
        {open.length === 0 && <p className="text-xs text-slate-500">No open tasks.</p>}
        {open.map((it) => (
          <div key={it.id} className="flex items-start gap-2 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
            <input type="checkbox" checked={it.done} onChange={() => saveTodos(todos.map(x => x.id === it.id ? { ...x, done: !x.done } : x))} className="accent-amber-500 mt-0.5" />
            <span className="flex-1 text-sm text-slate-200">{it.text}</span>
            <button onClick={() => saveTodos(todos.filter(x => x.id !== it.id))} className="text-slate-500 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
      </div>
      {done.length > 0 && (
        <div className="mt-4">
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Done</p>
          <div className="space-y-1.5">
            {done.map((it) => (
              <div key={it.id} className="flex items-start gap-2 bg-slate-800/30 rounded-lg px-3 py-2">
                <input type="checkbox" checked={it.done} onChange={() => saveTodos(todos.map(x => x.id === it.id ? { ...x, done: !x.done } : x))} className="accent-amber-500 mt-0.5" />
                <span className="flex-1 text-sm text-slate-500 line-through">{it.text}</span>
                <button onClick={() => saveTodos(todos.filter(x => x.id !== it.id))} className="text-slate-600 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Auto-Fix */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mt-6">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input type="checkbox" checked={autoFix} onChange={toggleAuto} className="accent-amber-500 mt-0.5" />
          <span>
            <span className="text-sm font-medium text-white">Auto-Fix (experimental)</span>
            <span className="block text-[11px] text-slate-400">When on, the system auto-applies safe remediations for known, recurring issues and logs them to the Audit Log. Genuine code bugs are still flagged for the developer — true code fixes can't be applied automatically.</span>
          </span>
        </label>
      </div>
    </div>
  )
}

// ── Create company dialog ────────────────────────────────────────────────────
function CreateCompanyDialog({ call, onClose, onCreated }: {
  call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [plan, setPlan] = useState('trial')
  const [maxMgr, setMaxMgr] = useState('')
  const [maxStaff, setMaxStaff] = useState('')
  // Owner account
  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function onName(v: string) {
    setName(v)
    setSlug(v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
  }

  async function submit() {
    setError('')
    if (!name.trim() || !slug.trim()) { setError('Company name is required.'); return }
    if (!ownerName.trim() || !ownerEmail.trim() || ownerPassword.length < 6) {
      setError('Owner full name, email, and a password of at least 6 characters are required.')
      return
    }
    setSaving(true)
    try {
      // Create the company AND its owner together (server rolls back the
      // company if the owner can't be created).
      const res = await call<{ company_id: string; linked_existing?: boolean; owner_name?: string }>('create_owner', {
        full_name: ownerName.trim(),
        email: ownerEmail.trim(),
        password: ownerPassword,
        job_title: 'Owner',
        is_active: true,
        company_ids: [],
        new_company: {
          name: name.trim(), slug: slug.trim(), plan,
          max_managers: maxMgr ? Number(maxMgr) : null,
          max_staff: maxStaff ? Number(maxStaff) : null,
        },
      })
      if (res.linked_existing) {
        alert(`Company created. The existing owner "${res.owner_name}" was linked to it — their current login works, and the password you entered was ignored.`)
      }
      onCreated(res.company_id)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to create company.') }
    finally { setSaving(false) }
  }

  return (
    <Overlay onClose={onClose} wide>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2"><Building2 className="h-5 w-5 text-amber-400" /><h3 className="text-sm font-semibold text-white">New Client</h3></div>
        <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3 max-h-[62vh] overflow-y-auto pr-1">
        <Field label="Company Name *"><input value={name} onChange={(e) => onName(e.target.value)} className={inputCls} placeholder="e.g. The Grand Resort" autoFocus /></Field>
        <Field label="Slug *">
          <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))} className={inputCls} placeholder="grand-resort" />
          <p className="text-[11px] text-slate-400 mt-1">Unique identifier — auto-generated from the name.</p>
        </Field>
        <div>
          <p className="text-xs font-medium text-slate-400 mb-1.5">Package</p>
          <div className="grid grid-cols-3 gap-2">
            {PACKAGES.map((p) => {
              const active = plan === p.key
              return (
                <button key={p.key} type="button" onClick={() => setPlan(p.key)}
                  className={`rounded-lg border px-2 py-2 text-left ${active ? packageBadgeCls(p.key) : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}>
                  <div className="flex items-center gap-1">
                    {p.key === 'premium' && <Crown className="h-3 w-3" />}
                    <span className="text-xs font-semibold">{p.label}</span>
                    {active && <Check className="h-3 w-3 ml-auto" />}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max Managers"><input value={maxMgr} onChange={(e) => setMaxMgr(e.target.value.replace(/[^0-9]/g, ''))} className={inputCls} placeholder="Unlimited" inputMode="numeric" /></Field>
          <Field label="Max Staff"><input value={maxStaff} onChange={(e) => setMaxStaff(e.target.value.replace(/[^0-9]/g, ''))} className={inputCls} placeholder="Unlimited" inputMode="numeric" /></Field>
        </div>

        {/* Owner account — becomes the super admin of this company */}
        <div className="border-t border-slate-800 pt-3 mt-1">
          <div className="flex items-center gap-1.5 mb-2">
            <Crown className="h-3.5 w-3.5 text-amber-400" />
            <p className="text-xs font-semibold text-white">Owner Account</p>
          </div>
          <p className="text-[11px] text-slate-400 mb-2.5">The Owner is the super admin of this company. If this email already belongs to an owner, they&apos;ll be linked to this company instead (same login — they can switch between their companies).</p>
          <div className="space-y-2.5">
            <Field label="Full Name *"><input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} className={inputCls} placeholder="e.g. John Smith" /></Field>
            <Field label="Email *"><input type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} className={inputCls} placeholder="owner@company.com" autoComplete="off" /></Field>
            <Field label="Password *">
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} className={inputCls + ' pr-9'} placeholder="Min. 6 chars" autoComplete="new-password" />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-300">
                  {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </Field>
          </div>
        </div>

        {error && <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg px-3 py-2"><AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{error}</span></div>}
      </div>
      <div className="flex gap-2 justify-end pt-4 mt-2 border-t border-slate-800">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
        <button onClick={submit} disabled={saving} className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold rounded-lg flex items-center gap-1.5">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Create Company
        </button>
      </div>
    </Overlay>
  )
}

// ── Create owner dialog ──────────────────────────────────────────────────────
function CreateOwnerDialog({ preselectCompanyId, call, onClose, onCreated }: {
  preselectCompanyId?: string | null
  call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>
  onClose: () => void
  onCreated: () => void
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // When the email already belongs to an existing account, ask to confirm a cross-company link
  const [confirmInfo, setConfirmInfo] = useState<{ name: string; company: string | null } | null>(null)

  async function submit(confirmLink = false) {
    setError('')
    if (!fullName.trim() || !email.trim() || password.length < 6) { setError('Full name, email, and a password of at least 6 characters are required.'); return }
    if (!preselectCompanyId) { setError('No company selected.'); return }
    setSaving(true)
    try {
      const res = await call<{ requires_confirmation?: boolean; existing_name?: string; existing_company?: string | null }>('create_owner', {
        full_name: fullName.trim(), email: email.trim(), password,
        job_title: jobTitle.trim(), is_active: isActive,
        company_ids: [preselectCompanyId],
        confirm_link: confirmLink,
      })
      if (res?.requires_confirmation) {
        setConfirmInfo({ name: res.existing_name ?? fullName.trim(), company: res.existing_company ?? null })
        return
      }
      onCreated()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to create member.') }
    finally { setSaving(false) }
  }

  return (
    <Overlay onClose={onClose} wide>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2"><Crown className="h-5 w-5 text-amber-400" /><h3 className="text-sm font-semibold text-white">Add Top Management</h3></div>
        <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
        <Field label="Full Name *"><input value={fullName} onChange={e => setFullName(e.target.value)} className={inputCls} placeholder="e.g. John Smith" autoFocus /></Field>
        <Field label="Email *"><input type="email" value={email} onChange={e => { setEmail(e.target.value); setConfirmInfo(null) }} className={inputCls} placeholder="owner@company.com" autoComplete="off" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Password *">
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className={inputCls + ' pr-9'} placeholder="Min. 6 chars" autoComplete="new-password" />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-300">{showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
            </div>
          </Field>
          <Field label="Job Title"><input value={jobTitle} onChange={e => setJobTitle(e.target.value)} className={inputCls} placeholder="e.g. General Manager" /></Field>
        </div>
        <p className="text-[11px] text-slate-400 -mt-1">Enter <span className="text-amber-400 font-medium">Owner</span> to grant full owner authority over the company. Leave other titles for Top Management.</p>
        <label className="flex items-center gap-2.5 pt-1 cursor-pointer">
          <button type="button" onClick={() => setIsActive(!isActive)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${isActive ? 'bg-amber-500' : 'bg-slate-700'}`}>
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-slate-900 transition-transform ${isActive ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
          <span className="text-sm text-slate-300">Account active</span>
        </label>
        {confirmInfo && (
          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>
              {confirmInfo.name} already has an account{confirmInfo.company ? ` under ${confirmInfo.company}` : ' in another company'}.
              Adding will grant this existing member cross-company access to this company (not a new account). Add anyway?
            </span>
          </div>
        )}
        {error && <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg px-3 py-2"><AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{error}</span></div>}
      </div>
      <div className="flex gap-2 justify-end pt-4 mt-2 border-t border-slate-800">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
        {confirmInfo ? (
          <button onClick={() => submit(true)} disabled={saving} className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold rounded-lg flex items-center gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Add Anyway
          </button>
        ) : (
          <button onClick={() => submit()} disabled={saving} className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold rounded-lg flex items-center gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Create User
          </button>
        )}
      </div>
    </Overlay>
  )
}

// ── Shared bits ──────────────────────────────────────────────────────────────
// ── Admin Settings ─────────────────────────────────────────────────────────
interface ConsoleAdmin { id: string; username: string; display_name: string | null; email: string | null; is_active: boolean; created_at: string }
interface TodoItem { id: string; text: string; done: boolean }
interface ConsoleSettings { company_name: string | null; office_type: string; branch_name: string | null; address: string | null; tax_id: string | null; logo_url?: string | null; signatory_name?: string | null; signatory_title?: string | null; phone?: string | null; email?: string | null; website?: string | null; promptpay_id?: string | null; promptpay_name?: string | null; promptpay_qr?: string | null; support_email?: string | null; todos?: TodoItem[] | null }

// Read an image file and downscale it to a compact data URL (keeps stored logo small).
function fileToResizedDataUrl(file: File, max = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Invalid image'))
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('Canvas unsupported'))
        ctx.drawImage(img, 0, 0, w, h)
        // PNG preserves transparency for logos.
        resolve(canvas.toDataURL('image/png'))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

function AdminSettingsView({ call, onBack }: { call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>; onBack: () => void }) {
  const [loading, setLoading] = useState(true)
  const [admins, setAdmins] = useState<ConsoleAdmin[]>([])
  const [company, setCompany] = useState<ConsoleSettings | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // admin editing
  const [editId, setEditId] = useState<string | null>(null)
  const [eUser, setEUser] = useState(''); const [eName, setEName] = useState(''); const [eEmail, setEEmail] = useState(''); const [ePass, setEPass] = useState('')
  const [adding, setAdding] = useState(false)
  const [nUser, setNUser] = useState(''); const [nName, setNName] = useState(''); const [nEmail, setNEmail] = useState(''); const [nPass, setNPass] = useState('')

  // company editing
  const [editCo, setEditCo] = useState(false)
  const [co, setCo] = useState<ConsoleSettings>({ company_name: '', office_type: 'head_office', branch_name: '', address: '', tax_id: '', signatory_name: '', signatory_title: '', phone: '', email: '', website: '', promptpay_id: '', promptpay_name: '', support_email: '' })


  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await call<{ admins: ConsoleAdmin[]; company: ConsoleSettings | null }>('get_settings')
      setAdmins(d.admins); setCompany(d.company)
    } catch (e) { console.error('Console load failed:', e) } finally { setLoading(false) }
  }, [call])
  useEffect(() => { load() }, [load])

  function startEdit(a: ConsoleAdmin) { setEditId(a.id); setEUser(a.username); setEName(a.display_name ?? ''); setEEmail(a.email ?? ''); setEPass('') }
  async function saveAdmin(id: string) {
    if (ePass && ePass.length < 6) { alert('Password must be at least 6 characters.'); return }
    setBusy('admin')
    try { await call('update_admin', { admin_id: id, username: eUser.trim(), display_name: eName.trim(), email: eEmail.trim(), password: ePass || undefined }); setEditId(null); load() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function addAdmin() {
    if (!nUser.trim() || nPass.length < 6) { alert('Username and a password of at least 6 characters are required.'); return }
    setBusy('add')
    try { await call('add_admin', { username: nUser.trim(), display_name: nName.trim(), email: nEmail.trim(), password: nPass }); setAdding(false); setNUser(''); setNName(''); setNEmail(''); setNPass(''); load() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function delAdmin(a: ConsoleAdmin) {
    if (!confirm(`Remove admin "${a.username}"? They will no longer be able to sign in to the console.`)) return
    setBusy(a.id)
    try { await call('delete_admin', { admin_id: a.id }); load() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  function startCoEdit() {
    setCo({
      company_name: company?.company_name ?? '', office_type: company?.office_type ?? 'head_office',
      branch_name: company?.branch_name ?? '', address: company?.address ?? '', tax_id: company?.tax_id ?? '',
      signatory_name: company?.signatory_name ?? '', signatory_title: company?.signatory_title ?? '',
      phone: company?.phone ?? '', email: company?.email ?? '', website: company?.website ?? '',
      promptpay_id: company?.promptpay_id ?? '', promptpay_name: company?.promptpay_name ?? '', support_email: company?.support_email ?? '',
    })
    setEditCo(true)
  }
  async function saveCo() {
    setBusy('co')
    try {
      await call('update_settings', {
        company_name: co.company_name, office_type: co.office_type,
        branch_name: co.office_type === 'branch' ? co.branch_name : null,
        address: co.address, tax_id: co.tax_id,
        signatory_name: co.signatory_name, signatory_title: co.signatory_title,
        phone: co.phone, email: co.email, website: co.website,
        promptpay_id: co.promptpay_id, promptpay_name: co.promptpay_name, support_email: co.support_email,
      })
      setEditCo(false); load()
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }

  const logoInputRef = useRef<HTMLInputElement>(null)
  async function onLogoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return }
    setBusy('logo')
    try {
      const dataUrl = await fileToResizedDataUrl(file, 400)
      await call('update_settings', { logo_url: dataUrl })
      load()
    } catch (err) { alert(err instanceof Error ? err.message : 'Upload failed') } finally { setBusy(null) }
  }
  async function removeLogo() {
    if (!confirm('Remove the company logo?')) return
    setBusy('logo')
    try { await call('update_settings', { logo_url: null }); load() }
    catch (err) { alert(err instanceof Error ? err.message : 'Failed') } finally { setBusy(null) }
  }
  const qrInputRef = useRef<HTMLInputElement>(null)
  async function onQrPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return }
    setBusy('qr')
    try { await call('update_settings', { promptpay_qr: await fileToResizedDataUrl(file, 600) }); load() }
    catch (err) { alert(err instanceof Error ? err.message : 'Upload failed') } finally { setBusy(null) }
  }
  async function removeQr() {
    if (!confirm('Remove the PromptPay QR?')) return
    setBusy('qr')
    try { await call('update_settings', { promptpay_qr: null }); load() }
    catch (err) { alert(err instanceof Error ? err.message : 'Failed') } finally { setBusy(null) }
  }

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white mb-4">
        <ArrowLeft className="h-3.5 w-3.5" />Back
      </button>
      <h2 className="text-lg font-bold text-white mb-1">Admin Settings</h2>
      <p className="text-xs text-slate-400 mb-5">Console access &amp; your company details for invoicing</p>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
      ) : (
        <div className="space-y-4">
          {/* Console Administrators */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <KeyRound className="h-4 w-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-white">Console Login &amp; Administrators</h3>
              {!adding && (
                <button onClick={() => setAdding(true)} className="ml-auto flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300">
                  <UserPlus className="h-3.5 w-3.5" />Add User
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mb-3">These accounts can sign in to this System Console. Email is used for password-reset notifications.</p>

            <div className="space-y-2">
              {admins.map((a) => (
                <div key={a.id} className="bg-slate-800 rounded-lg p-3">
                  {editId === a.id ? (
                    <div className="space-y-2.5">
                      <Field label="Username"><input value={eUser} onChange={(e) => setEUser(e.target.value)} className={inputCls} autoComplete="off" /></Field>
                      <Field label="Display Name (shown in welcome bar)"><input value={eName} onChange={(e) => setEName(e.target.value)} className={inputCls} placeholder="e.g. Poti" autoComplete="off" /></Field>
                      <Field label="Admin Email (for password reset)"><input type="email" value={eEmail} onChange={(e) => setEEmail(e.target.value)} className={inputCls} placeholder="admin@nnr-solutions.com" autoComplete="off" /></Field>
                      <Field label="New Password (leave blank to keep)"><input type="text" value={ePass} onChange={(e) => setEPass(e.target.value)} className={inputCls} placeholder="••••••••" autoComplete="new-password" /></Field>
                      <div className="flex items-center gap-2 pt-1">
                        <button onClick={() => saveAdmin(a.id)} disabled={busy === 'admin'} className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold disabled:opacity-50">
                          {busy === 'admin' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Save
                        </button>
                        <button onClick={() => setEditId(null)} className="px-3 h-8 rounded-lg text-slate-400 hover:bg-slate-800 text-xs">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center shrink-0"><UserCog className="h-4 w-4 text-slate-300" /></div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white truncate">{a.display_name || a.username}{a.display_name && <span className="text-slate-500 font-normal"> · {a.username}</span>}</p>
                        <p className="text-[11px] text-slate-400 truncate flex items-center gap-1"><Mail className="h-3 w-3" />{a.email || 'no email set'}</p>
                      </div>
                      <button onClick={() => startEdit(a)} className="p-1.5 rounded text-slate-400 hover:text-amber-400 hover:bg-slate-800"><Pencil className="h-3.5 w-3.5" /></button>
                      {admins.length > 1 && (
                        <button onClick={() => delAdmin(a)} disabled={busy === a.id} className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-slate-800">
                          {busy === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {adding && (
                <div className="bg-slate-800 rounded-lg p-3 border border-amber-500/30 space-y-2.5">
                  <p className="text-xs font-semibold text-amber-400">New Administrator</p>
                  <Field label="Username"><input value={nUser} onChange={(e) => setNUser(e.target.value)} className={inputCls} placeholder="username" autoComplete="off" /></Field>
                  <Field label="Display Name (shown in welcome bar)"><input value={nName} onChange={(e) => setNName(e.target.value)} className={inputCls} placeholder="e.g. Poti" autoComplete="off" /></Field>
                  <Field label="Admin Email"><input type="email" value={nEmail} onChange={(e) => setNEmail(e.target.value)} className={inputCls} placeholder="admin@nnr-solutions.com" autoComplete="off" /></Field>
                  <Field label="Password (min 6 chars)"><input type="text" value={nPass} onChange={(e) => setNPass(e.target.value)} className={inputCls} placeholder="••••••••" autoComplete="new-password" /></Field>
                  <div className="flex items-center gap-2 pt-1">
                    <button onClick={addAdmin} disabled={busy === 'add' || !nUser || nPass.length < 6} className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold disabled:opacity-50">
                      {busy === 'add' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Create
                    </button>
                    <button onClick={() => setAdding(false)} className="px-3 h-8 rounded-lg text-slate-400 hover:bg-slate-800 text-xs">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* NNR-Solutions company profile */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Building className="h-4 w-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-white">Company Details</h3>
              {!editCo ? (
                <button onClick={startCoEdit} className="ml-auto p-1 rounded text-slate-400 hover:text-amber-400 hover:bg-slate-800"><Pencil className="h-3.5 w-3.5" /></button>
              ) : (
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={saveCo} disabled={busy === 'co'} className="p-1.5 rounded-lg text-green-400 hover:bg-green-500/10">
                    {busy === 'co' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  </button>
                  <button onClick={() => setEditCo(false)} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800"><X className="h-4 w-4" /></button>
                </div>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mb-3">Used as the issuer on invoices generated for your customers.</p>

            {/* Company logo */}
            <div className="flex items-center gap-3 mb-4 pb-4 border-b border-slate-800">
              <div className="w-16 h-16 rounded-lg bg-slate-800 border border-slate-800 flex items-center justify-center overflow-hidden shrink-0">
                {company?.logo_url
                  ? <img src={company.logo_url} alt="Company logo" className="max-w-full max-h-full object-contain" />
                  : <ImageIcon className="h-6 w-6 text-slate-400" />}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-200">Company Logo</p>
                <p className="text-[11px] text-slate-400 mb-2">Shown on generated invoices &amp; receipts. PNG or JPG.</p>
                <div className="flex items-center gap-2">
                  <input ref={logoInputRef} type="file" accept="image/*" onChange={onLogoPick} className="hidden" />
                  <button onClick={() => logoInputRef.current?.click()} disabled={busy === 'logo'}
                    className="flex items-center gap-1.5 px-2.5 h-7 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold disabled:opacity-50">
                    {busy === 'logo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    {company?.logo_url ? 'Replace' : 'Upload'}
                  </button>
                  {company?.logo_url && (
                    <button onClick={removeLogo} disabled={busy === 'logo'}
                      className="flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-slate-400 hover:text-red-500 hover:bg-slate-800 text-xs disabled:opacity-50">
                      <Trash2 className="h-3.5 w-3.5" />Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            {editCo ? (
              <div className="space-y-2.5">
                <Field label="Company Name"><input value={co.company_name ?? ''} onChange={(e) => setCo({ ...co, company_name: e.target.value })} className={inputCls} placeholder="NNR-Solutions Co., LTD" /></Field>
                <div>
                  <label className="text-xs font-medium text-slate-400">Office Type</label>
                  <div className="flex items-center gap-4 mt-1.5">
                    <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                      <input type="radio" name="office_type" checked={co.office_type === 'head_office'} onChange={() => setCo({ ...co, office_type: 'head_office' })} className="accent-amber-500" />
                      Head Office
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                      <input type="radio" name="office_type" checked={co.office_type === 'branch'} onChange={() => setCo({ ...co, office_type: 'branch' })} className="accent-amber-500" />
                      Branch
                    </label>
                  </div>
                </div>
                {co.office_type === 'branch' && (
                  <Field label="Branch (specify)"><input value={co.branch_name ?? ''} onChange={(e) => setCo({ ...co, branch_name: e.target.value })} className={inputCls} placeholder="e.g. Branch 00001" /></Field>
                )}
                <Field label="Company Tax ID"><input value={co.tax_id ?? ''} onChange={(e) => setCo({ ...co, tax_id: e.target.value })} className={inputCls} placeholder="0505557003971" /></Field>
                <Field label="Company Address"><textarea value={co.address ?? ''} onChange={(e) => setCo({ ...co, address: e.target.value })} rows={3} className={inputCls + ' h-auto py-2 resize-none'} placeholder="Company address" /></Field>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Telephone"><input value={co.phone ?? ''} onChange={(e) => setCo({ ...co, phone: e.target.value })} className={inputCls} placeholder="+66 89 813 0699" /></Field>
                  <Field label="Email"><input type="email" value={co.email ?? ''} onChange={(e) => setCo({ ...co, email: e.target.value })} className={inputCls} placeholder="info@nnr-solutions.com" /></Field>
                </div>
                <Field label="Website"><input value={co.website ?? ''} onChange={(e) => setCo({ ...co, website: e.target.value })} className={inputCls} placeholder="www.nnr-solutions.com" /></Field>
                <div className="grid grid-cols-2 gap-2.5 pt-1 border-t border-slate-800">
                  <Field label="Authorised Signatory"><input value={co.signatory_name ?? ''} onChange={(e) => setCo({ ...co, signatory_name: e.target.value })} className={inputCls} placeholder="Dr. Poti Chaopaisarn" /></Field>
                  <Field label="Signatory Title"><input value={co.signatory_title ?? ''} onChange={(e) => setCo({ ...co, signatory_title: e.target.value })} className={inputCls} placeholder="Managing Director" /></Field>
                </div>
                <p className="text-[11px] text-slate-400">Name &amp; title printed on the issuer signature line of every document.</p>
                <div className="grid grid-cols-2 gap-2.5 pt-1 border-t border-slate-800">
                  <Field label="PromptPay ID (phone / Tax ID)"><input value={co.promptpay_id ?? ''} onChange={(e) => setCo({ ...co, promptpay_id: e.target.value })} className={inputCls} placeholder="0898130699" /></Field>
                  <Field label="PromptPay Account Name"><input value={co.promptpay_name ?? ''} onChange={(e) => setCo({ ...co, promptpay_name: e.target.value })} className={inputCls} placeholder="NNR-Solutions Co., Ltd." /></Field>
                </div>
                <Field label="Support Email (shown to clients in Help)"><input type="email" value={co.support_email ?? ''} onChange={(e) => setCo({ ...co, support_email: e.target.value })} className={inputCls} placeholder="support@nnr-solutions.com" /></Field>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><Detail label="Company Name">{company?.company_name || '—'}</Detail></div>
                <Detail label="Office Type">{company?.office_type === 'branch' ? `Branch${company?.branch_name ? ` · ${company.branch_name}` : ''}` : 'Head Office'}</Detail>
                <Detail label="Tax ID">{company?.tax_id || '—'}</Detail>
                <div className="col-span-2"><Detail label="Address">{company?.address || '—'}</Detail></div>
                <Detail label="Telephone">{company?.phone || '—'}</Detail>
                <Detail label="Email">{company?.email || '—'}</Detail>
                <div className="col-span-2"><Detail label="Website">{company?.website || '—'}</Detail></div>
                <div className="col-span-2"><Detail label="Authorised Signatory">{company?.signatory_name || '—'}{company?.signatory_title ? ` · ${company.signatory_title}` : ''}</Detail></div>
                <Detail label="PromptPay">{company?.promptpay_id || '—'}{company?.promptpay_name ? ` · ${company.promptpay_name}` : ''}</Detail>
                <Detail label="Support Email">{company?.support_email || '—'}</Detail>
              </div>
            )}

            {/* PromptPay QR upload (for the client payment screen) */}
            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-slate-800">
              <div className="w-16 h-16 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center overflow-hidden shrink-0">
                {company?.promptpay_qr ? <img src={company.promptpay_qr} alt="PromptPay QR" className="max-w-full max-h-full object-contain" /> : <ImageIcon className="h-6 w-6 text-slate-400" />}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-700">PromptPay QR</p>
                <p className="text-[11px] text-slate-500 mb-2">Shown to clients on the payment screen.</p>
                <div className="flex items-center gap-2">
                  <input ref={qrInputRef} type="file" accept="image/*" onChange={onQrPick} className="hidden" />
                  <button onClick={() => qrInputRef.current?.click()} disabled={busy === 'qr'} className="flex items-center gap-1.5 px-2.5 h-7 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold disabled:opacity-50">
                    {busy === 'qr' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}{company?.promptpay_qr ? 'Replace' : 'Upload'}
                  </button>
                  {company?.promptpay_qr && <button onClick={removeQr} disabled={busy === 'qr'} className="flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-slate-500 hover:text-red-500 hover:bg-slate-100 text-xs disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />Remove</button>}
                </div>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  )
}

const inputCls = 'w-full h-9 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50'
const selectCls = 'w-full h-9 rounded-lg bg-slate-800 border border-slate-700 px-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label className="text-xs font-medium text-slate-400">{label}</label>{children}</div>
}

function Detail({ label, icon: Icon, children }: { label: string; icon?: typeof Users; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 rounded-lg px-3 py-2">
      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="flex items-center gap-1.5 text-sm text-slate-200">{Icon && <Icon className="h-3.5 w-3.5 text-slate-400" />}{children}</p>
    </div>
  )
}

function Stat({ icon: Icon, label, live, max }: { icon: typeof Users; label: string; live: number; max: number | null }) {
  const over = max != null && live > max
  return (
    <div className="bg-slate-800 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5"><Icon className="h-3 w-3" />{label}</div>
      <p className={`text-sm font-semibold ${over ? 'text-red-400' : 'text-white'}`}>{live}{max != null && <span className="text-slate-400 font-normal"> / {max}</span>}</p>
    </div>
  )
}

function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl w-full ${wide ? 'max-w-md' : 'max-w-sm'}`}>{children}</div>
    </div>
  )
}
