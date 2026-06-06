import { useState, useEffect, useCallback } from 'react'
import { Wrench, Plus, Trash2, Check, X, Pencil, Loader2, Sparkles } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
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
]

interface EqType { id: string; company_id: string; name: string; category: string | null; sort_order: number; is_active: boolean }

export function PMEquipmentTypes() {
  const { activeCompany } = useCompany()
  const companyId = activeCompany?.id ?? null
  const [types, setTypes] = useState<EqType[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCat, setNewCat] = useState<string>(PM_CATEGORIES[0])
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

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
    else { toast.success('Default equipment types added'); await load() }
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
    if (!confirm(`Remove equipment type "${t.name}"?`)) return
    const { error } = await supabase.from('kaizen_pm_equipment_types').delete().eq('id', t.id)
    if (error) toast.error(error.message); else load()
  }

  const grouped = PM_CATEGORIES.map((cat) => ({ cat, items: types.filter((t) => t.category === cat) }))
    .filter((g) => g.items.length > 0)
  const uncategorized = types.filter((t) => !t.category || !PM_CATEGORIES.includes(t.category as typeof PM_CATEGORIES[number]))

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-center gap-2 mb-1">
        <Wrench className="h-4 w-4 text-gray-400" />
        <h2 className="font-semibold text-gray-900">Preventive Maintenance — Equipment Types</h2>
      </div>
      <p className="text-xs text-gray-500 mb-4">Define the equipment types used when registering maintenance assets. Only Top Management can edit these.</p>

      {/* Add new */}
      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs font-medium text-gray-500">New type</label>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addType()}
            placeholder="e.g. Heat Pump" className="w-full h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40" />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500">Category</label>
          <select value={newCat} onChange={(e) => setNewCat(e.target.value)} className="h-9 rounded-lg border border-gray-300 px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40">
            {PM_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button onClick={addType} disabled={busy || !newName.trim()}
          className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium disabled:opacity-50">
          <Plus className="h-4 w-4" />Add
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
      ) : types.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-gray-300 rounded-lg">
          <p className="text-sm text-gray-500 mb-3">No equipment types yet.</p>
          <button onClick={seedDefaults} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-medium disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Load default types
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {[...grouped, ...(uncategorized.length ? [{ cat: 'Other', items: uncategorized }] : [])].map((g) => (
            <div key={g.cat}>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">{g.cat}</p>
              <div className="space-y-1">
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
                        {!t.is_active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500">Inactive</span>}
                        <button onClick={() => { setEditId(t.id); setEditName(t.name) }} title="Rename" className="p-1.5 rounded text-gray-400 hover:text-[var(--brand-primary)] hover:bg-gray-100"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => toggleActive(t)} title={t.is_active ? 'Deactivate' : 'Activate'} className="px-2 h-7 rounded text-[11px] font-medium text-gray-500 hover:bg-gray-100">{t.is_active ? 'On' : 'Off'}</button>
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
    </div>
  )
}
