// Permanent fix for the "custom department blind spot" pattern.
// Any component that needs to list or validate departments imports this hook
// instead of using DEPARTMENTS directly — so custom labels are never silently dropped.
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { DEPARTMENTS } from '@/types'
import { useCompany } from '@/contexts/CompanyContext'

export interface DepartmentOption {
  value: string
  label: string
  isCustom: boolean
}

export function useDepartments() {
  const { activeCompany } = useCompany()
  const [customDepts, setCustomDepts] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!activeCompany?.id) { setLoading(false); return }
    supabase
      .from('kaizen_settings')
      .select('value')
      .eq('company_id', activeCompany.id)
      .eq('key', 'custom_departments')
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.error('[useDepartments]', error.message)
        setCustomDepts((data?.value as string[] | null) ?? [])
        setLoading(false)
      })
  }, [activeCompany?.id])

  // `custom_departments` (when set) is the company's COMPLETE, curated roster of labels —
  // not extras to append. Map each label back to its built-in slug where one matches (so
  // cases stay consistent with the typed Department values); anything unmatched is a genuine
  // custom department whose label doubles as its value. Appending the built-ins here was the
  // old bug: it duplicated every default (e.g. front_office + "Front Office").
  const LABEL_TO_VALUE: Record<string, string> = Object.fromEntries(DEPARTMENTS.map(d => [d.label, d.value]))
  const TOP_MANAGEMENT = DEPARTMENTS.find(d => d.value === 'top_management')!
  const curated: DepartmentOption[] = customDepts.map(label => {
    const builtinValue = LABEL_TO_VALUE[label]
    return builtinValue
      ? { value: builtinValue, label, isCustom: false }
      : { value: label, label, isCustom: true }
  })
  // Top Management is deliberately excluded from the editable Settings roster, but it's still
  // a real department some screens rely on — keep it at the front. Fall back to the full
  // built-in set when a company hasn't curated anything yet.
  const allOptions: DepartmentOption[] = curated.length > 0
    ? (curated.some(o => o.value === 'top_management') ? curated : [{ ...TOP_MANAGEMENT, isCustom: false }, ...curated])
    : DEPARTMENTS.map(d => ({ ...d, isCustom: false }))

  return {
    allOptions,
    allValues: allOptions.map(d => d.value),
    customDepts,
    loading,
  }
}
