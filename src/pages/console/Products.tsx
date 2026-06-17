import { useState, useEffect, useCallback } from 'react'
import {
  Package, Loader2, Plus, Trash2, ArrowLeft, Check, Crown, Tag, Box, Ticket, X, Power, Pencil, Lock,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────
export interface Product {
  id?: string
  kind: 'package' | 'addon' | 'custom'
  key: string | null
  name: string
  description: string | null
  price: number
  currency: string
  duration_label: string | null
  duration_days: number | null
  max_super_admins: number | null
  max_managers: number | null
  max_staff: number | null
  multi_company: boolean
  features: Record<string, boolean>
  sort_order: number
  is_active: boolean
}
interface Promo {
  id?: string
  code: string
  discount_percent: number
  valid_from: string | null
  valid_to: string | null
  is_active: boolean
  notes: string | null
}
type Call = <T,>(a: string, p?: Record<string, unknown>) => Promise<T>

const CAPABILITIES: { key: string; label: string }[] = [
  { key: 'recurring_detection', label: 'Recurring issue detection' },
  { key: 'performance_analytics', label: 'Performance analytics' },
  { key: 'translation', label: 'Translation (TH↔EN)' },
  { key: 'activity_log', label: 'Activity log' },
  { key: 'custom_theme', label: 'Custom color theme' },
  { key: 'priority_support', label: 'Priority support' },
]
const DURATIONS: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '1 month', days: 30 },
  { label: '2 months', days: 60 },
  { label: '3 months', days: 90 },
  { label: '1 year', days: 365 },
  { label: '2 years', days: 730 },
  { label: '3 years', days: 1095 },
  { label: 'Lifetime', days: null },
]

const inputCls = 'w-full h-9 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50'
const selectCls = 'h-9 rounded-lg bg-slate-800 border border-slate-700 px-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50'

function blankProduct(kind: Product['kind'], sort: number): Product {
  return {
    kind, key: null, name: '', description: '', price: 0, currency: 'THB',
    duration_label: kind === 'package' ? '1 year' : null, duration_days: kind === 'package' ? 365 : null,
    max_super_admins: null, max_managers: null, max_staff: null, multi_company: false, features: {}, sort_order: sort, is_active: true,
  }
}

