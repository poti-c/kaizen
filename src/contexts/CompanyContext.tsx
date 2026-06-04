import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { KaizenCompany } from '@/types'

interface CompanyContextValue {
  activeCompany: KaizenCompany | null
  companies: KaizenCompany[]
  setActiveCompany: (company: KaizenCompany) => void
  loading: boolean
}

const CompanyContext = createContext<CompanyContextValue | null>(null)

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth()
  const [companies, setCompanies] = useState<KaizenCompany[]>([])
  const [activeCompany, setActiveCompanyState] = useState<KaizenCompany | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchCompanies = useCallback(async () => {
    if (!profile) {
      setCompanies([])
      setActiveCompanyState(null)
      setLoading(false)
      return
    }

    setLoading(true)

    if (profile.role === 'super_admin') {
      // Switcher = home company (company_id) + any cross-company grants
      const [linksRes, homeRes] = await Promise.all([
        supabase.from('kaizen_super_admin_companies').select('company:kaizen_companies(*)').eq('super_admin_id', profile.id),
        profile.company_id
          ? supabase.from('kaizen_companies').select('*').eq('id', profile.company_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ])

      const linked = ((linksRes.data || []) as unknown as { company: KaizenCompany }[])
        .map(r => r.company)
        .filter(Boolean)
      const home = (homeRes.data as KaizenCompany | null) ?? null

      const byId = new Map<string, KaizenCompany>()
      if (home) byId.set(home.id, home)
      for (const c of linked) byId.set(c.id, c)
      const cos = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))

      setCompanies(cos)

      const savedId = localStorage.getItem('kaizen-active-company')
      const saved = cos.find(c => c.id === savedId)
      setActiveCompanyState(saved || cos[0] || null)
    } else {
      if (profile.company_id) {
        const { data } = await supabase
          .from('kaizen_companies')
          .select('*')
          .eq('id', profile.company_id)
          .single()
        if (data) {
          const company = data as KaizenCompany
          setCompanies([company])
          setActiveCompanyState(company)
        }
      }
    }

    setLoading(false)
  }, [profile])

  useEffect(() => {
    fetchCompanies()
  }, [fetchCompanies])

  function setActiveCompany(company: KaizenCompany) {
    setActiveCompanyState(company)
    localStorage.setItem('kaizen-active-company', company.id)
  }

  return (
    <CompanyContext.Provider value={{ activeCompany, companies, setActiveCompany, loading }}>
      {children}
    </CompanyContext.Provider>
  )
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany must be used within CompanyProvider')
  return ctx
}
