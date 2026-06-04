import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { KaizenProfile, Role, Department } from '@/types'
import { staffEmailFromUsername } from '@/lib/utils'

interface AuthContextValue {
  user: User | null
  profile: KaizenProfile | null
  loading: boolean
  signInManager: (email: string, password: string, department: Department) => Promise<void>
  signInStaff: (username: string, password: string, department: Department) => Promise<void>
  signInAdmin: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

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

  async function signInManager(email: string, password: string, department: Department) {
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
    if (p.department !== department) {
      await supabase.auth.signOut()
      throw new Error(`Department mismatch. Your account belongs to a different department.`)
    }
    if (!p.is_active) {
      await supabase.auth.signOut()
      throw new Error('This account has been suspended. Please contact the system administrator.')
    }
    setProfile(p)
  }

  async function signInStaff(username: string, password: string, department: Department) {
    // Look up staff by username + department to get their auth email (case-insensitive)
    const { data: prof, error: profError } = await supabase
      .from('kaizen_profiles')
      .select('*')
      .ilike('username', username.trim())
      .eq('department', department)
      .eq('role', 'staff')
      .eq('is_active', true)
      .single()

    if (profError || !prof) {
      throw new Error('No staff account found with this username and department.')
    }

    const p = prof as KaizenProfile
    // Use the stored username (canonical casing) to derive the auth email
    const email = p.email || staffEmailFromUsername(p.username!)

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw new Error('Invalid username or password.')
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
