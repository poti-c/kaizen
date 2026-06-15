import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * Can the current user place/view Routine Roster orders?
 * Managers/super-admins and non-front-office staff (who fulfil) always can.
 * Front-office STAFF are gated by the authorized list in settings
 * (key `rr_fo_authorized`); an empty/absent list means all front office is allowed.
 */
export function useRrFoAccess(): { allowed: boolean; loading: boolean } {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const [authorized, setAuthorized] = useState<string[] | null>(null) // null = not loaded yet

  const isFrontOfficeStaff = profile?.role === 'staff' && profile?.department === 'front_office'

  useEffect(() => {
    if (!activeCompany || !isFrontOfficeStaff) { setAuthorized([]); return }
    let stale = false
    supabase.from('kaizen_settings').select('value')
      .eq('company_id', activeCompany.id).eq('key', 'rr_fo_authorized').maybeSingle()
      .then(({ data }) => { if (!stale) setAuthorized(Array.isArray(data?.value) ? (data!.value as string[]) : []) })
    return () => { stale = true }
  }, [activeCompany?.id, isFrontOfficeStaff]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!profile) return { allowed: false, loading: false }
  if (profile.role === 'super_admin' || profile.role === 'manager') return { allowed: true, loading: false }
  if (!isFrontOfficeStaff) return { allowed: true, loading: false } // fulfilling depts etc. unaffected
  if (authorized === null) return { allowed: true, loading: true } // optimistic while loading
  return { allowed: authorized.length === 0 || authorized.includes(profile.id), loading: false }
}
