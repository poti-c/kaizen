import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2, ArrowLeft, CheckCircle } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase } from '@/lib/supabase'

type LoginRole = 'super_admin' | 'manager' | 'staff'

export function LoginPage() {
  const navigate = useNavigate()
  const { signInAdmin, signInManager, signInStaff } = useAuth()
  const { lang, setLang, t } = useLanguage()

  const [role, setRole] = useState<LoginRole>('staff')
  const [companyCode, setCompanyCode] = useState('')
  const [emailOrUsername, setEmailOrUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Forgot password state
  const [forgotMode, setForgotMode] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetLoading, setResetLoading] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [resetError, setResetError] = useState('')

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault()
    setResetError('')
    setResetLoading(true)
    try {
      const { data, error: lookupError } = await supabase
        .from('kaizen_profiles')
        .select('id')
        .eq('email', resetEmail.trim().toLowerCase())
        .maybeSingle()

      if (lookupError) throw lookupError
      if (!data) {
        setResetError(t.login.emailNotRegistered)
        return
      }

      const { error } = await supabase.auth.resetPasswordForEmail(resetEmail.trim(), {
        redirectTo: `${window.location.origin}/settings`,
      })
      if (error) throw error
      setResetSent(true)
    } catch (err: unknown) {
      if (!resetError) setResetError(err instanceof Error ? err.message : 'Failed to send reset email.')
    } finally {
      setResetLoading(false)
    }
  }

  function exitForgotMode() {
    setForgotMode(false)
    setResetEmail('')
    setResetSent(false)
    setResetError('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (role === 'staff' && !companyCode.trim()) {
      setError(t.login.noCompanyCode)
      return
    }

    setLoading(true)
    try {
      if (role === 'super_admin') {
        await signInAdmin(emailOrUsername, password)
      } else if (role === 'manager') {
        await signInManager(emailOrUsername, password)
      } else {
        await signInStaff(emailOrUsername, password, companyCode)
      }
      navigate('/dashboard')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, var(--brand-sidebar) 0%, var(--brand-primary) 100%)' }}
    >
      {/* Language toggle — top right */}
      <button
        onClick={() => setLang(lang === 'en' ? 'th' : 'en')}
        className="fixed top-4 right-4 bg-white/20 hover:bg-white/30 text-white text-xs font-semibold px-3 py-1.5 rounded-full transition-colors backdrop-blur"
      >
        {lang === 'en' ? 'ภาษาไทย' : 'English'}
      </button>

      <div className="w-full max-w-md">
        {/* Brand header */}
        <div className="mb-8">
          <div className="flex items-center gap-3">
            <img src="/kaizen-icon.svg" alt="Kaizen" className="w-[62px] h-[62px]" />
            <div className="text-left">
              <h1 className="text-4xl font-bold text-white leading-tight">Kaizen <span className="text-[#E2C886]">System</span></h1>
              <p className="text-white/70 text-sm mt-0.5">Improving Together</p>
            </div>
          </div>
        </div>

        {/* Card */}
        <div className="relative bg-white rounded-2xl shadow-2xl p-8 overflow-hidden">

          <div className="flex items-center justify-between mb-6 relative">
            <h2 className="text-xl font-semibold text-[var(--brand-sidebar)]">
              {forgotMode ? t.login.resetTitle : t.login.title}
            </h2>
            {!forgotMode && (
              <div className="flex gap-1.5">
                {(['super_admin', 'manager', 'staff'] as LoginRole[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => { setRole(r); setCompanyCode(''); setEmailOrUsername(''); setError('') }}
                    className={`py-1 px-2.5 rounded-lg text-xs font-medium border transition-all ${
                      role === r
                        ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {r === 'super_admin' ? t.login.superAdmin : r === 'manager' ? t.login.manager : t.login.staff}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Forgot password panel ── */}
          {forgotMode && (
            <div className="space-y-4 relative z-10">
              {role === 'staff' ? (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-700">
                  {t.login.contactManager}
                </div>
              ) : resetSent ? (
                <div className="flex flex-col items-center gap-3 py-4 text-center">
                  <CheckCircle className="h-10 w-10 text-green-500" />
                  <p className="text-sm text-gray-600">{t.login.resetSent}</p>
                </div>
              ) : (
                <form onSubmit={handleResetPassword} className="space-y-4">
                  <p className="text-sm text-gray-500">{t.login.resetSubtitle}</p>
                  <div className="space-y-1.5">
                    <Label>{t.login.email}</Label>
                    <Input
                      type="email"
                      placeholder={t.login.enterEmail}
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      autoComplete="email"
                      required
                    />
                  </div>
                  {resetError && (
                    <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
                      {resetError}
                    </div>
                  )}
                  <Button type="submit" className="w-full" size="lg" disabled={resetLoading}>
                    {resetLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t.login.sendResetLink}
                  </Button>
                </form>
              )}
              <button
                type="button"
                onClick={exitForgotMode}
                className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors mx-auto"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t.login.backToLogin}
              </button>
            </div>
          )}

          {/* ── Sign in form ── */}
          {!forgotMode && (
          <form onSubmit={handleSubmit} className="space-y-4 relative z-10">
            {/* Company Code (staff only — scopes their username to a company) */}
            {role === 'staff' && (
              <div className="space-y-1.5">
                <Label>{t.login.companyCode}</Label>
                <Input
                  type="text"
                  placeholder={t.login.enterCompanyCode}
                  value={companyCode}
                  onChange={(e) => setCompanyCode(e.target.value)}
                  autoComplete="organization"
                  autoCapitalize="none"
                  required
                />
              </div>
            )}

            {/* Email / Username */}
            <div className="space-y-1.5">
              <Label>{role === 'staff' ? t.login.username : t.login.email}</Label>
              <Input
                type={role === 'staff' ? 'text' : 'email'}
                placeholder={role === 'staff' ? t.login.enterUsername : t.login.enterEmail}
                value={emailOrUsername}
                onChange={(e) => setEmailOrUsername(e.target.value)}
                autoComplete={role === 'staff' ? 'username' : 'email'}
                required
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{t.login.password}</Label>
                <button
                  type="button"
                  onClick={() => { setForgotMode(true); setResetEmail(emailOrUsername) }}
                  className="text-xs text-[var(--brand-primary)] hover:underline"
                >
                  {t.login.forgotPassword}
                </button>
              </div>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t.login.enterPassword}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" size="lg" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t.login.title}
            </Button>
          </form>
          )}

          <p className="text-center text-xs text-gray-400 mt-6 relative z-10">
            {t.login.footer}
          </p>
          <p className="text-center text-[10px] text-gray-300 mt-2 relative z-10 leading-relaxed">
            Kaizen System V.1 by NNR-Solutions {new Date().getFullYear()} ©
          </p>
        </div>
      </div>
    </div>
  )
}
