import { useState, useEffect, useCallback } from 'react'
import { SlidersHorizontal, Loader2, Check } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

interface PMSettingsRow {
  require_approval: boolean; due_soon_days: number; escalate_enabled: boolean; escalate_days: number
}
const DEFAULTS: PMSettingsRow = { require_approval: true, due_soon_days: 7, escalate_enabled: true, escalate_days: 3 }

export function PMSettings() {
  const { activeCompany } = useCompany()
  const { t } = useLanguage()
  const companyId = activeCompany?.id ?? null
  const [s, setS] = useState<PMSettingsRow>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data } = await supabase.from('kaizen_pm_settings').select('*').eq('company_id', companyId).maybeSingle()
    if (data) setS({ require_approval: data.require_approval, due_soon_days: data.due_soon_days, escalate_enabled: data.escalate_enabled, escalate_days: data.escalate_days })
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

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-center gap-2 mb-1">
        <SlidersHorizontal className="h-4 w-4 text-gray-400" />
        <h2 className="font-semibold text-gray-900">{t.pm.settingsTitle}</h2>
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

          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-medium px-4 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{t.pm.saveSettings}
          </button>
        </div>
      )}
    </div>
  )
}
