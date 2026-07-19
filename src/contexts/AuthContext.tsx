import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { KaizenProfile, Role, Department } from '@/types'
import { staffEmail, bangkokDate } from '@/lib/utils'

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
  profileError: boolean
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
  const { data: co, error: coErr } = await supabase
    .from('kaizen_companies')
    .select('is_active')
    .eq('id', companyId)
    .maybeSingle()
  if (!coErr && (!co || co.is_active === false)) {
    await supabase.auth.signOut()
    throw new Error("Your company’s access has been suspended. Please contact your administrator.")
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<KaizenProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [profileError, setProfileError] = useState(false)
  const lastBeatRef = useRef(0)
  const companyRef = useRef<string | null>(null)
  const signingInRef = useRef(false)
  const initialFetchRef = useRef(false)

  // A transient failure here (flaky mobile network, brief Supabase hiccup) used to leave
  // `profile` null forever with `loading` false — Layout would then redirect to /login,
  // which immediately redirects back to / since `user` is still set, bouncing forever
  // and showing a blank page. Retry once before surfacing profileError so Layout can
  // show a retry screen instead of looping.
  const fetchProfile = useCallback(async (userId: string, attempt = 0): Promise<void> => {
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
        setProfileError(false)
        return
      }
      companyRef.current = p.company_id
      setProfile(p)
      setProfileError(false)
      return
    }
    if (attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return fetchProfile(userId, attempt + 1)
    }
    setProfileError(true)
  }, [])

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id)
  }, [user, fetchProfile])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        initialFetchRef.current = true
        fetchProfile(session.user.id).finally(() => {
          initialFetchRef.current = false
          setLoading(false)
        })
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        // Skip re-fetch on token refresh or when initial getSession fetch is in progress
        if (!signingInRef.current && !initialFetchRef.current && event !== 'TOKEN_REFRESHED' && event !== 'INITIAL_SESSION') {
          setLoading(true)
          fetchProfile(session.user.id).finally(() => setLoading(false))
        }
      } else {
        setProfile(null)
        setProfileError(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [fetchProfile])

  // Activity heartbeat: bump last_active_at on mount, periodically, and when the
  // tab regains focus — throttled to at most once every 3 minutes.
  useEffect(() => {
    if (!user) return
    // Wait until the profile (and its company_id) has loaded. On session restore
    // `user` is set before fetchProfile resolves; beating now would upsert a
    // company_id:null activity row that, thanks to ignoreDuplicates, becomes the
    // persisted row for the day and corrupts per-company engagement scoring.
    const companyId = profile?.company_id ?? null
    if (!companyId) return
    const beat = () => {
      const now = Date.now()
      if (now - lastBeatRef.current < 3 * 60 * 1000) return
      lastBeatRef.current = now
      const iso = new Date().toISOString()
      supabase.from('kaizen_profiles').update({ last_active_at: iso }).eq('id', user.id).then(() => {}, () => {})
      // Log the active day (one row per user per day) for engagement scoring.
      supabase.from('kaizen_user_activity').upsert(
        { user_id: user.id, active_date: bangkokDate(), company_id: companyId },
        { onConflict: 'user_id,active_date', ignoreDuplicates: true }
      ).then(() => {}, () => {})
    }
    // AUTH-008: only beat on mount if the tab is actually visible (consistent with focus/visibilitychange handlers)
    if (document.visibilityState === 'visible') beat()
    const interval = setInterval(beat, 3 * 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') beat() }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user, profile?.company_id])

  // Shared post-auth checks applied to every sign-in path: role gate → suspension
  // gate → company-active gate → hydrate state. Adding a new check here covers all
  // three login flows automatically; forgetting it in one path is no longer possible.
  async function completeSignIn(p: KaizenProfile, allowedRole: Role, roleDeniedMsg: string, suspendedMsg: string) {
    if (p.role !== allowedRole) {
      await supabase.auth.signOut().catch(() => { setUser(null); setProfile(null) })
      throw new Error(roleDeniedMsg)
    }
    if (!p.is_active) {
      await supabase.auth.signOut().catch(() => { setUser(null); setProfile(null) })
      throw new Error(suspendedMsg)
    }
    await assertCompanyActive(p.company_id)
    companyRef.current = p.company_id
    setProfile(p)
    stampLogin(p.id)
  }

  async function signInAdmin(email: string, password: string) {
    signingInRef.current = true
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      const { data: prof, error: profError } = await supabase.from('kaizen_profiles').select('*').eq('id', data.user.id).single()
      // AU-BUG-02: unlike signInStaff below, this used to throw without signing
      // out. signInWithPassword had already created a valid Supabase session, so
      // a transient network blip on the profile read (common on hotel mobile
      // networks) left `user` set with `profile` stuck null and no profileError
      // — LoginPage then navigates away on `user` alone, and Layout renders
      // nothing for that state. The result was a blank white screen with no
      // error and no way back except clearing site data.
      if (profError || !prof) {
        await supabase.auth.signOut().catch(() => { setUser(null); setProfile(null) })
        throw new Error('Profile not found.')
      }
      await completeSignIn(
        prof as KaizenProfile,
        'super_admin',
        'Access denied. Not a Super Admin account.',
        'This account has been suspended. Please contact the system administrator.',
      )
    } finally {
      signingInRef.current = false
    }
  }

  async function signInManager(email: string, password: string) {
    signingInRef.current = true
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      const { data: prof, error: profError } = await supabase.from('kaizen_profiles').select('*').eq('id', data.user.id).single()
      // AU-BUG-02: see the matching comment in signInAdmin above.
      if (profError || !prof) {
        await supabase.auth.signOut().catch(() => { setUser(null); setProfile(null) })
        throw new Error('Profile not found.')
      }
      await completeSignIn(
        prof as KaizenProfile,
        'manager',
        'Access denied. Not a Manager account.',
        'This account has been suspended. Please contact the system administrator.',
      )
    } finally {
      signingInRef.current = false
    }
  }

  async function signInStaff(username: string, password: string, companyCode: string) {
    signingInRef.current = true
    try {
      // Staff auth email is deterministic from username + company code — no pre-auth DB read.
      const email = staffEmail(username, companyCode)
      const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error || !signInData.user) throw new Error('Invalid company code, username, or password.')
      const { data: prof, error: profError } = await supabase.from('kaizen_profiles').select('*').eq('id', signInData.user.id).single()
      if (profError || !prof) {
        await supabase.auth.signOut().catch(() => { setUser(null); setProfile(null) })
        throw new Error('No staff account found for this company and username.')
      }
      await completeSignIn(
        prof as KaizenProfile,
        'staff',
        'This is not a staff account.',
        'This account has been suspended. Please contact your manager or HR.',
      )
    } finally {
      signingInRef.current = false
    }
  }

  async function signOut() {
    companyRef.current = null
    await supabase.auth.signOut()
    setProfile(null)
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, profileError, signInAdmin, signInManager, signInStaff, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
