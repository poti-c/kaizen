import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { KaizenProfile, Role, Department } from '@/types'
import { staffEmail } from '@/lib/utils'

// Stamp last_login_at + last_active_at when a user signs in (fire-and-forget;
// safe to call before the columns exist — the error is just ignored).
async function stampLogin(userId: string) {
  const now = new Date().toISOString()
  try { await supabase.from('kaizen_profiles').update({ last_login_at: now, last_active_at: now }).eq('id', userId) } catch { /* ignore */ }
}

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
  const lastBeatRef = useRef(0)
  const companyRef = useRef<string | null>(null)

  const fetchProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('kaizen_profiles')
      .select('*')
      .eq('id', userId)
      .single()
    if (!error && data) {
      const p = data as KaizenProfile
      // Enforce suspension on the session-restore / token-refresh path too. Interactive
      // sign-in already blocks !is_active, but without this a user (incl. a super_admin)
      // suspended mid-session would keep full access until they manually logged out.
      if (!p.is_active) {
        await supabase.auth.signOut()
        setProfile(null)
        return
      }
      companyRef.current = p.company_id
      setProfile(p)
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

  // Activity heartbeat: bump last_active_at on mount, periodically, and when the
  // tab regains focus — throttled to at most once every 3 minutes.
  useEffect(() => {
    if (!user) return
    const beat = () => {
      const now = Date.now()
      if (now - lastBeatRef.current < 3 * 60 * 1000) return
      lastBeatRef.current = now
      const iso = new Date().toISOString()
      supabase.from('kaizen_profiles').update({ last_active_at: iso }).eq('id', user.id).then(() => {}, () => {})
      // Log the active day (one row per user per day) for engagement scoring.
      supabase.from('kaizen_user_activity').upsert(
        { user_id: user.id, active_date: iso.slice(0, 10), company_id: companyRef.current },
        { onConflict: 'user_id,active_date', ignoreDuplicates: true }
      ).then(() => {}, () => {})
    }
    beat()
    const interval = setInterval(beat, 3 * 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') beat() }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user])

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
    companyRef.current = p.company_id
    setProfile(p)
    stampLogin(p.id)
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
    companyRef.current = p.company_id
    setProfile(p)
    stampLogin(p.id)
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
    companyRef.current = p.company_id
    setProfile(p)
    stampLogin(p.id)
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
