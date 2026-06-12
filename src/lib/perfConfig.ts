// Configurable performance-scoring model. Top Management adjusts the relative
// weight of each indicator (and optionally folds in PMS / Routine Roster
// reliability). Stored per company in kaizen_settings under key 'perf_config'.
//
// Weights are RELATIVE — the score engine normalises over the indicators that
// have a value in the period, so they need not sum to 100.

import { supabase } from '@/lib/supabase'

export type StaffWeightKey = 'resolution' | 'ontime' | 'speed' | 'quality' | 'engagement' | 'pms' | 'rr'
export type ManagerWeightKey = 'approval' | 'teamres' | 'teamsla' | 'leadership' | 'oversight' | 'pms' | 'rr'

export interface PerfConfig {
  staff: Record<StaffWeightKey, number>
  manager: Record<ManagerWeightKey, number>
  includePms: boolean
  includeRr: boolean
}

export const DEFAULT_PERF_CONFIG: PerfConfig = {
  staff: { resolution: 30, ontime: 25, speed: 15, quality: 10, engagement: 20, pms: 15, rr: 15 },
  manager: { approval: 25, teamres: 20, teamsla: 20, leadership: 20, oversight: 15, pms: 15, rr: 15 },
  includePms: false,
  includeRr: false,
}

/** Merge a stored (possibly partial) config over the defaults. */
export function normalizePerfConfig(raw: unknown): PerfConfig {
  const d = DEFAULT_PERF_CONFIG
  if (!raw || typeof raw !== 'object') return { ...d, staff: { ...d.staff }, manager: { ...d.manager } }
  const r = raw as Partial<PerfConfig>
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : fallback)
  return {
    staff: {
      resolution: num(r.staff?.resolution, d.staff.resolution),
      ontime: num(r.staff?.ontime, d.staff.ontime),
      speed: num(r.staff?.speed, d.staff.speed),
      quality: num(r.staff?.quality, d.staff.quality),
      engagement: num(r.staff?.engagement, d.staff.engagement),
      pms: num(r.staff?.pms, d.staff.pms),
      rr: num(r.staff?.rr, d.staff.rr),
    },
    manager: {
      approval: num(r.manager?.approval, d.manager.approval),
      teamres: num(r.manager?.teamres, d.manager.teamres),
      teamsla: num(r.manager?.teamsla, d.manager.teamsla),
      leadership: num(r.manager?.leadership, d.manager.leadership),
      oversight: num(r.manager?.oversight, d.manager.oversight),
      pms: num(r.manager?.pms, d.manager.pms),
      rr: num(r.manager?.rr, d.manager.rr),
    },
    includePms: !!r.includePms,
    includeRr: !!r.includeRr,
  }
}

/** Load a company's performance config (defaults if none saved). */
export async function loadPerfConfig(companyId: string | null | undefined): Promise<PerfConfig> {
  if (!companyId) return normalizePerfConfig(null)
  const { data } = await supabase
    .from('kaizen_settings')
    .select('value')
    .eq('company_id', companyId)
    .eq('key', 'perf_config')
    .maybeSingle()
  return normalizePerfConfig(data?.value)
}
