import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Wrench, Plus, Loader2, X, Check, Trash2, Pencil, MapPin, Search, Ban } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { DEPARTMENT_LABELS, type Department } from '@/types'
import { FREQUENCIES, freqLabel, addInterval, assetStatus, STATUS_META, type FreqUnit, type AssetStatus } from '@/lib/pm'

const STATUS_KEY: Record<AssetStatus, 'good' | 'dueSoon' | 'overdue' | 'notScheduled' | 'inactiveStatus'> = {
  good: 'good', due_soon: 'dueSoon', overdue: 'overdue', unscheduled: 'notScheduled', inactive: 'inactiveStatus',
}
import { toast } from 'sonner'

interface EqType { id: string; name: string; category: string | null; is_active: boolean }
interface Asset {
  id: string; company_id: string; name: string; type_id: string | null
  location: string | null; serial_no: string | null; model: string | null
  department: string | null; pic_id: string | null
  freq_unit: FreqUnit; freq_interval: number; checklist: string[]
  purchase_date: string | null
  last_maintenance_date: string | null; next_maintenance_date: string | null
  est_minutes: number | null; notes: string | null; is_active: boolean
  type?: { name: string; category: string | null } | null
}

const STATUS_ORDER: AssetStatus[] = ['overdue', 'due_soon', 'good', 'unscheduled']