// ── Main view ────────────────────────────────────────────────────────────────
export function ProductsView({ call, onBack }: { call: Call; onBack: () => void }) {
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState<Product[]>([])
  const [promos, setPromos] = useState<Promo[]>([])
  const [drafts, setDrafts] = useState<Product[]>([])
  const [promoDrafts, setPromoDrafts] = useState<Promo[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, pr] = await Promise.all([
        call<{ products: Product[] }>('list_products'),
        call<{ promos: Promo[] }>('list_promos'),
      ])
      setProducts(p.products); setPromos(pr.promos)
    } catch (e) { console.error('Products load failed:', e) } finally { setLoading(false) }
  }, [call])
  useEffect(() => { load() }, [load])

  const packages = products.filter(p => p.kind === 'package')
  const addons = products.filter(p => p.kind === 'addon')
  const customs = products.filter(p => p.kind === 'custom')

  function addDraft(kind: Product['kind']) {
    // Count existing products AND unsaved drafts of this kind, so two drafts added before
    // saving get distinct sort_order values instead of colliding on the same number.
    const existing = products.filter(p => p.kind === kind).length
    const pending = drafts.filter(d => d.kind === kind).length
    setDrafts([...drafts, blankProduct(kind, existing + pending + 1)])
  }
  function removeDraft(idx: number) { setDrafts(drafts.filter((_, i) => i !== idx)) }

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white mb-4">
        <ArrowLeft className="h-3.5 w-3.5" />Back
      </button>
      <div className="flex items-center gap-2 mb-1">
        <Package className="h-5 w-5 text-amber-400" />
        <h2 className="text-lg font-bold text-white">Products</h2>
      </div>
      <p className="text-xs text-slate-500 mb-5">Packages, add-ons and promo codes used across billing and the Form Generator.</p>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-slate-600" /></div>
      ) : (
        <div className="space-y-6">
          {/* Packages */}
          <Section icon={Crown} title="Packages" desc="Subscription tiers — user limits, multi-company access, features, price & duration." onAdd={() => addDraft('package')} addLabel="Add Package">
            {packages.map(p => <ProductCard key={p.id} product={p} call={call} onSaved={load} onDeleted={load} />)}
            {drafts.map((d, i) => d.kind === 'package' && <ProductCard key={'d' + i} product={d} call={call} isNew onSaved={() => { removeDraft(i); load() }} onDeleted={() => removeDraft(i)} />)}
            {packages.length === 0 && !drafts.some(d => d.kind === 'package') && <Empty>No packages yet.</Empty>}
          </Section>

          {/* Add-ons */}
          <Section icon={Tag} title="Additional Costs" desc="One-time or recurring add-ons such as Setup Cost." onAdd={() => addDraft('addon')} addLabel="Add Cost">
            {addons.map(p => <ProductCard key={p.id} product={p} call={call} onSaved={load} onDeleted={load} />)}
            {drafts.map((d, i) => d.kind === 'addon' && <ProductCard key={'da' + i} product={d} call={call} isNew onSaved={() => { removeDraft(i); load() }} onDeleted={() => removeDraft(i)} />)}
            {addons.length === 0 && !drafts.some(d => d.kind === 'addon') && <Empty>No add-ons yet.</Empty>}
          </Section>

          {/* Custom products */}
          <Section icon={Box} title="Other Products" desc="Add any other billable product or service." onAdd={() => addDraft('custom')} addLabel="Add Product">
            {customs.map(p => <ProductCard key={p.id} product={p} call={call} onSaved={load} onDeleted={load} />)}
            {drafts.map((d, i) => d.kind === 'custom' && <ProductCard key={'dc' + i} product={d} call={call} isNew onSaved={() => { removeDraft(i); load() }} onDeleted={() => removeDraft(i)} />)}
            {customs.length === 0 && !drafts.some(d => d.kind === 'custom') && <Empty>No custom products yet.</Empty>}
          </Section>

          {/* Promo codes */}
          <Section icon={Ticket} title="Promotional Codes" desc="A code, its valid date range and a discount %. Applied to the subtotal in the Form Generator." onAdd={() => setPromoDrafts([...promoDrafts, { code: '', discount_percent: 0, valid_from: null, valid_to: null, is_active: true, notes: null }])} addLabel="Add Code">
            {promos.map(p => <PromoRow key={p.id} promo={p} call={call} onSaved={load} onDeleted={load} />)}
            {promoDrafts.map((d, i) => <PromoRow key={'pd' + i} promo={d} call={call} isNew onSaved={() => { setPromoDrafts(promoDrafts.filter((_, x) => x !== i)); load() }} onDeleted={() => setPromoDrafts(promoDrafts.filter((_, x) => x !== i))} />)}
            {promos.length === 0 && promoDrafts.length === 0 && <Empty>No promo codes yet.</Empty>}
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ icon: Icon, title, desc, onAdd, addLabel, children }: { icon: typeof Package; title: string; desc: string; onAdd: () => void; addLabel: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="flex items-start gap-2 mb-3">
        <Icon className="h-4 w-4 text-amber-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="text-[11px] text-slate-500">{desc}</p>
        </div>
        <button onClick={onAdd} className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 flex-shrink-0"><Plus className="h-3.5 w-3.5" />{addLabel}</button>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-600 py-3 text-center">{children}</p>
}

