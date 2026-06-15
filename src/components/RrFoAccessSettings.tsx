import { useState, useEffect, useCallback } from 'react'
import { Loader2, Check, UserCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

/**
 * Authorize which Front-Office staff may place/view Routine Roster orders.
 * Empty list = all front-office staff allowed. Top Management + managers.
 */
export function RrFoAccessSettings() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const companyId = activeCompany?.id ?? null

  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([])
  const [ids, setIds] = useState<string[]>([])
  const [restrict, setRestrict] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [staffRes, cfgRes] = await Promise.all([
      supabase.from('kaizen_profiles').select('id, full_name')
        .eq('company_id', companyId).eq('is_active', true).is('deleted_at', null)
        .eq('department', 'front_office').in('role', ['staff', 'manager']).order('full_name'),
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_fo_authorized').maybeSingle(),
    ])
    setStaff((staffRes.data as { id: string; full_name: string }[]) ?? [])
    const list = Array.isArray(cfgRes.data?.value) ? (cfgRes.data!.value as string[]) : []
    setIds(list)
    setRestrict(list.length > 0)
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function save() {
    if (!companyId) return
    setSaving(true)
    const value = restrict ? ids : []
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_fo_authorized', value }, { onConflict: 'company_id,key' })
    setSaving(false)
    if (error) toast.error(error.message)
    else toast.success(lang === 'th' ? 'บันทึกแล้ว' : 'Saved')
  }

  // Top Management + managers
  if (loading || (profile?.role !== 'super_admin' && profile?.role !== 'manager')) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-1">
        <UserCheck className="h-4 w-4 text-gray-400" />
        <h3 className="font-semibold text-gray-900">{lang === 'th' ? 'สิทธิ์แผนกต้อนรับ' : 'Front Office access'}</h3>
      </div>
      <p className="text-xs text-gray-500">
        {lang === 'th'
          ? 'กำหนดว่าพนักงานแผนกต้อนรับคนใดสามารถสร้าง/ดูใบสั่งงานประจำได้ (ผู้บริหารเข้าถึงได้เสมอ)'
          : 'Choose which Front-Office staff can place/view Routine Roster orders. Managers always have access.'}
      </p>

      <label className="flex items-start gap-2 cursor-pointer pt-1">
        <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)}
          className="accent-[var(--brand-primary)] mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>
          <span className="text-sm font-medium text-gray-800">{lang === 'th' ? 'จำกัดเฉพาะพนักงานที่เลือก' : 'Limit to selected staff only'}</span>
          <span className="block text-xs text-gray-500 mt-0.5">{lang === 'th' ? 'หากปิด พนักงานแผนกต้อนรับทุกคนเข้าถึงได้' : 'When off, all Front-Office staff have access.'}</span>
        </span>
      </label>

      {restrict && (
        staff.length === 0 ? (
          <p className="text-[11px] text-gray-400">{lang === 'th' ? 'ไม่มีพนักงานแผนกต้อนรับ' : 'No Front-Office staff found.'}</p>
        ) : (
          <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50/60 p-2 space-y-0.5">
            {staff.map((m) => (
              <label key={m.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-xs ${ids.includes(m.id) ? 'bg-[var(--brand-primary)]/10' : 'hover:bg-white'}`}>
                <input type="checkbox" checked={ids.includes(m.id)}
                  onChange={() => setIds((prev) => prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id])}
                  className="h-3.5 w-3.5 flex-shrink-0 accent-[var(--brand-primary)]" />
                <span className="text-gray-800">{m.full_name}</span>
              </label>
            ))}
          </div>
        )
      )}

      <button onClick={save} disabled={saving}
        className="mt-1 flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-medium px-4 h-9 rounded-lg disabled:opacity-50">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'บันทึก' : 'Save'}
      </button>
    </div>
  )
}
