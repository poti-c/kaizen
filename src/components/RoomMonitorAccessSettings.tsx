import { useState, useEffect, useCallback } from 'react'
import { Loader2, Eye } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { DEPARTMENTS, deptLabel, type Department } from '@/types'
import { toast } from 'sonner'

// Departments that can be granted the read-only Monitor tab. Front Office and managers /
// Top Management always have it, so they're not listed here.
const GRANTABLE = DEPARTMENTS.filter((d) => d.value !== 'top_management' && d.value !== 'front_office')

/** Settings key `rr_monitor_depts`: extra departments allowed to see the Monitor tab. */
export function RoomMonitorAccessSettings() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const companyId = activeCompany?.id ?? null

  const [depts, setDepts] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [canEdit, setCanEdit] = useState(false)

  const load = useCallback(async () => {
    if (!companyId || !profile) return
    setLoading(true)
    const { data } = await supabase.from('kaizen_settings').select('value')
      .eq('company_id', companyId).eq('key', 'rr_monitor_depts').maybeSingle()
    setDepts(Array.isArray(data?.value) ? (data!.value as string[]) : [])
    setCanEdit(profile.role === 'super_admin' || profile.role === 'manager')
    setLoading(false)
  }, [companyId, profile])
  useEffect(() => { load() }, [load])

  async function toggle(dept: Department) {
    if (!companyId) return
    const next = depts.includes(dept) ? depts.filter((d) => d !== dept) : [...depts, dept]
    setDepts(next)
    setSaving(true)
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_monitor_depts', value: next }, { onConflict: 'company_id,key' })
    setSaving(false)
    if (error) { toast.error(error.message); load(); return }
    toast.success(lang === 'th' ? 'บันทึกแล้ว' : 'Saved')
  }

  if (loading) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  if (!canEdit) return null

  return (
    <section className="space-y-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Eye className="h-4 w-4 text-gray-400" />
          <h3 className="font-semibold text-gray-900">{lang === 'th' ? 'สิทธิ์ดูบอร์ดติดตาม' : 'Monitor tab access'}</h3>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
        </div>
        <p className="text-xs text-gray-500">
          {lang === 'th'
            ? 'แผนกต้อนรับและผู้จัดการเห็นบอร์ดติดตาม (ดูสถานะทุกห้องทุกแผนก) อยู่แล้ว เลือกแผนกอื่นที่จะให้ดูได้ด้วย'
            : 'Front Office and managers can already see the Monitor board (read-only status of every room across departments). Pick any other departments that should also have it.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {GRANTABLE.map((d) => {
          const on = depts.includes(d.value)
          return (
            <button key={d.value} onClick={() => toggle(d.value)}
              className={`px-3 h-8 rounded-lg border text-xs font-medium transition-colors ${on
                ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
              {deptLabel(d.value, lang)}
            </button>
          )
        })}
      </div>
    </section>
  )
}
