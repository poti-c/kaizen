import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { KaizenProfile, Role, Department } from '@/types'
import { staffEmail } from '@/lib/utils'

interface AuthContextValue {
  user: User | null
  profile: KaizenProfile | null
  loading: boolean
  signInManager: (email: string, password: string) => Promise<void>
  signInStaff: (username: string, password: string, companyCode: string) => Promise<void>
  signInAdmin: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Block access when a company's subscription is suspended. Signs the user out
// and throws a clear message. (Super admins are gated per-company in CompanyContext.)
async function assertCompanyActive(companyId: string | null) {
  if (!companyId) return
  const { data: co } = await supabase
    .from('kaizen_companies')
    .select('is_active')
    .eq('id', companyId)
    .maybeSingle()
  if (co && co.is_active === false) {
    await supabase.auth.signOut()
    throw new Error('Your company’s access has been suspended. Please contact your administrator.')
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<KaizenProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('kaizen_profiles')
      .select('*')
      .eq('id', userId)
      .single()
    if (!error && data) {
      setProfile(data as KaizenProfile)
    }
  }, [])

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id)
  }, [user, fetchProfile])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        fetchProfile(session.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        fetchProfile(session.user.id)
      } else {
        setProfile(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [fetchProfile])

  async function signInAdmin(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error

    const { data: prof, error: profError } = await supabase
      .from('kaizen_profiles')
      .select('*')
      .eq('id', data.user.id)
      .single()

    if (profError || !prof) throw new Error('Profile not found.')
    const p = prof as KaizenProfile
    if (p.role !== 'super_admin') {
      await supabase.auth.signOut()
      throw new Error('Access denied. Not a Super Admin account.')
    }
    if (!p.is_active) {
      await supabase.auth.signOut()
      throw new Error('This account has been suspended. Please contact the system administrator.')
    }
    setProfile(p)
  }

  async function signInManager(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error

    const { data: prof, error: profError } = await supabase
      .from('kaizen_profiles')
      .select('*')
      .eq('id', data.user.id)
      .single()

    if (profError || !prof) throw new Error('Profile not found.')
    const p = prof as KaizenProfile
    if (p.role !== 'manager') {
      await supabase.auth.signOut()
      throw new Error('Access denied. Not a Manager account.')
    }
    if (!p.is_active) {
      await supabase.auth.signOut()
      throw new Error('This account has been suspended. Please contact the system administrator.')
    }
    await assertCompanyActive(p.company_id)
    setProfile(p)
  }

  async function signInStaff(username: string, password: string, companyCode: string) {
    // Staff auth email is deterministic from username + company code — no pre-auth DB read.
    const email = staffEmail(username, companyCode)

    const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error || !signInData.user) throw new Error('Invalid company code, username, or password.')

    // Authenticated — now read own profile (RLS-allowed) and verify role/status
    const { data: prof, error: profError } = await supabase
      .from('kaizen_profiles')
      .select('*')
      .eq('id', signInData.user.id)
      .single()

    if (profError || !prof) {
      await supabase.auth.signOut()
      throw new Error('No staff account found for this company and username.')
    }
    const p = prof as KaizenProfile
    if (p.role !== 'staff') {
      await supabase.auth.signOut()
      throw new Error('This is not a staff account.')
    }
    if (!p.is_active) {
      await supabase.auth.signOut()
      throw new Error('This account has been suspended. Please contact your manager or HR.')
    }
    await assertCompanyActive(p.company_id)
    setProfile(p)
  }

  async function signOut() {
    await supabase.auth.signOut()
    setProfile(null)
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, signInAdmin, signInManager, signInStaff, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