// ── Product card ─────────────────────────────────────────────────────────────
function ProductCard({ product, call, onSaved, onDeleted, isNew }: { product: Product; call: Call; onSaved: () => void; onDeleted: () => void; isNew?: boolean }) {
  const [d, setD] = useState<Product>(product)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  // Saved products open locked (read-only); new ones open in edit mode.
  const [locked, setLocked] = useState(!isNew)
  const isPackage = d.kind === 'package'

  function set(patch: Partial<Product>) { if (!locked) setD({ ...d, ...patch }) }
  function toggleFeature(k: string) { if (!locked) setD({ ...d, features: { ...d.features, [k]: !d.features[k] } }) }

  async function save() {
    if (!d.name.trim()) { alert('Name is required.'); return }
    setBusy(true)
    try { await call('upsert_product', { product: d }); setLocked(true); onSaved() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false) }
  }
  async function del() {
    if (!d.id) { onDeleted(); return }
    setBusy(true)
    try { await call('delete_product', { product_id: d.id }); onDeleted() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false); setConfirmDel(false) }
  }

  return (
    <div className={`rounded-lg border p-3 ${d.is_active ? 'bg-slate-800/40 border-slate-700' : 'bg-slate-800/20 border-slate-800'}`}>
      <fieldset disabled={locked} className={locked ? 'opacity-80 transition-opacity' : 'transition-opacity'}>
      <div className="flex items-center gap-2 mb-2.5">
        <input value={d.name} onChange={e => set({ name: e.target.value })} className={inputCls + ' flex-1 font-semibold'} placeholder={isPackage ? 'Package name' : 'Product name'} />
        <button onClick={() => set({ is_active: !d.is_active })} title={d.is_active ? 'Active' : 'Inactive'} className={`p-2 rounded-lg ${d.is_active ? 'text-green-400 hover:bg-green-500/10' : 'text-slate-500 hover:bg-slate-800'}`}><Power className="h-4 w-4" /></button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-2.5">
        <L label="Price"><input value={d.price || ''} onChange={e => set({ price: Number(e.target.value.replace(/[^0-9.]/g, '')) || 0 })} className={inputCls} placeholder="0" inputMode="decimal" /></L>
        <L label="Currency"><input value={d.currency} onChange={e => set({ currency: e.target.value.toUpperCase().slice(0, 4) })} className={inputCls} /></L>
        {isPackage && (
          <L label="Duration">
            <select value={d.duration_label ?? ''} onChange={e => { const dur = DURATIONS.find(x => x.label === e.target.value); set({ duration_label: e.target.value, duration_days: dur ? dur.days : null }) }} className={selectCls + ' w-full'}>
              {DURATIONS.map(x => <option key={x.label} value={x.label}>{x.label}</option>)}
            </select>
          </L>
        )}
        {isPackage && (
          <L label="Multi-company">
            <button onClick={() => set({ multi_company: !d.multi_company })} className={`h-9 w-full rounded-lg border text-xs font-medium ${d.multi_company ? 'bg-amber-500/15 border-amber-500/40 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
              {d.multi_company ? 'Enabled' : 'Disabled'}
            </button>
          </L>
        )}
      </div>

      {isPackage && (
        <div className="grid grid-cols-3 gap-2.5 mb-2.5">
          <L label="Max Top Management (blank = unlimited)"><input value={d.max_super_admins ?? ''} onChange={e => set({ max_super_admins: e.target.value === '' ? null : Number(e.target.value.replace(/[^0-9]/g, '')) })} className={inputCls} placeholder="Unlimited" inputMode="numeric" /></L>
          <L label="Max Managers (blank = unlimited)"><input value={d.max_managers ?? ''} onChange={e => set({ max_managers: e.target.value === '' ? null : Number(e.target.value.replace(/[^0-9]/g, '')) })} className={inputCls} placeholder="Unlimited" inputMode="numeric" /></L>
          <L label="Max Staff (blank = unlimited)"><input value={d.max_staff ?? ''} onChange={e => set({ max_staff: e.target.value === '' ? null : Number(e.target.value.replace(/[^0-9]/g, '')) })} className={inputCls} placeholder="Unlimited" inputMode="numeric" /></L>
        </div>
      )}

      <L label="Description"><input value={d.description ?? ''} onChange={e => set({ description: e.target.value })} className={inputCls} placeholder="Short description" /></L>

      {isPackage && (
        <div className="mt-2.5">
          <p className="text-[11px] font-medium text-slate-400 mb-1.5">Feature Authorities</p>
          <div className="grid grid-cols-2 gap-1.5">
            {CAPABILITIES.map(c => {
              const on = !!d.features[c.key]
              return (
                <label key={c.key} className={`flex items-center gap-2 text-xs ${locked ? '' : 'cursor-pointer'} ${on ? 'text-slate-200' : 'text-slate-500'}`}>
                  {locked ? (
                    on
                      ? <Check className="h-4 w-4 text-amber-400 flex-shrink-0" />
                      : <span className="h-3.5 w-3.5 rounded-[3px] border border-slate-600 flex-shrink-0" />
                  ) : (
                    <input type="checkbox" checked={on} onChange={() => toggleFeature(c.key)} className="accent-amber-500" />
                  )}
                  {c.label}
                </label>
              )
            })}
          </div>
        </div>
      )}

      </fieldset>
      <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-slate-800">
        {confirmDel ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Delete this {d.kind}?</span>
            <button onClick={del} disabled={busy} className="text-xs px-2 py-1 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25">{busy ? '…' : 'Delete'}</button>
            <button onClick={() => setConfirmDel(false)} className="text-xs px-2 py-1 rounded text-slate-400 hover:bg-slate-800">Cancel</button>
          </div>
        ) : (
          <button onClick={() => (isNew ? onDeleted() : setConfirmDel(true))} className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-400">
            {isNew ? <X className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}{isNew ? 'Discard' : 'Delete'}
          </button>
        )}
        {locked ? (
          <>
            <span className="ml-auto flex items-center gap-1 text-[11px] text-slate-500"><Lock className="h-3 w-3" />Locked</span>
            <button onClick={() => setLocked(false)} className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg">
              <Pencil className="h-3.5 w-3.5" />Edit
            </button>
          </>
        ) : (
          <button onClick={save} disabled={busy} className="ml-auto flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-lg">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{isNew ? 'Create' : 'Save'}
          </button>
        )}
      </div>
    </div>
  )
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-[10px] font-medium text-slate-500">{label}</label>{children}</div>
}

// ── Promo row ────────────────────────────────────────────────────────────────
function PromoRow({ promo, call, onSaved, onDeleted, isNew }: { promo: Promo; call: Call; onSaved: () => void; onDeleted: () => void; isNew?: boolean }) {
  const [d, setD] = useState<Promo>(promo)
  const [busy, setBusy] = useState(false)
  function set(patch: Partial<Promo>) { setD({ ...d, ...patch }) }
  async function save() {
    if (!d.code.trim()) { alert('Code is required.'); return }
    setBusy(true)
    try { await call('upsert_promo', { promo: d }); onSaved() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false) }
  }
  async function del() {
    if (!d.id) { onDeleted(); return }
    setBusy(true)
    try { await call('delete_promo', { promo_id: d.id }); onDeleted() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false) }
  }
  return (
    <div className={`rounded-lg border p-3 ${d.is_active ? 'bg-slate-800/40 border-slate-700' : 'bg-slate-800/20 border-slate-800'}`}>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 items-end">
        <L label="Code"><input value={d.code} onChange={e => set({ code: e.target.value.toUpperCase() })} className={inputCls + ' font-mono'} placeholder="SAVE10" /></L>
        <L label="Discount %"><input value={d.discount_percent || ''} onChange={e => set({ discount_percent: Math.min(100, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0) })} className={inputCls} placeholder="10" inputMode="decimal" /></L>
        <L label="Valid From"><input type="date" value={d.valid_from ?? ''} onChange={e => set({ valid_from: e.target.value || null })} className={inputCls} /></L>
        <L label="Valid To"><input type="date" value={d.valid_to ?? ''} onChange={e => set({ valid_to: e.target.value || null })} className={inputCls} /></L>
        <div className="flex items-center gap-1.5">
          <button onClick={() => set({ is_active: !d.is_active })} title={d.is_active ? 'Active' : 'Inactive'} className={`h-9 px-2.5 rounded-lg border text-xs font-medium flex-1 ${d.is_active ? 'bg-green-500/15 border-green-500/40 text-green-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>{d.is_active ? 'Active' : 'Off'}</button>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5">
        <input value={d.notes ?? ''} onChange={e => set({ notes: e.target.value })} className={inputCls + ' flex-1'} placeholder="Notes (optional)" />
        <button onClick={del} className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10">{isNew ? <X className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}</button>
        <button onClick={save} disabled={busy} className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 text-xs font-semibold px-3 py-2 rounded-lg">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{isNew ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  )
}
