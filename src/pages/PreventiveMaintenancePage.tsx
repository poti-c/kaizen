import { useState, useEffect, useCallback } from 'react'
import { Wrench, Plus, Loader2, X, Check, Trash2, Pencil, MapPin, Search } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { DEPARTMENT_LABELS, type Department } from '@/types'
import { FREQUENCIES, freqLabel, addInterval, assetStatus, STATUS_META, type FreqUnit, type AssetStatus } from '@/lib/pm'
import { PMSchedule } from '@/components/pm/PMSchedule'
import { toast } from 'sonner'

interface EqType { id: string; name: string; category: string | null; is_active: boolean }
interface Asset {
  id: string; company_id: string; name: string; type_id: string | null
  location: string | null; serial_no: string | null; model: string | null
  department: string | null; pic_id: string | null
  freq_unit: FreqUnit; freq_interval: number; checklist: string[]
  last_maintenance_date: string | null; next_maintenance_date: string | null
  est_minutes: number | null; notes: string | null; is_active: boolean
  type?: { name: string; category: string | null } | null
}

const STATUS_ORDER: AssetStatus[] = ['overdue', 'due_soon', 'good', 'unscheduled', 'inactive']

export function PreventiveMaintenancePage() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const companyId = activeCompany?.id ?? null
  const canManage = profile?.role === 'super_admin' || profile?.role === 'manager'

  const [assets, setAssets] = useState<Asset[]>([])
  const [types, setTypes] = useState<EqType[]>([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<Asset | 'new' | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<AssetStatus | 'all'>('all')
  const [view, setView] = useState<'assets' | 'schedule'>('assets')

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [a, t] = await Promise.all([
      supabase.from('kaizen_pm_assets').select('*, type:kaizen_pm_equipment_types(name, category)').eq('company_id', companyId).order('next_maintenance_date', { ascending: true, nullsFirst: false }),
      supabase.from('kaizen_pm_equipment_types').select('id, name, category, is_active').eq('company_id', companyId).eq('is_active', true).order('category').order('name'),
    ])
    if (a.error) toast.error(a.error.message)
    setAssets((a.data as Asset[]) ?? [])
    setTypes((t.data as EqType[]) ?? [])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const counts = assets.reduce((acc, a) => {
    const s = assetStatus(a.next_maintenance_date, a.is_active)
    acc[s] = (acc[s] ?? 0) + 1
    return acc
  }, {} as Record<AssetStatus, number>)

  const filtered = assets.filter((a) => {
    if (filter !== 'all' && assetStatus(a.next_maintenance_date, a.is_active) !== filter) return false
    if (q && !`${a.name} ${a.location ?? ''} ${a.type?.name ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-[var(--brand-primary)]" />
          <h1 className="text-lg font-bold text-gray-900">Preventive Maintenance</h1>
        </div>
        {canManage && view === 'assets' && (
          <button onClick={() => setEditor('new')} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-2 rounded-lg">
            <Plus className="h-4 w-4" />Add Asset
          </button>
        )}
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([['assets', 'Assets'], ['schedule', 'Schedule']] as const).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${view === v ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {view === 'schedule' ? <PMSchedule /> : (<>
      {/* assets view */}

      {/* Summary */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-4">
        {STATUS_ORDER.map((s) => (
          <button key={s} onClick={() => setFilter(filter === s ? 'all' : s)}
            className={`rounded-xl border p-3 text-left transition-colors ${filter === s ? 'ring-2 ring-[var(--brand-primary)]/40' : ''} ${STATUS_META[s].pill}`}>
            <p className="text-lg font-bold leading-none">{counts[s] ?? 0}</p>
            <p className="text-[11px] mt-1">{STATUS_META[s].label}</p>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets…"
          className="w-full h-9 rounded-lg border border-gray-300 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40" />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <Wrench className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">{assets.length === 0 ? 'No assets registered yet.' : 'No assets match your filter.'}</p>
          {canManage && assets.length === 0 && <button onClick={() => setEditor('new')} className="mt-3 text-sm text-[var(--brand-primary)] font-medium">+ Register your first asset</button>}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((a) => {
            const s = assetStatus(a.next_maintenance_date, a.is_active)
            const m = STATUS_META[s]
            return (
              <button key={a.id} onClick={() => canManage && setEditor(a)} className="w-full flex items-center gap-3 bg-white border border-gray-200 rounded-xl p-3 text-left hover:border-gray-300 transition-colors">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${m.dot}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-gray-900 truncate">{a.name}</p>
                    {a.type?.name && <span className="text-[11px] text-gray-500">{a.type.name}</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${m.pill}`}>{m.label}</span>
                  </div>
                  <p className="text-[11px] text-gray-500 truncate flex items-center gap-2 mt-0.5">
                    {a.location && <span className="flex items-center gap-0.5"><MapPin className="h-3 w-3" />{a.location}</span>}
                    <span>{freqLabel(a.freq_unit, a.freq_interval)}</span>
                    {a.next_maintenance_date && <span>· Next {fmt(a.next_maintenance_date)}</span>}
                  </p>
                </div>
                {canManage && <Pencil className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
      </>)}

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
  const freqIdx0 = asset ? FREQUENCIES.findIndex((f) => f.unit === asset.freq_unit && f.interval === asset.freq_interval) : 3
  const [f, setF] = useState({
    name: asset?.name ?? '', type_id: asset?.type_id ?? '', location: asset?.location ?? '',
    serial_no: asset?.serial_no ?? '', model: asset?.model ?? '', department: asset?.department ?? '',
    freqMode: (freqIdx0 >= 0 ? String(freqIdx0) : 'custom') as string,
    customDays: freqIdx0 < 0 && asset ? asset.freq_interval : 30,
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
    if (!f.name.trim()) { toast.error('Asset name is required.'); return }
    setBusy(true)
    const { unit, interval } = freqParts()
    const row = {
      company_id: companyId, name: f.name.trim(), type_id: f.type_id || null,
      location: f.location.trim() || null, serial_no: f.serial_no.trim() || null, model: f.model.trim() || null,
      department: f.department || null, freq_unit: unit, freq_interval: interval,
      checklist: f.checklist.split('\n').map((s) => s.trim()).filter(Boolean),
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
    else { toast.success(asset ? 'Asset updated' : 'Asset added'); onSaved() }
  }
  async function remove() {
    if (!asset || !confirm(`Delete asset "${asset.name}"? Its maintenance history will be removed.`)) return
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
          <h3 className="font-semibold text-gray-900">{asset ? 'Edit Asset' : 'Register Asset'}</h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <Field label="Asset name / tag *"><input value={f.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder="e.g. Lobby Split A/C #1" autoFocus /></Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Equipment type">
              <select value={f.type_id} onChange={(e) => set({ type_id: e.target.value })} className={inputCls}>
                <option value="">— select —</option>
                {cats.map((c) => (
                  <optgroup key={c} label={c}>
                    {types.filter((t) => (t.category ?? 'Other') === c).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="Location / zone"><input value={f.location} onChange={(e) => set({ location: e.target.value })} className={inputCls} placeholder="Building / floor / room" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Serial no."><input value={f.serial_no} onChange={(e) => set({ serial_no: e.target.value })} className={inputCls} /></Field>
            <Field label="Model"><input value={f.model} onChange={(e) => set({ model: e.target.value })} className={inputCls} /></Field>
          </div>
          <Field label="Responsible department">
            <select value={f.department} onChange={(e) => set({ department: e.target.value })} className={inputCls}>
              <option value="">— none —</option>
              {(Object.keys(DEPARTMENT_LABELS) as Department[]).map((d) => <option key={d} value={d}>{DEPARTMENT_LABELS[d]}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Frequency">
              <select value={f.freqMode} onChange={(e) => { set({ freqMode: e.target.value }); recalcNext(f.last_maintenance_date, e.target.value, f.customDays) }} className={inputCls}>
                {FREQUENCIES.map((fr, i) => <option key={fr.label} value={String(i)}>{fr.label}</option>)}
                <option value="custom">Custom (every N days)</option>
              </select>
            </Field>
            {f.freqMode === 'custom' ? (
              <Field label="Every N days"><input value={f.customDays} onChange={(e) => { const v = Number(e.target.value.replace(/[^0-9]/g, '')) || 1; set({ customDays: v }); recalcNext(f.last_maintenance_date, 'custom', v) }} className={inputCls} inputMode="numeric" /></Field>
            ) : <Field label="Est. minutes"><input value={f.est_minutes} onChange={(e) => set({ est_minutes: e.target.value.replace(/[^0-9]/g, '') })} className={inputCls} inputMode="numeric" placeholder="optional" /></Field>}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Last maintenance"><input type="date" value={f.last_maintenance_date} onChange={(e) => { set({ last_maintenance_date: e.target.value }); recalcNext(e.target.value, f.freqMode, f.customDays) }} className={inputCls} /></Field>
            <Field label="Next maintenance"><input type="date" value={f.next_maintenance_date} onChange={(e) => set({ next_maintenance_date: e.target.value })} className={inputCls} /></Field>
          </div>
          <Field label="Maintenance checklist (one item per line)"><textarea value={f.checklist} onChange={(e) => set({ checklist: e.target.value })} rows={4} className={inputCls + ' h-auto py-2 resize-none'} placeholder={'Clean / replace filters\nCheck refrigerant\nTest thermostat'} /></Field>
          <Field label="Notes / instructions"><textarea value={f.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} className={inputCls + ' h-auto py-2 resize-none'} /></Field>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set({ is_active: e.target.checked })} className="accent-[var(--brand-primary)]" />Active (include in scheduling)
          </label>
        </div>
        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200">
          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{asset ? 'Save' : 'Register'}
          </button>
          <button onClick={onClose} className="px-3 h-9 rounded-lg text-gray-500 hover:bg-gray-100 text-sm">Cancel</button>
          {asset && <button onClick={remove} disabled={busy} className="ml-auto flex items-center gap-1.5 px-3 h-9 rounded-lg text-red-500 hover:bg-red-50 text-sm"><Trash2 className="h-4 w-4" />Delete</button>}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-gray-500">{label}</label>{children}</div>
}
