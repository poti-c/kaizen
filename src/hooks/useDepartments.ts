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
      .select('custom_departments')
      .eq('company_id', activeCompany.id)
      .maybeSingle()
      .then(({ data }) => {
        setCustomDepts((data?.custom_departments as string[] | null) ?? [])
        setLoading(false)
      })
  }, [activeCompany?.id])

  // Built-in departments with typed slugs; custom departments with their label as both
  // value and label (because cases store the label string, not a generated slug).
  const builtInOptions: DepartmentOption[] = DEPARTMENTS.map(d => ({ ...d, isCustom: false }))
  const customOptions: DepartmentOption[] = customDepts.map(label => ({ value: label, label, isCustom: true }))
  const allOptions: DepartmentOption[] = [...builtInOptions, ...customOptions]

  return {
    allOptions,
    allValues: allOptions.map(d => d.value),
    customDepts,
    loading,
  }
}
