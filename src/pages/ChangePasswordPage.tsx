import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { KeyRound, Eye, EyeOff, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'

export function ChangePasswordPage() {
  const { user, profile, loading, refreshProfile } = useAuth()
  const { lang } = useLanguage()
  const navigate = useNavigate()
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [saving, setSaving] = useState(false)

  // Must be signed in to change a password
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (newPassword.trim().length < 8) { toast.error(lang === 'th' ? 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร (ไม่นับช่องว่าง)' : 'Password must be at least 8 non-whitespace characters.'); return }
    if (newPassword !== confirmPassword) { toast.error(lang === 'th' ? 'รหัสผ่านไม่ตรงกัน' : 'Passwords do not match.'); return }
    if (!profile?.id) { toast.error(lang === 'th' ? 'กำลังโหลดข้อมูลโปรไฟล์ กรุณารอสักครู่แล้วลองอีกครั้ง' : 'Your profile is still loading — please wait a moment and try again.'); return }
    setSaving(true)
    try {
      const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword })
      if (pwErr) throw pwErr
      // Clear the must_change_password flag (verify it persisted)
      const { error: flagErr } = await supabase.from('kaizen_profiles').update({ must_change_password: false }).eq('id', profile.id)
      if (flagErr) throw flagErr
      await refreshProfile?.()
      toast.success(lang === 'th' ? 'เปลี่ยนรหัสผ่านสำเร็จ' : 'Password changed successfully.')
      navigate('/', { replace: true }) // RoleRedirect sends each role to its correct home
    } catch (err) {
      console.error('Change password error:', err)
      toast.error(lang === 'th' ? 'เปลี่ยนรหัสผ่านไม่สำเร็จ' : 'Failed to change password.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 bg-[var(--brand-primary)]/10 rounded-full flex items-center justify-center mb-3">
            <KeyRound className="h-6 w-6 text-[var(--brand-primary)]" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">{lang === 'th' ? 'เปลี่ยนรหัสผ่านของคุณ' : 'Change Your Password'}</h1>
          <p className="text-sm text-gray-500 text-center mt-1">
            {lang === 'th'
              ? 'ผู้จัดการของคุณตั้งรหัสผ่านชั่วคราวไว้ กรุณาตั้งรหัสผ่านใหม่ก่อนดำเนินการต่อ'
              : 'Your manager has set a temporary password. Please set a new password before continuing.'}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>{lang === 'th' ? 'รหัสผ่านใหม่' : 'New Password'}</Label>
            <div className="relative">
              <Input
                type={showPw ? 'text' : 'password'}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder={lang === 'th' ? 'อย่างน้อย 8 ตัวอักษร' : 'Min 8 characters'}
                className="pr-10"
                required
              />
              <button type="button" onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{lang === 'th' ? 'ยืนยันรหัสผ่าน' : 'Confirm Password'}</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder={lang === 'th' ? 'กรอกรหัสผ่านอีกครั้ง' : 'Repeat password'}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : (lang === 'th' ? 'ตั้งรหัสผ่านใหม่' : 'Set New Password')}
          </Button>
        </form>
      </div>
    </div>
  )
}