export function PreventiveMaintenancePage() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { t: tr } = useLanguage()
  const statusLabel = (s: AssetStatus) => tr.pm[STATUS_KEY[s]]
  const companyId = activeCompany?.id ?? null
  const canManage = profile?.role === 'super_admin' || profile?.role === 'manager'

  const [assets, setAssets] = useState<Asset[]>([])
  const [types, setTypes] = useState<EqType[]>([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<Asset | 'new' | null>(null)
  const [q, setQ] = useState('')
  const [searchParams] = useSearchParams()
  const initialStatus = searchParams.get('status')
  const validStatuses: AssetStatus[] = ['good', 'due_soon', 'overdue', 'unscheduled', 'inactive']
  const [filter, setFilter] = useState<AssetStatus | 'all'>(
    initialStatus && validStatuses.includes(initialStatus as AssetStatus) ? (initialStatus as AssetStatus) : 'all'
  )
  const [dueSoonDays, setDueSoonDays] = useState(7)
  const [typeFilter, setTypeFilter] = useState('all')
  const [locFilter, setLocFilter] = useState('all')
  const [deptFilter, setDeptFilter] = useState('all')
  const [inactiveOnly, setInactiveOnly] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [a, t, s] = await Promise.all([
      supabase.from('kaizen_pm_assets').select('*, type:kaizen_pm_equipment_types(name, category)').eq('company_id', companyId).order('next_maintenance_date', { ascending: true, nullsFirst: false }),
      supabase.from('kaizen_pm_equipment_types').select('id, name, category, is_active').eq('company_id', companyId).eq('is_active', true).order('category').order('name'),
      supabase.from('kaizen_pm_settings').select('due_soon_days').eq('company_id', companyId).maybeSingle(),
    ])
    if (a.error) toast.error(a.error.message)
    setAssets((a.data as Asset[]) ?? [])
    setTypes((t.data as EqType[]) ?? [])
    if (s.data?.due_soon_days != null) setDueSoonDays(s.data.due_soon_days)
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const counts = assets.reduce((acc, a) => {
    const s = assetStatus(a.next_maintenance_date, a.is_active, dueSoonDays)
    acc[s] = (acc[s] ?? 0) + 1
    return acc
  }, {} as Record<AssetStatus, number>)

  // Distinct option lists for the filter dropdowns.
  const typeOptions = Array.from(new Set(assets.map(a => a.type?.name).filter(Boolean) as string[])).sort()
  const locOptions = Array.from(new Set(assets.map(a => a.location).filter(Boolean) as string[])).sort()
  const deptOptions = Array.from(new Set(assets.map(a => a.department).filter(Boolean) as string[])).sort()

  const filtered = assets.filter((a) => {
    if (filter !== 'all' && assetStatus(a.next_maintenance_date, a.is_active, dueSoonDays) !== filter) return false
    if (inactiveOnly && a.is_active) return false
    if (typeFilter !== 'all' && a.type?.name !== typeFilter) return false
    if (locFilter !== 'all' && a.location !== locFilter) return false
    if (deptFilter !== 'all' && a.department !== deptFilter) return false
    if (q) {
      const hay = `${a.name} ${a.serial_no ?? ''} ${a.model ?? ''} ${a.notes ?? ''} ${a.location ?? ''} ${a.type?.name ?? ''} ${DEPARTMENT_LABELS[a.department as Department] ?? a.department ?? ''}`.toLowerCase()
      if (!hay.includes(q.toLowerCase())) return false
    }
    return true
  })

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-[var(--brand-primary)]" />
          <h1 className="text-lg font-bold text-gray-900">{tr.pm.scheduler}</h1>
        </div>
        {canManage && (
          <button onClick={() => setEditor('new')} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-2 rounded-lg">
            <Plus className="h-4 w-4" />{tr.pm.addAsset}
          </button>
        )}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {STATUS_ORDER.map((s) => (
          <button key={s} onClick={() => setFilter(filter === s ? 'all' : s)}
            className={`rounded-xl border p-3 text-left transition-colors ${filter === s ? 'ring-2 ring-[var(--brand-primary)]/40' : ''} ${STATUS_META[s].pill}`}>
            <p className="text-lg font-bold leading-none">{counts[s] ?? 0}</p>
            <p className="text-[11px] mt-1">{statusLabel(s)}</p>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr.pm.searchAssets}
          className="w-full h-9 rounded-lg border border-gray-300 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40" />
      </div>

      {/* Filters — single line on every screen size; dropdowns flex to fit width */}
      <div className="flex items-center gap-1.5 sm:gap-2 mb-3">
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="flex-1 min-w-0 h-8 rounded-lg border border-gray-300 bg-white px-1.5 sm:px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
          <option value="all">All Equipment</option>
          {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={locFilter} onChange={(e) => setLocFilter(e.target.value)} className="flex-1 min-w-0 h-8 rounded-lg border border-gray-300 bg-white px-1.5 sm:px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
          <option value="all">All Area</option>
          {locOptions.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="flex-1 min-w-0 h-8 rounded-lg border border-gray-300 bg-white px-1.5 sm:px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
          <option value="all">All Departments</option>
          {deptOptions.map(d => <option key={d} value={d}>{DEPARTMENT_LABELS[d as Department] ?? d}</option>)}
        </select>
        <button onClick={() => setInactiveOnly(v => !v)}
          className={`flex-shrink-0 h-8 px-2 rounded-lg border text-xs font-medium transition-colors flex items-center gap-1 ${inactiveOnly ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
          <Ban className="h-3.5 w-3.5" /><span className="hidden sm:inline">Inactive</span>
        </button>
        {(typeFilter !== 'all' || locFilter !== 'all' || deptFilter !== 'all' || inactiveOnly) && (
          <button onClick={() => { setTypeFilter('all'); setLocFilter('all'); setDeptFilter('all'); setInactiveOnly(false) }}
            className="flex-shrink-0 h-8 px-1.5 text-xs text-[var(--brand-primary)] hover:underline" title="Clear filters">Clear</button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <Wrench className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">{assets.length === 0 ? tr.pm.noAssets : tr.pm.noAssetsFiltered}</p>
          {canManage && assets.length === 0 && <button onClick={() => setEditor('new')} className="mt-3 text-sm text-[var(--brand-primary)] font-medium">{tr.pm.registerFirst}</button>}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((a) => {
            const s = assetStatus(a.next_maintenance_date, a.is_active, dueSoonDays)
            const m = STATUS_META[s]
            return (
              <button key={a.id} onClick={() => canManage && setEditor(a)} className="w-full flex items-center gap-3 bg-white border border-gray-200 rounded-xl p-3 text-left hover:border-gray-300 transition-colors">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${m.dot}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-gray-900 truncate">{a.name}</p>
                    {a.type?.name && <span className="text-[11px] text-gray-500">{a.type.name}</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${m.pill}`}>{statusLabel(s)}</span>
                  </div>
                  <p className="text-[11px] text-gray-500 truncate flex items-center gap-2 mt-0.5">
                    {a.location && <span className="flex items-center gap-0.5"><MapPin className="h-3 w-3" />{a.location}</span>}
                    <span>{freqLabel(a.freq_unit, a.freq_interval)}</span>
                    {a.next_maintenance_date && <span>· {tr.pm.next} {fmt(a.next_maintenance_date)}</span>}
                  </p>
                </div>
                {canManage && <Pencil className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
              </button>
            )
          })}
        </div>
      )}

      {editor && companyId && (
        <AssetEditor companyId={companyId} types={types} asset={editor === 'new' ? null : editor}
          onClose={() => setEditor(null)} onSaved={() => { setEditor(null); load() }} />
      )}
    </div>
  )
}

