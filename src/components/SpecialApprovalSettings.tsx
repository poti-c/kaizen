import { useState, useEffect, useCallback } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

/**
 * Master policy toggle: do per-room special requests need manager approval?
 * When off, special requests flow straight to the fulfilling departments and the
 * "Approvals" tab in the Room order screen is hidden. (The auto-release cutoff is
 * tuned inside that Approvals tab when the policy is on.)
 */
export function SpecialApprovalSettings() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const companyId = activeCompany?.id ?? null

  const [requireApproval, setRequireApproval] = useState(true)
  const [loading, setLoading] = useState(true)
  const [canEdit, setCanEdit] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!companyId || !profile) return
    setLoading(true)
    const cfgRes = await supabase.from('kaizen_settings').select('value')
      .eq('company_id', companyId).eq('key', 'rr_special_approval').maybeSingle()
    const v = (cfgRes.data?.value as { require?: boolean } | undefined) ?? {}
    setRequireApproval(v.require ?? true)
    setCanEdit(profile.role === 'super_admin' || profile.role === 'manager')
    setLoading(false)
  }, [companyId, profile])
  useEffect(() => { load() }, [load])

  async function setVal(v: boolean) {
    if (!companyId) return
    setRequireApproval(v); setSaving(true)
    // Preserve the other approval fields (cutoff settings) when flipping the policy.
    const { data } = await supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_special_approval').maybeSingle()
    const cur = (data?.value as Record<string, unknown>) ?? {}
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_special_approval', value: { ...cur, require: v } }, { onConflict: 'company_id,key' })
    setSaving(false)
    if (error) toast.error(error.message)
    else toast.success(lang === 'th' ? 'บันทึกแล้ว' : 'Saved')
  }

  if (loading || !canEdit) return null

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="h-4 w-4 text-gray-400" />
        <h3 className="font-semibold text-gray-900">{lang === 'th' ? 'การอนุมัติคำขอพิเศษ' : 'Special request approval'}</h3>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={requireApproval} onChange={(e) => setVal(e.target.checked)}
          className="accent-[var(--brand-primary)] mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>
          <span className="text-sm font-medium text-gray-800">
            {lang === 'th' ? 'ต้องให้ผู้จัดการอนุมัติคำขอพิเศษก่อน' : 'Require manager approval for special requests'}
          </span>
          <span className="block text-xs text-gray-500 mt-0.5">
            {lang === 'th'
              ? 'หากปิด คำขอพิเศษจะถูกส่งตรงไปยังแผนกผู้ดำเนินการทันที และซ่อนแท็บ “อนุมัติ” (ตั้งเวลาปล่อยอัตโนมัติได้ในแท็บอนุมัติเมื่อเปิด)'
              : 'When off, special requests go straight to the fulfilling departments and the “Approvals” tab is hidden. The auto-release cutoff is configured inside that tab when this is on.'}
          </span>
        </span>
      </label>
    </div>
  )
}
