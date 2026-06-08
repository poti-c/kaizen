import { useState, useEffect, useCallback } from 'react'
import { Wrench, Plus, Trash2, Check, X, Pencil, Loader2, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'
import { CollapsibleCard } from '@/components/CollapsibleCard'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

export const PM_CATEGORIES = [
  'HVAC', 'Electrical', 'Plumbing & Water', 'Fire & Safety',
  'Pool & Spa', 'Kitchen & Laundry', 'Vertical Transport', 'Property & Grounds',
] as const

// Hotel-oriented starter taxonomy (Top Management can edit/add/remove later).
const PM_DEFAULTS: { name: string; category: string }[] = [
  { name: 'Split A/C', category: 'HVAC' },
  { name: 'VRV / VRF', category: 'HVAC' },
  { name: 'Chiller', category: 'HVAC' },
  { name: 'Cooling Tower', category: 'HVAC' },
  { name: 'Ventilation / Exhaust Fan', category: 'HVAC' },
  { name: 'Main Distribution Board', category: 'Electrical' },
  { name: 'Generator / Backup Power', category: 'Electrical' },
  { name: 'UPS', category: 'Electrical' },
  { name: 'Lighting', category: 'Electrical' },
  { name: 'Lightning Protection', category: 'Electrical' },
  { name: 'Water Pump', category: 'Plumbing & Water' },
  { name: 'Water Heater / Boiler', category: 'Plumbing & Water' },
  { name: 'Water Treatment / Softener', category: 'Plumbing & Water' },
  { name: 'Drainage', category: 'Plumbing & Water' },
  { name: 'Booster Pump', category: 'Plumbing & Water' },
  { name: 'Fire Alarm / Smoke Detector', category: 'Fire & Safety' },
  { name: 'Fire Extinguisher', category: 'Fire & Safety' },
  { name: 'Sprinkler System', category: 'Fire & Safety' },
  { name: 'Emergency Lighting', category: 'Fire & Safety' },
  { name: 'Fire Pump', category: 'Fire & Safety' },
  { name: 'Pool Pump & Filter', category: 'Pool & Spa' },
  { name: 'Pool Heater', category: 'Pool & Spa' },
  { name: 'Jacuzzi / Spa', category: 'Pool & Spa' },
  { name: 'Refrigeration / Cold Room', category: 'Kitchen & Laundry' },
  { name: 'Cooking Equipment', category: 'Kitchen & Laundry' },
  { name: 'Dishwasher', category: 'Kitchen & Laundry' },
  { name: 'Washing Machine / Dryer', category: 'Kitchen & Laundry' },
  { name: 'Elevator / Lift', category: 'Vertical Transport' },
  { name: 'CCTV / Security', category: 'Property & Grounds' },
  { name: 'Network / IT', category: 'Property & Grounds' },
  { name: 'Irrigation / Landscaping', category: 'Property & Grounds' },
  { name: 'Boat / Watercraft', category: 'Property & Grounds' },
  { name: 'Buggy / Vehicle', category: 'Property & Grounds' },
  { name: 'Gym Equipment', category: 'Property & Grounds' },
  { name: 'Furniture & Fixtures', category: 'Property & Grounds' },
  // ── Resort-specific additions ──
  { name: 'Dehumidifier', category: 'HVAC' },
  { name: 'Solar Panel System', category: 'Electrical' },
  { name: 'Outdoor / Garden Lighting', category: 'Electrical' },
  { name: 'EV Charger', category: 'Electrical' },
  { name: 'Water Storage Tank', category: 'Plumbing & Water' },
  { name: 'Water Heat Pump', category: 'Plumbing & Water' },
  { name: 'Septic / Wastewater Treatment', category: 'Plumbing & Water' },
  { name: 'Sauna / Steam Room', category: 'Pool & Spa' },
  { name: 'Pool Chlorination System', category: 'Pool & Spa' },
  { name: 'Ice Machine', category: 'Kitchen & Laundry' },
  { name: 'Walk-in Freezer', category: 'Kitchen & Laundry' },
  { name: 'Grease Trap', category: 'Kitchen & Laundry' },
  { name: 'Minibar Fridge', category: 'Kitchen & Laundry' },
  { name: 'Pier / Jetty', category: 'Property & Grounds' },
  { name: 'Water Feature / Fountain', category: 'Property & Grounds' },
  { name: 'WiFi Access Point', category: 'Property & Grounds' },
  { name: 'PABX / Telephone System', category: 'Property & Grounds' },
  { name: 'AV / Sound System', category: 'Property & Grounds' },
  { name: 'In-room Safe', category: 'Property & Grounds' },
  { name: 'Television', category: 'Property & Grounds' },
  { name: 'Pest Control Station', category: 'Property & Grounds' },
]

interface EqType { id: string; company_id: string; name: string; category: string | null; sort_order: number; is_active: boolean }

export function PMEquipmentTypes() {
  const { activeCompany } = useCompany()
  const { t: tr } = useLanguage()
  const companyId = activeCompany?.id ?? null
  const [types, setTypes] = useState<EqType[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCat, setNewCat] = useState<string>(PM_CATEGORIES[0])
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  // All categories collapsed by default — expand on click.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set([...PM_CATEGORIES, 'Other']))
  const toggleCat = (c: string) => setCollapsed((prev) => { const n = new Set(prev); n.has(c) ? n.delete(c) : n.add(c); return n })

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data, error } = await supabase
      .from('kaizen_pm_equipment_types')
      .select('*')
      .eq('company_id', companyId)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (error) toast.error(error.message)
    setTypes((data as EqType[]) ?? [])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function addType() {
    if (!companyId || !newName.trim()) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_pm_equipment_types')
      .insert({ company_id: companyId, name: newName.trim(), category: newCat, sort_order: types.length })
    if (error) toast.error(error.message)
    else { setNewName(''); await load() }
    setBusy(false)
  }
  async function seedDefaults() {
    if (!companyId) return
    setBusy(true)
    const rows = PM_DEFAULTS.map((d, i) => ({ company_id: companyId, name: d.name, category: d.category, sort_order: i }))
    const { error } = await supabase.from('kaizen_pm_equipment_types').insert(rows)
    if (error) toast.error(error.message)
    else { toast.success(tr.pm.defaultsAdded); await load() }
    setBusy(false)
  }
  async function saveName(id: string) {
    if (!editName.trim()) return
    const { error } = await supabase.from('kaizen_pm_equipment_types').update({ name: editName.trim() }).eq('id', id)
    if (error) toast.error(error.message)
    else { setEditId(null); await load() }
  }
  async function toggleActive(t: EqType) {
    const { error } = await supabase.from('kaizen_pm_equipment_types').update({ is_active: !t.is_active }).eq('id', t.id)
    if (error) toast.error(error.message); else load()
  }
  async function remove(t: EqType) {
    if (!confirm(`${tr.pm.confirmDeleteType} "${t.name}"?`)) return
    const { error } = await supabase.from('kaizen_pm_equipment_types').delete().eq('id', t.id)
    if (error) toast.error(error.message); else load()
  }

  const grouped = PM_CATEGORIES.map((cat) => ({ cat, items: types.filter((t) => t.category === cat) }))
    .filter((g) => g.items.length > 0)
  const uncategorized = types.filter((t) => !t.category || !PM_CATEGORIES.includes(t.category as typeof PM_CATEGORIES[number]))

  return (
    <CollapsibleCard icon={Wrench} title={tr.pm.typesTitle}>
      <p className="text-xs text-gray-500 mb-4">{tr.pm.typesDesc}</p>

      {/* Add new */}
      <div className="flex items-end gap-2 mb-4">
        <div className="flex-1 min-w-[100px]">
          <label className="block text-xs font-medium text-gray-500 mb-1">{tr.pm.newType}</label>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addType()}
            placeholder={tr.pm.newTypePh} className="w-full h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40" />
        </div>
        <div className="min-w-0">
          <label className="block text-xs font-medium text-gray-500 mb-1">{tr.pm.category}</label>
          <select value={newCat} onChange={(e) => setNewCat(e.target.value)} className="w-full h-9 rounded-lg border border-gray-300 px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
            {PM_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button onClick={addType} disabled={busy || !newName.trim()}
          className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium disabled:opacity-50 flex-shrink-0">
          <Plus className="h-4 w-4" />{tr.pm.add}
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
      ) : types.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-gray-300 rounded-lg">
          <p className="text-sm text-gray-500 mb-3">{tr.pm.noTypes}</p>
          <button onClick={seedDefaults} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{tr.pm.loadDefaults}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {[...grouped, ...(uncategorized.length ? [{ cat: 'Other', items: uncategorized }] : [])].map((g) => (
            <div key={g.cat}>
              <button onClick={() => toggleCat(g.cat)} className="w-full flex items-center gap-1.5 mb-1.5 text-left">
                {collapsed.has(g.cat) ? <ChevronRight className="h-3.5 w-3.5 text-gray-400" /> : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />}
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{g.cat}</span>
                <span className="text-[11px] text-gray-300">({g.items.length})</span>
              </button>
              <div className={`space-y-1 ${collapsed.has(g.cat) ? 'hidden' : ''}`}>
                {g.items.map((t) => (
                  <div key={t.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${t.is_active ? 'border-gray-200 bg-gray-50' : 'border-gray-200 bg-gray-100 opacity-60'}`}>
                    {editId === t.id ? (
                      <>
                        <input value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveName(t.id)}
                          className="flex-1 h-8 rounded-md border border-gray-300 px-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40" autoFocus />
                        <button onClick={() => saveName(t.id)} className="p-1.5 rounded text-green-600 hover:bg-green-50"><Check className="h-4 w-4" /></button>
                        <button onClick={() => setEditId(null)} className="p-1.5 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 text-sm text-gray-800">{t.name}</span>
                        {!t.is_active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500">{tr.pm.inactiveStatus}</span>}
                        <button onClick={() => { setEditId(t.id); setEditName(t.name) }} title={tr.pm.rename} className="p-1.5 rounded text-gray-400 hover:text-[var(--brand-primary)] hover:bg-gray-100"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => toggleActive(t)} title={t.is_active ? tr.pm.deactivate : tr.pm.activate} className="px-2 h-7 rounded text-[11px] font-medium text-gray-500 hover:bg-gray-100">{t.is_active ? tr.pm.on : tr.pm.off}</button>
                        <button onClick={() => remove(t)} title="Delete" className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </CollapsibleCard>
  )
}
