import { useState, useEffect, useCallback } from 'react'
import {
  ShieldCheck, Lock, Loader2, LogOut, Plus, Building2, Crown, Power,
  Trash2, X, Eye, EyeOff, Users, UserCog, ScrollText, AlertTriangle, Check,
} from 'lucide-react'

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
interface ConsoleCompany {
  id: string; name: string; slug: string; is_active: boolean
  plan: string; max_managers: number | null; max_staff: number | null
  live_managers: number; live_staff: number
}
interface ConsoleOwner {
  id: string; full_name: string; email: string | null; job_title: string | null
  is_active: boolean; created_at: string; companies: ConsoleCompany[]
}
interface AuditEntry {
  id: string; action: string; ip: string | null; success: boolean
  detail: Record<string, unknown>; created_at: string
}

// ── Root ─────────────────────────────────────────────────────────────────────
export function ConsolePage() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY))
  const [booting, setBooting] = useState(true)

  // noindex — keep this page out of search engines
  useEffect(() => {
    document.title = 'System Console'
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => { document.head.removeChild(meta) }
  }, [])

  // Verify stored token on boot
  useEffect(() => {
    let active = true
    async function check() {
      const stored = sessionStorage.getItem(TOKEN_KEY)
      if (!stored) { setBooting(false); return }
      try {
        await callConsole('verify', {}, stored)
        if (active) setToken(stored)
      } catch {
        sessionStorage.removeItem(TOKEN_KEY)
        if (active) setToken(null)
      } finally {
        if (active) setBooting(false)
      }
    }
    check()
    return () => { active = false }
  }, [])

  function handleLogin(newToken: string) {
    sessionStorage.setItem(TOKEN_KEY, newToken)
    setToken(newToken)
  }
  function handleLogout() {
    sessionStorage.removeItem(TOKEN_KEY)
    setToken(null)
  }

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
      </div>
    )
  }

  return token
    ? <Dashboard token={token} onLogout={handleLogout} />
    : <LoginScreen onLogin={handleLogin} />
}

// ── Login screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (t: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { token } = await callConsole<{ token: string }>('login', { username: username.trim(), password })
      onLogin(token)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shadow-lg shadow-amber-500/20 mb-4">
            <ShieldCheck className="h-7 w-7 text-slate-950" />
          </div>
          <h1 className="text-xl font-bold text-white">Kaizen System Console</h1>
          <p className="text-slate-500 text-sm mt-1">Restricted · Authorised personnel only</p>
        </div>

        <form onSubmit={submit} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-2xl">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              autoFocus
              className="w-full h-10 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/60 focus:border-transparent"
              placeholder="admin"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                className="w-full h-10 rounded-lg bg-slate-800 border border-slate-700 px-3 pr-10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/60 focus:border-transparent"
                placeholder="••••••••"
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg px-3 py-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full h-10 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Lock className="h-4 w-4" />Sign In</>}
          </button>
        </form>

        <p className="text-center text-[11px] text-slate-600 mt-6">
          © {new Date().getFullYear()} NNR Solutions · All activity is logged
        </p>
      </div>
    </div>
  )
}

// ── Dashboard ────────────────────────────────────────────────────────────────
type Tab = 'owners' | 'companies' | 'audit'

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('owners')
  const [owners, setOwners] = useState<ConsoleOwner[]>([])
  const [companies, setCompanies] = useState<ConsoleCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  // Wrap calls so a 401 (expired/invalid token) logs out cleanly
  const call = useCallback(async <T,>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
    try {
      return await callConsole<T>(action, payload, token)
    } catch (err) {
      if ((err as { status?: number }).status === 401) onLogout()
      throw err
    }
  }, [token, onLogout])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await call<{ owners: ConsoleOwner[]; companies: ConsoleCompany[] }>('list')
      setOwners(data.owners)
      setCompanies(data.companies)
    } catch { /* handled in call */ } finally {
      setLoading(false)
    }
  }, [call])

  useEffect(() => { load() }, [load])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Top bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center">
            <ShieldCheck className="h-4 w-4 text-slate-950" />
          </div>
          <div className="flex-1">
            <h1 className="text-sm font-bold text-white leading-tight">System Console</h1>
            <p className="text-[11px] text-slate-500 leading-tight">Kaizen by NNR Solutions</p>
          </div>
          <button onClick={onLogout} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-800">
            <LogOut className="h-3.5 w-3.5" />Sign Out
          </button>
        </div>
        {/* Tabs */}
        <div className="max-w-5xl mx-auto px-4 flex gap-1">
          {([['owners', 'Owners', Crown], ['companies', 'Companies', Building2], ['audit', 'Audit Log', ScrollText]] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                tab === key ? 'border-amber-500 text-amber-400' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />{label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-600" /></div>
        ) : tab === 'owners' ? (
          <OwnersTab owners={owners} call={call} reload={load} onCreate={() => setShowCreate(true)} />
        ) : tab === 'companies' ? (
          <CompaniesTab companies={companies} call={call} reload={load} />
        ) : (
          <AuditTab call={call} />
        )}
      </main>

      {showCreate && (
        <CreateOwnerDialog
          companies={companies}
          call={call}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load() }}
        />
      )}
    </div>
  )
}

