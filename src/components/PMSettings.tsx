import { useState, useEffect, useCallback } from 'react'
import { SlidersHorizontal, Loader2, Check, Search, X, ChevronDown } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

interface PMSettingsRow {
  require_approval: boolean; due_soon_days: number; escalate_enabled: boolean; escalate_days: number
  notify_engineering: boolean; engineering_excluded_assets: string[]
}
const DEFAULTS: PMSettingsRow = {
  require_approval: true, due_soon_days: 7, escalate_enabled: true, escalate_days: 3,
  notify_engineering: false, engineering_excluded_assets: [],
}
interface AssetRow { id: string; name: string; type?: { name: string } | null }

export function PMSettings() {
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const companyId = activeCompany?.id ?? null
  const [s, setS] = useState<PMSettingsRow>(DEFAULTS)
  const [assets, setAssets] = useState<AssetRow[]>([])
  const [assetSearch, setAssetSearch] = useState('')
  const [excludeOpen, setExcludeOpen] = useState(false)  // collapsed by default
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [settingsRes, assetsRes] = await Promise.all([
      supabase.from('kaizen_pm_settings').select('*').eq('company_id', companyId).maybeSingle(),
      supabase.from('kaizen_pm_assets').select('id, name, type:kaizen_pm_equipment_types(name)').eq('company_id', companyId).eq('is_active', true).order('name'),
    ])
    const data = settingsRes.data
    if (data) setS({
      require_approval: data.require_approval, due_soon_days: data.due_soon_days,
      escalate_enabled: data.escalate_enabled, escalate_days: data.escalate_days,
      notify_engineering: data.notify_engineering ?? false,
      engineering_excluded_assets: data.engineering_excluded_assets ?? [],
    })
    setAssets((assetsRes.data as unknown as AssetRow[]) ?? [])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function save() {
    if (!companyId) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_pm_settings')
      .upsert({ company_id: companyId, ...s, updated_at: new Date().toISOString() }, { onConflict: 'company_id' })
    setBusy(false)
    if (error) toast.error(error.message); else toast.success(t.pm.settingsSaved)
  }

  const excluded = new Set(s.engineering_excluded_assets)
  function toggleExcluded(id: string) {
    const next = new Set(excluded)
    next.has(id) ? next.delete(id) : next.add(id)
    setS({ ...s, engineering_excluded_assets: [...next] })
  }
  const filteredAssets = assetSearch.trim()
    ? assets.filter(a => `${a.name} ${a.type?.name ?? ''}`.toLowerCase().includes(assetSearch.toLowerCase()))
    : assets

  return (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <SlidersHorizontal className="h-4 w-4 text-gray-400" />
        <h3 className="font-semibold text-gray-900">{lang === 'th' ? 'การตั้งค่า' : 'Settings'}</h3>
      </div>
      <p className="text-xs text-gray-500 mb-4">{t.pm.settingsDesc}</p>

      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={s.require_approval} onChange={(e) => setS({ ...s, require_approval: e.target.checked })} className="accent-[var(--brand-primary)] mt-0.5" />
            <span>
              <span className="text-sm font-medium text-gray-800">{t.pm.requireApproval}</span>
              <span className="block text-xs text-gray-500">{t.pm.requireApprovalDesc}</span>
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 leading-tight min-h-[2rem]">{t.pm.dueSoonWindow}</label>
              <input value={s.due_soon_days} onChange={(e) => setS({ ...s, due_soon_days: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })} className="w-full h-9 rounded-lg border border-gray-300 px-3 text-sm" inputMode="numeric" />
              <p className="text-[11px] text-gray-400 mt-1">{t.pm.dueSoonWindowDesc}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 leading-tight min-h-[2rem]">{t.pm.escalateAfter}</label>
              <input value={s.escalate_days} onChange={(e) => setS({ ...s, escalate_days: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })} className="w-full h-9 rounded-lg border border-gray-300 px-3 text-sm" inputMode="numeric" disabled={!s.escalate_enabled} />
              <p className="text-[11px] text-gray-400 mt-1">{t.pm.escalateAfterDesc}</p>
            </div>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={s.escalate_enabled} onChange={(e) => setS({ ...s, escalate_enabled: e.target.checked })} className="accent-[var(--brand-primary)] mt-0.5" />
            <span>
              <span className="text-sm font-medium text-gray-800">{t.pm.autoEscalate}</span>
              <span className="block text-xs text-gray-500">{t.pm.autoEscalateDesc}</span>
            </span>
          </label>

          {/* ── Notify Engineering by default ── */}
          <div className="pt-2 border-t border-gray-100">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={s.notify_engineering} onChange={(e) => setS({ ...s, notify_engineering: e.target.checked })} className="accent-[var(--brand-primary)] mt-0.5" />
              <span>
                <span className="text-sm font-medium text-gray-800">
                  {lang === 'th' ? 'แจ้งเตือนผู้ใช้แผนกวิศวกรรมทุกคนโดยอัตโนมัติ' : 'Notify all Engineering Department users by default'}
                </span>
                <span className="block text-xs text-gray-500">
                  {lang === 'th'
                    ? 'งานบำรุงรักษาเชิงป้องกันส่วนใหญ่เป็นของแผนกวิศวกรรม เมื่อเปิด ผู้ใช้ในแผนกวิศวกรรมทุกคนจะได้รับการแจ้งเตือนงานครบกำหนด/เกินกำหนด (ยกเว้นอุปกรณ์ที่ระบุไว้ด้านล่าง)'
                    : 'Preventive maintenance is mostly Engineering’s responsibility. When on, every Engineering user is notified of due-soon / overdue / escalated tasks (except the equipment excluded below).'}
                </span>
              </span>
            </label>

            {/* Equipment exclusion picker — only relevant when the toggle is on */}
            {s.notify_engineering && (
              <div className="mt-3 ml-7 rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                <button onClick={() => setExcludeOpen(o => !o)} className="w-full flex items-center justify-between text-left">
                  <p className="text-xs font-medium text-gray-600">
                    {lang === 'th' ? 'ยกเว้นอุปกรณ์ (ไม่แจ้งเตือนแผนกวิศวกรรม)' : 'Exclude equipment (don’t notify Engineering)'}
                  </p>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    {excluded.size > 0 && (
                      <span className="text-[11px] text-gray-500">
                        {excluded.size} {lang === 'th' ? 'รายการที่ยกเว้น' : 'excluded'}
                      </span>
                    )}
                    <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${excludeOpen ? 'rotate-180' : ''}`} />
                  </span>
                </button>

                {excludeOpen && (assets.length === 0 ? (
                  <p className="text-[11px] text-gray-400 py-2 mt-2">{lang === 'th' ? 'ยังไม่มีอุปกรณ์' : 'No equipment registered yet.'}</p>
                ) : (
                  <div className="mt-2">
                    <div className="relative mb-2">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                      <input value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)}
                        placeholder={lang === 'th' ? 'ค้นหาอุปกรณ์…' : 'Search equipment…'}
                        className="w-full h-8 rounded-md border border-gray-300 bg-white pl-8 pr-7 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40" />
                      {assetSearch && (
                        <button onClick={() => setAssetSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-0.5 pr-1">
                      {filteredAssets.length === 0 ? (
                        <p className="text-[11px] text-gray-400 py-2 text-center">{lang === 'th' ? 'ไม่พบอุปกรณ์' : 'No matching equipment'}</p>
                      ) : filteredAssets.map((a) => (
                        <label key={a.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-xs ${excluded.has(a.id) ? 'bg-amber-50' : 'hover:bg-white'}`}>
                          <input type="checkbox" checked={excluded.has(a.id)} onChange={() => toggleExcluded(a.id)} className="h-3.5 w-3.5 flex-shrink-0 accent-[var(--brand-primary)]" />
                          <span className="flex-1 min-w-0 truncate text-gray-800">{a.name}</span>
                          {a.type?.name && <span className="text-[10px] text-gray-400 flex-shrink-0">{a.type.name}</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-medium px-4 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{t.pm.saveSettings}
          </button>
        </div>
      )}
    </section>
  )
}
