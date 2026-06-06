import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Lock, Loader2, LogOut, Plus, Building2, Crown, Power,
  Trash2, X, Eye, EyeOff, Users, UserCog, ScrollText, AlertTriangle, Check,
  ChevronRight, ChevronDown, Pencil, CalendarDays, ArrowLeft, Receipt, Upload, ImageIcon, Clock, Link2, KeyRound,
  Settings, Mail, UserPlus, Building, FileText, Package,
} from 'lucide-react'
import { FormGeneratorView } from './console/FormGenerator'
import { ProductsView } from './console/Products'
import { CalendarView } from './console/Calendar'

// ── Console API client ───────────────────────────────────────────────────────
const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kaizen-console`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const TOKEN_KEY = 'kaizen-console-token'

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

  function handleLogin(t: string) { sessionStorage.setItem(TOKEN_KEY, t); setToken(t) }
  function handleLogout() { sessionStorage.removeItem(TOKEN_KEY); setToken(null) }

  if (booting) {
    return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
  }
  return token ? <Dashboard token={token} onLogout={handleLogout} /> : <LoginScreen onLogin={handleLogin} />
}

// ── Login screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (t: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const { token } = await callConsole<{ token: string }>('login', { username: username.trim(), password })
      onLogin(token)
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
type Tab = 'companies' | 'calendar' | 'audit'

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('companies')
  const [owners, setOwners] = useState<ConsoleOwner[]>([])
  const [companies, setCompanies] = useState<ConsoleCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showCreateCompany, setShowCreateCompany] = useState(false)
  const [preselectCompany, setPreselectCompany] = useState<string | null>(null)
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showForms, setShowForms] = useState(false)
  const [showProducts, setShowProducts] = useState(false)
  const [formPreviewId, setFormPreviewId] = useState<string | null>(null)

  // Open a specific form in the Form Generator history (used by Calendar deep-link).
  const openForm = useCallback((formId: string) => {
    setFormPreviewId(formId); setShowForms(true); setShowProducts(false); setShowSettings(false); setSelectedCompanyId(null)
  }, [])

  const call = useCallback(async <T,>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
    try { return await callConsole<T>(action, payload, token) }
    catch (err) { if ((err as { status?: number }).status === 401) onLogout(); throw err }
  }, [token, onLogout])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await call<{ owners: ConsoleOwner[]; companies: ConsoleCompany[] }>('list')
      setOwners(data.owners); setCompanies(data.companies)
    } catch (e) { console.error('Console load failed:', e) } finally { setLoading(false) }
  }, [call])

  useEffect(() => { load() }, [load])

  const selectedCompany = companies.find(c => c.id === selectedCompanyId) || null

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <button onClick={() => { setShowProducts(false); setShowForms(false); setShowSettings(false); setSelectedCompanyId(null) }} title="Back to Clients"
            className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-lg -mx-1 px-1 py-1 hover:bg-slate-800/60 transition-colors">
            <img src="/kaizen-icon.svg" alt="Kaizen" className="w-8 h-8 rounded-lg object-contain flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-white leading-tight">Kaizen System</h1>
              <p className="text-[11px] text-slate-400 leading-tight">System Console · by NNR Solutions</p>
            </div>
          </button>
          <button onClick={() => { setShowProducts(false); setShowForms(false); setShowSettings(false); setSelectedCompanyId(null); setTab('companies') }} title="Clients"
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg hover:bg-slate-800 ${!showProducts && !showForms && !showSettings && !selectedCompany && tab === 'companies' ? 'text-amber-400' : 'text-slate-400 hover:text-white'}`}>
            <Building2 className="h-3.5 w-3.5" />Clients
          </button>
          <button onClick={() => { setShowProducts(true); setShowForms(false); setShowSettings(false); setSelectedCompanyId(null) }} title="Products"
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg hover:bg-slate-800 ${showProducts ? 'text-amber-400' : 'text-slate-400 hover:text-white'}`}>
            <Package className="h-3.5 w-3.5" />Products
          </button>
          <button onClick={() => { setShowForms(true); setShowProducts(false); setShowSettings(false); setSelectedCompanyId(null) }} title="Form Generator"
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg hover:bg-slate-800 ${showForms ? 'text-amber-400' : 'text-slate-400 hover:text-white'}`}>
            <FileText className="h-3.5 w-3.5" />Form Generator
          </button>
          <button onClick={() => { setShowSettings(true); setShowForms(false); setShowProducts(false); setSelectedCompanyId(null) }} title="Admin Settings"
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg hover:bg-slate-800 ${showSettings ? 'text-amber-400' : 'text-slate-400 hover:text-white'}`}>
            <Settings className="h-3.5 w-3.5" />Settings
          </button>
          <button onClick={onLogout} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-800">
            <LogOut className="h-3.5 w-3.5" />Sign Out
          </button>
        </div>
        {!selectedCompany && !showSettings && !showForms && !showProducts && (
          <div className="max-w-5xl mx-auto px-4 flex gap-1">
            {([['companies', 'Clients', Building2], ['calendar', 'Calendar', CalendarDays], ['audit', 'Audit Log', ScrollText]] as const).map(([key, label, Icon]) => (
              <button key={key} onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === key ? 'border-amber-500 text-amber-400' : 'border-transparent text-slate-400 hover:text-slate-300'}`}>
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {showProducts ? (
          <ProductsView call={call} onBack={() => setShowProducts(false)} />
        ) : showForms ? (
          <FormGeneratorView call={call} onBack={() => setShowForms(false)} initialPreviewId={formPreviewId} onPreviewConsumed={() => setFormPreviewId(null)} />
        ) : showSettings ? (
          <AdminSettingsView call={call} onBack={() => setShowSettings(false)} />
        ) : loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
        ) : selectedCompany ? (
          <CompanyDetailView
            company={selectedCompany}
            owners={owners}
            allCompanies={companies}
            call={call}
            reload={load}
            onBack={() => setSelectedCompanyId(null)}
            onAddOwner={() => { setPreselectCompany(selectedCompany.id); setShowCreate(true) }}
            onOpenForm={openForm}
          />
        ) : tab === 'companies' ? (
          <CompaniesListTab companies={companies} owners={owners} onOpen={setSelectedCompanyId} onCreate={() => setShowCreateCompany(true)} />
        ) : tab === 'calendar' ? (
          <CalendarView call={call} onOpenForm={openForm} />
        ) : (
          <AuditTab call={call} />
        )}
      </main>

      <footer className="border-t border-slate-800 mt-4">
        <div className="max-w-5xl mx-auto px-4 py-5 text-center">
          <p className="text-[11px] text-slate-300">© 2026 NNR Solutions · All rights reserved · Version 1.0</p>
        </div>
      </footer>

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
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${warn ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' : 'bg-sky-500/15 text-sky-300 border-sky-500/30'}`}>Trial · {sub.days_remaining}d left</span>
  }
  if (!sub || !sub.has_payment) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700 font-medium">No payment</span>
  if (sub.overdue) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30 font-semibold">Overdue {Math.abs(sub.days_remaining!)}d</span>
  const soon = (sub.days_remaining ?? 0) <= 30
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${soon ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' : 'bg-green-500/15 text-green-400 border-green-500/30'}`}>{sub.days_remaining}d left</span>
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
                  ? <span className="text-red-400 font-semibold">Trial expired {Math.abs(sub.days_remaining!)}d ago</span>
                  : <span className={(sub.days_remaining ?? 0) <= 7 ? 'text-amber-400 font-semibold' : 'text-green-400 font-semibold'}>{sub.days_remaining} days left</span>}
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
                ? <span className="text-red-400 font-semibold">Expired {Math.abs(sub.days_remaining!)} days ago</span>
                : <span className={(sub.days_remaining ?? 0) <= 30 ? 'text-amber-400 font-semibold' : 'text-green-400 font-semibold'}>{sub.days_remaining} days remaining</span>}
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
function AuditTab({ call }: { call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T> }) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { call<{ entries: AuditEntry[] }>('audit_log').then(d => setEntries(d.entries)).catch((e) => console.error('Audit log load failed:', e)).finally(() => setLoading(false)) }, [call])
  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>
  return (
    <div>
      <h2 className="text-base font-semibold text-white mb-1">Audit Log</h2>
      <p className="text-xs text-slate-400 mb-4">Last 50 console events</p>
      <div className="bg-slate-900 border border-slate-800 rounded-xl divide-y divide-slate-800 overflow-hidden">
        {entries.map((e) => (
          <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.success ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className="font-mono text-slate-300 w-40 flex-shrink-0">{e.action}</span>
            <span className="text-slate-400 flex-1 truncate">{JSON.stringify(e.detail)}</span>
            <span className="text-slate-300 flex-shrink-0">{e.ip}</span>
            <span className="text-slate-300 flex-shrink-0 w-32 text-right">{new Date(e.created_at).toLocaleString()}</span>
          </div>
        ))}
        {entries.length === 0 && <div className="px-4 py-8 text-center text-sm text-slate-300">No events yet.</div>}
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
interface ConsoleAdmin { id: string; username: string; email: string | null; is_active: boolean; created_at: string }
interface ConsoleSettings { company_name: string | null; office_type: string; branch_name: string | null; address: string | null; tax_id: string | null; logo_url?: string | null; signatory_name?: string | null; signatory_title?: string | null; phone?: string | null; email?: string | null; website?: string | null }

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
  const [eUser, setEUser] = useState(''); const [eEmail, setEEmail] = useState(''); const [ePass, setEPass] = useState('')
  const [adding, setAdding] = useState(false)
  const [nUser, setNUser] = useState(''); const [nEmail, setNEmail] = useState(''); const [nPass, setNPass] = useState('')

  // company editing
  const [editCo, setEditCo] = useState(false)
  const [co, setCo] = useState<ConsoleSettings>({ company_name: '', office_type: 'head_office', branch_name: '', address: '', tax_id: '', signatory_name: '', signatory_title: '', phone: '', email: '', website: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await call<{ admins: ConsoleAdmin[]; company: ConsoleSettings | null }>('get_settings')
      setAdmins(d.admins); setCompany(d.company)
    } catch (e) { console.error('Console load failed:', e) } finally { setLoading(false) }
  }, [call])
  useEffect(() => { load() }, [load])

  function startEdit(a: ConsoleAdmin) { setEditId(a.id); setEUser(a.username); setEEmail(a.email ?? ''); setEPass('') }
  async function saveAdmin(id: string) {
    if (ePass && ePass.length < 6) { alert('Password must be at least 6 characters.'); return }
    setBusy('admin')
    try { await call('update_admin', { admin_id: id, username: eUser.trim(), email: eEmail.trim(), password: ePass || undefined }); setEditId(null); load() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(null) }
  }
  async function addAdmin() {
    if (!nUser.trim() || nPass.length < 6) { alert('Username and a password of at least 6 characters are required.'); return }
    setBusy('add')
    try { await call('add_admin', { username: nUser.trim(), email: nEmail.trim(), password: nPass }); setAdding(false); setNUser(''); setNEmail(''); setNPass(''); load() }
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
                        <p className="text-sm font-medium text-white truncate">{a.username}</p>
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
              </div>
            )}
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