// ── Owners tab ───────────────────────────────────────────────────────────────
function OwnersTab({ owners, call, reload, onCreate }: {
  owners: ConsoleOwner[]
  call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>
  reload: () => void
  onCreate: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ConsoleOwner | null>(null)

  async function toggleStatus(o: ConsoleOwner) {
    setBusy(o.id)
    try { await call('set_owner_status', { owner_id: o.id, is_active: !o.is_active }); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(null) }
  }
  async function doDelete(o: ConsoleOwner) {
    setBusy(o.id)
    try { await call('delete_owner', { owner_id: o.id }); setConfirmDelete(null); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(null) }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-white">Owner Accounts</h2>
          <p className="text-xs text-slate-500">{owners.length} owner{owners.length !== 1 ? 's' : ''} · top-management super admins</p>
        </div>
        <button onClick={onCreate} className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold px-3 py-2 rounded-lg transition-colors">
          <Plus className="h-3.5 w-3.5" />Add Owner
        </button>
      </div>

      <div className="space-y-3">
        {owners.map((o) => (
          <div key={o.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-400/20 to-amber-600/20 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
                <Crown className="h-4 w-4 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-white truncate">{o.full_name}</p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${o.is_active ? 'bg-green-500/15 text-green-400' : 'bg-slate-700 text-slate-400'}`}>
                    {o.is_active ? 'Active' : 'Suspended'}
                  </span>
                  {o.job_title && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">{o.job_title}</span>}
                </div>
                <p className="text-xs text-slate-500 truncate">{o.email}</p>
                {/* Companies */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {o.companies.length === 0 ? (
                    <span className="text-[11px] text-slate-600">No companies linked</span>
                  ) : o.companies.map((c) => (
                    <span key={c.id} className="inline-flex items-center gap-1 text-[11px] bg-slate-800 border border-slate-700 rounded-md px-2 py-0.5 text-slate-300">
                      <Building2 className="h-3 w-3 text-slate-500" />
                      {c.name}
                      <span className="text-slate-500">· {c.live_managers}M / {c.live_staff}S</span>
                    </span>
                  ))}
                </div>
              </div>
              {/* Actions */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => toggleStatus(o)}
                  disabled={busy === o.id}
                  title={o.is_active ? 'Suspend' : 'Activate'}
                  className={`p-2 rounded-lg transition-colors ${o.is_active ? 'text-amber-400 hover:bg-amber-500/10' : 'text-slate-500 hover:bg-slate-800'}`}
                >
                  {busy === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                </button>
                <button
                  onClick={() => setConfirmDelete(o)}
                  title="Delete"
                  className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Delete confirm */}
      {confirmDelete && (
        <Overlay onClose={() => setConfirmDelete(null)}>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-5 w-5 text-red-400" />
            <h3 className="text-sm font-semibold text-white">Delete owner account?</h3>
          </div>
          <p className="text-sm text-slate-400 mb-1">
            This permanently deletes <strong className="text-white">{confirmDelete.full_name}</strong> ({confirmDelete.email}) and revokes all access.
          </p>
          <p className="text-xs text-slate-500 mb-5">Their companies and the data within remain intact.</p>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setConfirmDelete(null)} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
            <button onClick={() => doDelete(confirmDelete)} disabled={busy === confirmDelete.id} className="px-3 py-2 text-sm bg-red-500 hover:bg-red-400 text-white rounded-lg flex items-center gap-1.5">
              {busy === confirmDelete.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete
            </button>
          </div>
        </Overlay>
      )}
    </div>
  )
}

// ── Companies tab ────────────────────────────────────────────────────────────
function CompaniesTab({ companies, call, reload }: {
  companies: ConsoleCompany[]
  call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>
  reload: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  async function toggle(c: ConsoleCompany) {
    setBusy(c.id)
    try { await call('update_company', { company_id: c.id, is_active: !c.is_active }); reload() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(null) }
  }

  return (
    <div>
      <h2 className="text-base font-semibold text-white mb-1">Companies</h2>
      <p className="text-xs text-slate-500 mb-4">{companies.length} compan{companies.length !== 1 ? 'ies' : 'y'} · live headcount vs quota</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {companies.map((c) => (
          <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center">
                  <Building2 className="h-4 w-4 text-slate-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{c.name}</p>
                  <p className="text-[11px] text-slate-500">/{c.slug} · {c.plan}</p>
                </div>
              </div>
              <button onClick={() => toggle(c)} disabled={busy === c.id} title={c.is_active ? 'Suspend' : 'Activate'}
                className={`p-1.5 rounded-lg ${c.is_active ? 'text-green-400 hover:bg-green-500/10' : 'text-slate-500 hover:bg-slate-800'}`}>
                {busy === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <Stat icon={UserCog} label="Managers" live={c.live_managers} max={c.max_managers} />
              <Stat icon={Users} label="Staff" live={c.live_staff} max={c.max_staff} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, live, max }: { icon: typeof Users; label: string; live: number; max: number | null }) {
  const over = max != null && live > max
  return (
    <div className="bg-slate-800/50 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mb-0.5">
        <Icon className="h-3 w-3" />{label}
      </div>
      <p className={`text-sm font-semibold ${over ? 'text-red-400' : 'text-white'}`}>
        {live}{max != null && <span className="text-slate-500 font-normal"> / {max}</span>}
      </p>
    </div>
  )
}

// ── Audit tab ────────────────────────────────────────────────────────────────
function AuditTab({ call }: { call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T> }) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    call<{ entries: AuditEntry[] }>('audit_log').then(d => setEntries(d.entries)).catch(() => {}).finally(() => setLoading(false))
  }, [call])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-600" /></div>

  return (
    <div>
      <h2 className="text-base font-semibold text-white mb-1">Audit Log</h2>
      <p className="text-xs text-slate-500 mb-4">Last 50 console events</p>
      <div className="bg-slate-900 border border-slate-800 rounded-xl divide-y divide-slate-800 overflow-hidden">
        {entries.map((e) => (
          <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.success ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className="font-mono text-slate-300 w-40 flex-shrink-0">{e.action}</span>
            <span className="text-slate-500 flex-1 truncate">{JSON.stringify(e.detail)}</span>
            <span className="text-slate-600 flex-shrink-0">{e.ip}</span>
            <span className="text-slate-600 flex-shrink-0 w-32 text-right">{new Date(e.created_at).toLocaleString()}</span>
          </div>
        ))}
        {entries.length === 0 && <div className="px-4 py-8 text-center text-sm text-slate-600">No events yet.</div>}
      </div>
    </div>
  )
}

// ── Create owner dialog ──────────────────────────────────────────────────────
function CreateOwnerDialog({ companies, call, onClose, onCreated }: {
  companies: ConsoleCompany[]
  call: <T,>(a: string, p?: Record<string, unknown>) => Promise<T>
  onClose: () => void
  onCreated: () => void
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [jobTitle, setJobTitle] = useState('Owner')
  const [isActive, setIsActive] = useState(true)
  const [showPw, setShowPw] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // New company (optional)
  const [addNew, setAddNew] = useState(false)
  const [ncName, setNcName] = useState('')
  const [ncMaxMgr, setNcMaxMgr] = useState('')
  const [ncMaxStaff, setNcMaxStaff] = useState('')

  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function toggleCompany(id: string) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function submit() {
    setError('')
    if (!fullName.trim() || !email.trim() || password.length < 6) {
      setError('Full name, email, and a password of at least 6 characters are required.')
      return
    }
    if (selectedIds.length === 0 && !(addNew && ncName.trim())) {
      setError('Assign at least one company (existing or new).')
      return
    }
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        full_name: fullName.trim(),
        email: email.trim(),
        password,
        job_title: jobTitle.trim() || 'Owner',
        is_active: isActive,
        company_ids: selectedIds,
      }
      if (addNew && ncName.trim()) {
        payload.new_company = {
          name: ncName.trim(),
          max_managers: ncMaxMgr ? Number(ncMaxMgr) : null,
          max_staff: ncMaxStaff ? Number(ncMaxStaff) : null,
        }
      }
      await call('create_owner', payload)
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create owner.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Overlay onClose={onClose} wide>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Crown className="h-5 w-5 text-amber-400" />
          <h3 className="text-sm font-semibold text-white">Add Owner Account</h3>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white"><X className="h-4 w-4" /></button>
      </div>

      <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
        <Field label="Full Name *">
          <input value={fullName} onChange={e => setFullName(e.target.value)} className={inputCls} placeholder="e.g. John Smith" autoFocus />
        </Field>
        <Field label="Email *">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="owner@company.com" autoComplete="off" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Password *">
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className={inputCls + ' pr-9'} placeholder="Min. 6 chars" autoComplete="new-password" />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </Field>
          <Field label="Job Title">
            <input value={jobTitle} onChange={e => setJobTitle(e.target.value)} className={inputCls} placeholder="Owner" />
          </Field>
        </div>

        {/* Company assignment */}
        <div className="pt-1">
          <p className="text-xs font-medium text-slate-400 mb-2">Assign Companies *</p>
          {companies.length === 0 ? (
            <p className="text-xs text-slate-600 mb-2">No companies yet — create one below.</p>
          ) : (
            <div className="space-y-1.5 mb-2">
              {companies.map(c => (
                <label key={c.id} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${selectedIds.includes(c.id) ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-700 hover:border-slate-600'}`}>
                  <input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => toggleCompany(c.id)} className="accent-amber-500" />
                  <Building2 className="h-3.5 w-3.5 text-slate-500" />
                  <span className="text-sm text-slate-200 flex-1">{c.name}</span>
                  <span className="text-[11px] text-slate-600">{c.live_managers}M / {c.live_staff}S</span>
                </label>
              ))}
            </div>
          )}

          {/* New company toggle */}
          {!addNew ? (
            <button onClick={() => setAddNew(true)} className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300">
              <Plus className="h-3.5 w-3.5" />Create a new company
            </button>
          ) : (
            <div className="border border-slate-700 rounded-lg p-3 space-y-2.5 bg-slate-800/40">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-slate-300">New Company</p>
                <button onClick={() => setAddNew(false)} className="text-slate-500 hover:text-white"><X className="h-3.5 w-3.5" /></button>
              </div>
              <input value={ncName} onChange={e => setNcName(e.target.value)} className={inputCls} placeholder="Company name" />
              <div className="grid grid-cols-2 gap-2">
                <input value={ncMaxMgr} onChange={e => setNcMaxMgr(e.target.value.replace(/[^0-9]/g, ''))} className={inputCls} placeholder="Max managers" inputMode="numeric" />
                <input value={ncMaxStaff} onChange={e => setNcMaxStaff(e.target.value.replace(/[^0-9]/g, ''))} className={inputCls} placeholder="Max staff" inputMode="numeric" />
              </div>
            </div>
          )}
        </div>

        {/* Status */}
        <label className="flex items-center gap-2.5 pt-1 cursor-pointer">
          <button type="button" onClick={() => setIsActive(!isActive)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${isActive ? 'bg-amber-500' : 'bg-slate-700'}`}>
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${isActive ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
          <span className="text-sm text-slate-300">Account active</span>
        </label>

        {error && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{error}</span>
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-end pt-4 mt-2 border-t border-slate-800">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 rounded-lg">Cancel</button>
        <button onClick={submit} disabled={saving} className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold rounded-lg flex items-center gap-1.5">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Create Owner
        </button>
      </div>
    </Overlay>
  )
}

// ── Shared bits ──────────────────────────────────────────────────────────────
const inputCls = 'w-full h-9 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-transparent'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-slate-400">{label}</label>
      {children}
    </div>
  )
}

function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl w-full ${wide ? 'max-w-md' : 'max-w-sm'}`}>
        {children}
      </div>
    </div>
  )
}