function fmt(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40'

function AssetEditor({ companyId, types, asset, onClose, onSaved }: {
  companyId: string; types: EqType[]; asset: Asset | null; onClose: () => void; onSaved: () => void
}) {
  const { t: tr } = useLanguage()
  const freqIdx0 = asset ? FREQUENCIES.findIndex((f) => f.unit === asset.freq_unit && f.interval === asset.freq_interval) : 3
  const [f, setF] = useState({
    name: asset?.name ?? '', type_id: asset?.type_id ?? '', location: asset?.location ?? '',
    serial_no: asset?.serial_no ?? '', model: asset?.model ?? '', department: asset?.department ?? '',
    freqMode: (freqIdx0 >= 0 ? String(freqIdx0) : 'custom') as string,
    customDays: freqIdx0 < 0 && asset ? asset.freq_interval : 30,
    purchase_date: asset?.purchase_date ?? '',
    last_maintenance_date: asset?.last_maintenance_date ?? '',
    next_maintenance_date: asset?.next_maintenance_date ?? '',
    est_minutes: asset?.est_minutes ?? '', checklist: (asset?.checklist ?? []).join('\n'),
    notes: asset?.notes ?? '', is_active: asset?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }))

  function freqParts(): { unit: FreqUnit; interval: number } {
    if (f.freqMode === 'custom') return { unit: 'day', interval: Math.max(1, Number(f.customDays) || 1) }
    const fr = FREQUENCIES[Number(f.freqMode)]
    return { unit: fr.unit, interval: fr.interval }
  }
  // Auto-fill next from last + frequency.
  function recalcNext(lastVal: string, mode: string, custom: number) {
    if (!lastVal) return
    const parts = mode === 'custom' ? { unit: 'day' as FreqUnit, interval: Math.max(1, custom || 1) } : { unit: FREQUENCIES[Number(mode)].unit, interval: FREQUENCIES[Number(mode)].interval }
    set({ next_maintenance_date: addInterval(lastVal, parts.unit, parts.interval) })
  }

  async function save() {
    if (!f.name.trim()) { toast.error(tr.pm.assetNameRequired); return }
    setBusy(true)
    const { unit, interval } = freqParts()
    const row = {
      company_id: companyId, name: f.name.trim(), type_id: f.type_id || null,
      location: f.location.trim() || null, serial_no: f.serial_no.trim() || null, model: f.model.trim() || null,
      department: f.department || null, freq_unit: unit, freq_interval: interval,
      checklist: f.checklist.split('\n').map((s) => s.trim()).filter(Boolean),
      purchase_date: f.purchase_date || null,
      last_maintenance_date: f.last_maintenance_date || null,
      next_maintenance_date: f.next_maintenance_date || null,
      est_minutes: f.est_minutes === '' ? null : Number(f.est_minutes),
      notes: f.notes.trim() || null, is_active: f.is_active, updated_at: new Date().toISOString(),
    }
    const res = asset
      ? await supabase.from('kaizen_pm_assets').update(row).eq('id', asset.id)
      : await supabase.from('kaizen_pm_assets').insert(row)
    setBusy(false)
    if (res.error) toast.error(res.error.message)
    else { toast.success(asset ? tr.pm.assetSaved : tr.pm.assetAdded); onSaved() }
  }
  async function remove() {
    if (!asset || !confirm(`${tr.pm.confirmDeleteAsset}`)) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_pm_assets').delete().eq('id', asset.id)
    setBusy(false)
    if (error) toast.error(error.message); else onSaved()
  }

  const cats = [...new Set(types.map((t) => t.category ?? 'Other'))]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">{asset ? tr.pm.editAsset : tr.pm.registerAsset}</h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <Field label={`${tr.pm.assetName} *`}><input value={f.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder={tr.pm.assetNamePh} autoFocus /></Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.pm.equipmentType}>
              <select value={f.type_id} onChange={(e) => set({ type_id: e.target.value })} className={inputCls}>
                <option value="">{tr.pm.selectType}</option>
                {cats.map((c) => (
                  <optgroup key={c} label={c}>
                    {types.filter((t) => (t.category ?? 'Other') === c).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label={tr.pm.location}><input value={f.location} onChange={(e) => set({ location: e.target.value })} className={inputCls} placeholder={tr.pm.locationPh} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.pm.serialNo}><input value={f.serial_no} onChange={(e) => set({ serial_no: e.target.value })} className={inputCls} /></Field>
            <Field label={tr.pm.model}><input value={f.model} onChange={(e) => set({ model: e.target.value })} className={inputCls} /></Field>
          </div>
          <Field label={tr.pm.purchaseDate}><input type="date" value={f.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} className={inputCls} /></Field>
          <Field label={tr.pm.responsibleDept}>
            <select value={f.department} onChange={(e) => set({ department: e.target.value })} className={inputCls}>
              <option value="">{tr.pm.none}</option>
              {(Object.keys(DEPARTMENT_LABELS) as Department[]).map((d) => <option key={d} value={d}>{DEPARTMENT_LABELS[d]}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.pm.frequency}>
              <select value={f.freqMode} onChange={(e) => { set({ freqMode: e.target.value }); recalcNext(f.last_maintenance_date, e.target.value, f.customDays) }} className={inputCls}>
                {FREQUENCIES.map((fr, i) => <option key={fr.label} value={String(i)}>{fr.label}</option>)}
                <option value="custom">{tr.pm.customEvery}</option>
              </select>
            </Field>
            {f.freqMode === 'custom' ? (
              <Field label={tr.pm.everyNDays}><input value={f.customDays} onChange={(e) => { const v = Number(e.target.value.replace(/[^0-9]/g, '')) || 1; set({ customDays: v }); recalcNext(f.last_maintenance_date, 'custom', v) }} className={inputCls} inputMode="numeric" /></Field>
            ) : <Field label={tr.pm.estMinutes}><input value={f.est_minutes} onChange={(e) => set({ est_minutes: e.target.value.replace(/[^0-9]/g, '') })} className={inputCls} inputMode="numeric" placeholder={tr.pm.optional} /></Field>}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={tr.pm.lastMaint}><input type="date" value={f.last_maintenance_date} onChange={(e) => { set({ last_maintenance_date: e.target.value }); recalcNext(e.target.value, f.freqMode, f.customDays) }} className={inputCls} /></Field>
            <Field label={tr.pm.nextMaint}><input type="date" value={f.next_maintenance_date} onChange={(e) => set({ next_maintenance_date: e.target.value })} className={inputCls} /></Field>
          </div>
          <Field label={tr.pm.checklist}><textarea value={f.checklist} onChange={(e) => set({ checklist: e.target.value })} rows={4} className={inputCls + ' h-auto py-2 resize-none'} placeholder={tr.pm.checklistPh} /></Field>
          <Field label={tr.pm.notesInstr}><textarea value={f.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} className={inputCls + ' h-auto py-2 resize-none'} /></Field>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set({ is_active: e.target.checked })} className="accent-[var(--brand-primary)]" />{tr.pm.activeInclude}
          </label>
        </div>
        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200">
          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{asset ? tr.pm.save : tr.pm.register}
          </button>
          <button onClick={onClose} className="px-3 h-9 rounded-lg text-gray-500 hover:bg-gray-100 text-sm">{tr.pm.cancel}</button>
          {asset && <button onClick={remove} disabled={busy} className="ml-auto flex items-center gap-1.5 px-3 h-9 rounded-lg text-red-500 hover:bg-red-50 text-sm"><Trash2 className="h-4 w-4" />{tr.pm.delete}</button>}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-gray-500">{label}</label>{children}</div>
}
