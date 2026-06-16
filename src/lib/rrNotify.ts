import { supabase } from '@/lib/supabase'

// Per-fulfilling-department notification policy, shared by bulk routines and room orders.
// 'department' → every active member of the department (default — staff + managers all see it)
// 'manager'    → the department's managers only
// 'users'      → a hand-picked set of staff (e.g. cover while a manager is away)
export type NotifyMode = 'manager' | 'department' | 'users'
export interface DeptNotifyCfg { mode: NotifyMode; ids: string[] }
export type NotifyRecipients = Record<string, DeptNotifyCfg>

export async function loadNotifyRecipients(companyId: string): Promise<NotifyRecipients> {
  const { data } = await supabase.from('kaizen_settings').select('value')
    .eq('company_id', companyId).eq('key', 'rr_notify_recipients').maybeSingle()
  return (data?.value as NotifyRecipients) ?? {}
}

/** Resolve who should be notified for a fulfilling department (default = its managers). */
export async function resolveDeptRecipients(companyId: string, dept: string): Promise<{ id: string; role: string }[]> {
  const cfg = await loadNotifyRecipients(companyId)
  const dc = cfg[dept]
  const mode: NotifyMode = dc?.mode ?? 'department'
  if (mode === 'users' && dc?.ids?.length) {
    const { data } = await supabase.from('kaizen_profiles').select('id, role')
      .eq('company_id', companyId).eq('is_active', true).in('id', dc.ids)
    return (data as { id: string; role: string }[]) ?? []
  }
  let q = supabase.from('kaizen_profiles').select('id, role')
    .eq('company_id', companyId).eq('is_active', true).eq('department', dept)
  if (mode === 'manager') q = q.eq('role', 'manager')
  const { data } = await q
  return (data as { id: string; role: string }[]) ?? []
}
