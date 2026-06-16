import { useState, useEffect, useCallback } from 'react'
import { Loader2, Check, BellRing } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { DEPARTMENTS, deptLabel, type Department } from '@/types'
import type { RoomRecipes } from '@/components/RoomRecipesSettings'
import type { NotifyMode, DeptNotifyCfg, NotifyRecipients } from '@/lib/rrNotify'
import { toast } from 'sonner'

const DEPT_ORDER = DEPARTMENTS.map((d) => d.value)

/**
 * Who gets notified when an order (bulk routine or room order) is sent to a
 * fulfilling department. "Whole department" → every active member (default, so
 * both staff and managers see it); "Manager only" → the department's managers;
 * "Specific staff" → the picked people (used to cover when a manager is away).
 */
export function RoomNotifySettings() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const companyId = activeCompany?.id ?? null

  const [assignedDepts, setAssignedDepts] = useState<Department[]>([])
  const [config, setConfig] = useState<NotifyRecipients>({})
  const [staff, setStaff] = useState<Record<string, { id: string; full_name: string }[]>>({})
  const [loading, setLoading] = useState(true)
  const [canEdit, setCanEdit] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!companyId || !profile) return
    setLoading(true)
    const [recRes, cfgRes, staffRes] = await Promise.all([
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_room_recipes').maybeSingle(),
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_notify_recipients').maybeSingle(),
      supabase.from('kaizen_profiles').select('id, full_name, department')
        .eq('company_id', companyId).eq('is_active', true).is('deleted_at', null)
        .in('role', ['staff', 'manager']).order('full_name'),
    ])
    const recipes = (recRes.data?.value as RoomRecipes) ?? {}
    const set = new Set<Department>()
    Object.values(recipes).forEach((lines) => (lines ?? []).forEach((l) => set.add(l.fulfill_department)))
    setAssignedDepts(DEPT_ORDER.filter((d) => set.has(d)))
    setConfig((cfgRes.data?.value as NotifyRecipients) ?? {})
    const byDept: Record<string, { id: string; full_name: string }[]> = {}
    ;((staffRes.data as { id: string; full_name: string; department: string | null }[]) ?? []).forEach((p) => {
      if (p.department) (byDept[p.department] ||= []).push({ id: p.id, full_name: p.full_name })
    })
    setStaff(byDept)
    setCanEdit(profile.role === 'super_admin' || profile.role === 'manager')
    setLoading(false)
  }, [companyId, profile])
  useEffect(() => { load() }, [load])

  const deptCfg = (d: Department): DeptNotifyCfg => config[d] ?? { mode: 'department', ids: [] }
  const setMode = (d: Department, mode: NotifyMode) => setConfig((c) => ({ ...c, [d]: { ...deptCfg(d), mode } }))
  const toggleUser = (d: Department, id: string) => setConfig((c) => {
    const cur = config[d] ?? { mode: 'users' as const, ids: [] }
    const ids = cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : [...cur.ids, id]
    return { ...c, [d]: { ...cur, ids } }
  })

  async function save() {
    if (!companyId) return
    setSaving(true)
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_notify_recipients', value: config }, { onConflict: 'company_id,key' })
    setSaving(false)
    if (error) toast.error(error.message)
    else toast.success(lang === 'th' ? 'บันทึกแล้ว' : 'Saved')
  }

  if (loading || !canEdit) return null

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <BellRing className="h-4 w-4 text-gray-400" />
          <h3 className="font-semibold text-gray-900">{lang === 'th' ? 'ผู้รับการแจ้งเตือนออเดอร์' : 'Order notifications'}</h3>
        </div>
        <p className="text-xs text-gray-500">
          {lang === 'th'
            ? 'เลือกผู้รับการแจ้งเตือนเมื่อมีการส่งออเดอร์ (ทั้งใบสั่งประจำและออเดอร์ห้อง) ไปยังแต่ละแผนกผู้ดำเนินการ ปกติแจ้งทั้งแผนก (ทั้งพนักงานและผู้จัดการ) แต่สามารถเลือกแจ้งเฉพาะผู้จัดการหรือเฉพาะบางคน (เช่น เมื่อผู้จัดการลาหยุด)'
            : 'Choose who gets alerted when an order is sent to a fulfilling department — covers both bulk routines and room orders. By default the whole department is notified (both staff and managers); you can narrow it to managers only, or pick specific staff to cover when a manager is away.'}
        </p>
      </div>

      {assignedDepts.length === 0 ? (
        <div className="text-center py-6 rounded-xl border border-dashed border-gray-200 text-sm text-gray-400">
          {lang === 'th' ? 'ยังไม่มีแผนกผู้ดำเนินการในสูตร' : 'No fulfilling departments in the recipes yet.'}
        </div>
      ) : (
        <div className="space-y-2">
          {assignedDepts.map((d) => {
            const cfg = deptCfg(d)
            const members = staff[d] ?? []
            return (
              <div key={d} className="rounded-lg border border-gray-150 bg-gray-50/40 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-sm font-semibold text-gray-800">{deptLabel(d, lang)}</span>
                  <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs font-medium">
                    {(['manager', 'department', 'users'] as const).map((m) => (
                      <button key={m} onClick={() => setMode(d, m)}
                        className={`px-2.5 h-7 border-l first:border-l-0 border-gray-300 ${cfg.mode === m ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                        {m === 'manager'
                          ? (lang === 'th' ? 'เฉพาะผู้จัดการ' : 'Manager only')
                          : m === 'department'
                            ? (lang === 'th' ? 'ทั้งแผนก' : 'Whole dept')
                            : (lang === 'th' ? 'เฉพาะบางคน' : 'Specific staff')}
                      </button>
                    ))}
                  </div>
                </div>
                {cfg.mode === 'users' && (
                  members.length === 0 ? (
                    <p className="text-[11px] text-gray-400">{lang === 'th' ? 'ไม่มีพนักงานในแผนกนี้' : 'No staff in this department.'}</p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white divide-y divide-gray-50">
                      {members.map((m) => (
                        <label key={m.id} className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-gray-50 text-xs">
                          <input type="checkbox" checked={cfg.ids.includes(m.id)} onChange={() => toggleUser(d, m.id)}
                            className="h-3.5 w-3.5 accent-[var(--brand-primary)]" />
                          <span className="text-gray-800">{m.full_name}</span>
                        </label>
                      ))}
                    </div>
                  )
                )}
              </div>
            )
          })}
          <button onClick={save} disabled={saving}
            className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'บันทึก' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
