import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DEPARTMENTS } from '@/types'
import type { Department } from '@/types'

type LoginRole = 'super_admin' | 'manager' | 'staff'

export function LoginPage() {
  const navigate = useNavigate()
  const { signInAdmin, signInManager, signInStaff } = useAuth()
  const { lang, setLang, t } = useLanguage()

  const [role, setRole] = useState<LoginRole>('staff')
  const [department, setDepartment] = useState<Department | ''>('')
  const [emailOrUsername, setEmailOrUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (role !== 'super_admin' && !department) {
      setError(t.login.noDeptError)
      return
    }

    setLoading(true)
    try {
      if (role === 'super_admin') {
        await signInAdmin(emailOrUsername, password)
      } else if (role === 'manager') {
        await signInManager(emailOrUsername, password, department as Department)
      } else {
        await signInStaff(emailOrUsername, password, department as Department)
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
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white">Na Nirand Kaizen System</h1>
          <p className="text-white/70 text-sm mt-1">Improving Together</p>
        </div>

        {/* Card — logo as faded background */}
        <div className="relative bg-white rounded-2xl shadow-2xl p-8 overflow-hidden">
          {/* Faded logo watermark */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
            <img src="/kaizen-icon.svg" alt="" className="w-full h-full object-contain opacity-[0.06] scale-110" />
          </div>

          <h2 className="text-xl font-semibold text-gray-900 mb-6 relative">{t.login.title}</h2>

          <form onSubmit={handleSubmit} className="space-y-4 relative z-10">
            {/* Role selector */}
            <div className="space-y-1.5">
              <Label>{t.login.signInAs}</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['super_admin', 'manager', 'staff'] as LoginRole[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => { setRole(r); setDepartment(''); setEmailOrUsername(''); setError('') }}
                    className={`py-2 px-3 rounded-lg text-xs font-medium border transition-all ${
                      role === r
                        ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {r === 'super_admin' ? t.login.superAdmin : r === 'manager' ? t.login.manager : t.login.staff}
                  </button>
                ))}
              </div>
            </div>

            {/* Department (not for super admin) */}
            {role !== 'super_admin' && (
              <div className="space-y-1.5">
                <Label>{t.login.department}</Label>
                <Select value={department} onValueChange={(v) => setDepartment(v as Department)}>
                  <SelectTrigger>
                    <SelectValue placeholder={t.login.selectDept} />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.filter((d) => d.value !== 'top_management').map((d) => (
                      <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              <Label>{t.login.password}</Label>
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

          <p className="text-center text-xs text-gray-400 mt-6 relative z-10">
            {t.login.footer}
          </p>
          <p className="text-center text-[10px] text-gray-300 mt-2 relative z-10 leading-relaxed">
            © {new Date().getFullYear()} Dr. Poti Chaopaisarn / NNR Solutions. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  )
}
