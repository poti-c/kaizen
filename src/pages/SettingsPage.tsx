import { useState } from 'react'
import { Eye, EyeOff, Loader2, Palette, Lock, Info, Scale, Pencil, Check, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DEPARTMENT_LABELS } from '@/types'
import { toast } from 'sonner'

const PRESET_COLORS = [
  { label: 'Teal Pro',     primary: '#0891b2', accent: '#06b6d4', sidebar: '#1c2b3a' },
  { label: 'Navy Blue',    primary: '#1e3a5f', accent: '#c9a84c', sidebar: '#0f2744' },
  { label: 'Forest Green', primary: '#1a4731', accent: '#d4a853', sidebar: '#0e2e1e' },
  { label: 'Burgundy',     primary: '#6b1f2e', accent: '#d4a853', sidebar: '#4a0f1d' },
  { label: 'Slate',        primary: '#334155', accent: '#f59e0b', sidebar: '#1e293b' },
  { label: 'Purple',       primary: '#4c1d95', accent: '#f59e0b', sidebar: '#2d1164' },
]

export function SettingsPage() {
  const { profile, refreshProfile } = useAuth()
  const { settings, updateSettings } = useTheme()
  const { t } = useLanguage()

  // Profile edit state
  const [editingProfile, setEditingProfile] = useState(false)
  const [editName, setEditName] = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)

  function openProfileEdit() {
    setEditName(profile?.full_name ?? '')
    setEditUsername(profile?.username ?? '')
    setEditingProfile(true)
  }

  function cancelProfileEdit() {
    setEditingProfile(false)
  }

  async function saveProfile() {
    if (!profile) return
    const trimmedName = editName.trim()
    if (!trimmedName) { toast.error('Name cannot be empty.'); return }
    setSavingProfile(true)
    try {
      const updates: { full_name: string; username?: string } = { full_name: trimmedName }
      if (profile.role === 'staff') updates.username = editUsername.trim() || profile.username || ''
      const { error } = await supabase.from('kaizen_profiles').update(updates).eq('id', profile.id)
      if (error) throw error
      await refreshProfile()
      toast.success('Profile updated.')
      setEditingProfile(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile.')
    } finally {
      setSavingProfile(false)
    }
  }

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)

  const [customPrimary, setCustomPrimary] = useState(settings.primary_color)
  const [customAccent, setCustomAccent] = useState(settings.accent_color)
  const [customSidebar, setCustomSidebar] = useState(settings.sidebar_color)
  const [savingTheme, setSavingTheme] = useState(false)

  async function handleChangePassword() {
    if (!newPassword || !confirmPassword) {
      toast.error(t.settings.mismatch)
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error(t.settings.mismatch)
      return
    }
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters.')
      return
    }
    setChangingPassword(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) throw error
      toast.success(t.settings.passwordUpdated)
      setNewPassword(''); setConfirmPassword('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.settings.failedPassword)
    } finally {
      setChangingPassword(false)
    }
  }

  async function handleSaveTheme() {
    setSavingTheme(true)
    try {
      await updateSettings({ primary_color: customPrimary, accent_color: customAccent, sidebar_color: customSidebar })
      toast.success(t.settings.themeApplied)
    } catch {
      toast.error(t.settings.failedTheme)
    } finally {
      setSavingTheme(false)
    }
  }

  function applyPreset(preset: typeof PRESET_COLORS[0]) {
    setCustomPrimary(preset.primary)
    setCustomAccent(preset.accent)
    setCustomSidebar(preset.sidebar)
    updateSettings({ primary_color: preset.primary, accent_color: preset.accent, sidebar_color: preset.sidebar })
    toast.success(`Applied "${preset.label}" theme.`)
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.settings.title}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{t.settings.themeSubtitle}</p>
      </div>

      {/* Profile info — editable */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Info className="h-4 w-4 text-gray-400" />
          <h2 className="font-semibold text-gray-900">{t.settings.accountInfo}</h2>
          {!editingProfile ? (
            <button
              onClick={openProfileEdit}
              className="ml-auto p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-[var(--brand-primary)]"
              title="Edit profile"
            >
              <Pencil className="h-4 w-4" />
            </button>
          ) : (
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={saveProfile}
                disabled={savingProfile}
                className="p-1.5 rounded-lg hover:bg-green-50 transition-colors text-green-600"
                title="Save"
              >
                {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
              <button
                onClick={cancelProfileEdit}
                className="p-1.5 rounded-lg hover:bg-red-50 transition-colors text-gray-400 hover:text-red-500"
                title="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          {/* Name — editable */}
          <div>
            <p className="text-gray-500 text-xs mb-1">{t.settings.name}</p>
            {editingProfile ? (
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="h-8 text-sm"
                autoFocus
              />
            ) : (
              <p className="font-medium text-gray-900">{profile?.full_name}</p>
            )}
          </div>

          {/* Role — read only */}
          <div>
            <p className="text-gray-500 text-xs mb-1">{t.settings.role}</p>
            <p className="font-medium text-gray-900">{profile ? t.roles[profile.role] : ''}</p>
          </div>

          {/* Department — read only */}
          <div>
            <p className="text-gray-500 text-xs mb-1">{t.settings.dept}</p>
            <p className="font-medium text-gray-900">{profile ? DEPARTMENT_LABELS[profile.department] : ''}</p>
          </div>

          {/* Username — editable for staff */}
          {(profile?.username || profile?.role === 'staff') && (
            <div>
              <p className="text-gray-500 text-xs mb-1">{t.users.username}</p>
              {editingProfile && profile?.role === 'staff' ? (
                <Input
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  className="h-8 text-sm"
                  placeholder="username"
                />
              ) : (
                <p className="font-medium text-gray-900">@{profile?.username}</p>
              )}
            </div>
          )}

          {/* Email — read only */}
          {profile?.email && (
            <div>
              <p className="text-gray-500 text-xs mb-1">Email</p>
              <p className="font-medium text-gray-900 truncate">{profile.email}</p>
            </div>
          )}
        </div>
      </div>

      {/* Change password */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Lock className="h-4 w-4 text-gray-400" />
          <h2 className="font-semibold text-gray-900">{t.settings.changePassword}</h2>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t.settings.newPassword}</Label>
            <div className="relative">
              <Input
                type={showNew ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min. 8 characters"
                className="pr-10"
              />
              <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t.settings.confirmPassword}</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat your new password"
            />
          </div>
          <Button onClick={handleChangePassword} disabled={changingPassword}>
            {changingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : t.settings.updatePassword}
          </Button>
        </div>
      </div>

      {/* Theme settings */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Palette className="h-4 w-4 text-gray-400" />
          <h2 className="font-semibold text-gray-900">{t.settings.theme}</h2>
          {profile?.role !== 'super_admin' && (
            <span className="text-xs text-gray-400 ml-auto">{t.settings.adminOnly}</span>
          )}
        </div>

        {/* Presets */}
        <div className="mb-5">
          <p className="text-xs text-gray-500 mb-2 font-medium">{t.settings.presets}</p>
          <div className="grid grid-cols-3 gap-2">
            {PRESET_COLORS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => profile?.role === 'super_admin' && applyPreset(preset)}
                disabled={profile?.role !== 'super_admin'}
                className="flex items-center gap-2 p-2 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors text-left disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <div className="flex gap-1">
                  <div className="w-4 h-4 rounded-sm" style={{ background: preset.primary }} />
                  <div className="w-4 h-4 rounded-sm" style={{ background: preset.accent }} />
                  <div className="w-4 h-4 rounded-sm" style={{ background: preset.sidebar }} />
                </div>
                <span className="text-xs text-gray-700">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Custom colors */}
        <div className="space-y-4">
          <p className="text-xs text-gray-500 font-medium">Custom Colors</p>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">{t.settings.primaryColor}</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customPrimary}
                  onChange={(e) => setCustomPrimary(e.target.value)}
                  disabled={profile?.role !== 'super_admin'}
                  className="h-10 w-10 rounded-lg border border-gray-300 cursor-pointer disabled:cursor-not-allowed"
                />
                <Input
                  value={customPrimary}
                  onChange={(e) => setCustomPrimary(e.target.value)}
                  disabled={profile?.role !== 'super_admin'}
                  className="text-xs font-mono"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t.settings.accentColor}</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customAccent}
                  onChange={(e) => setCustomAccent(e.target.value)}
                  disabled={profile?.role !== 'super_admin'}
                  className="h-10 w-10 rounded-lg border border-gray-300 cursor-pointer disabled:cursor-not-allowed"
                />
                <Input
                  value={customAccent}
                  onChange={(e) => setCustomAccent(e.target.value)}
                  disabled={profile?.role !== 'super_admin'}
                  className="text-xs font-mono"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t.settings.sidebarColor}</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customSidebar}
                  onChange={(e) => setCustomSidebar(e.target.value)}
                  disabled={profile?.role !== 'super_admin'}
                  className="h-10 w-10 rounded-lg border border-gray-300 cursor-pointer disabled:cursor-not-allowed"
                />
                <Input
                  value={customSidebar}
                  onChange={(e) => setCustomSidebar(e.target.value)}
                  disabled={profile?.role !== 'super_admin'}
                  className="text-xs font-mono"
                />
              </div>
            </div>
          </div>
          {profile?.role === 'super_admin' && (
            <Button onClick={handleSaveTheme} disabled={savingTheme} variant="outline">
              {savingTheme ? <Loader2 className="h-4 w-4 animate-spin" /> : t.settings.applyTheme}
            </Button>
          )}
        </div>
      </div>
      {/* Legal / IP Notice */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Scale className="h-4 w-4 text-gray-400" />
          <h2 className="font-semibold text-gray-900">Intellectual Property &amp; Right of Use</h2>
        </div>
        <div className="text-xs text-gray-500 space-y-3 leading-relaxed">
          <p>
            All intellectual property rights relating to this application, including but not limited to its software,
            source code, system design, user interface, workflow logic, database structure, documentation, name, logo,
            and related materials, shall remain the exclusive property of{' '}
            <span className="font-semibold text-gray-700">Dr. Poti Chaopaisarn</span>, operating under the business
            name <span className="font-semibold text-gray-700">NNR Solutions</span>.
          </p>
          <p>
            Authorised users are granted a limited, non-exclusive, non-transferable, and revocable right to access
            and use the application solely for maintenance job assignment, monitoring, reporting, and related
            operational purposes. This right of use does not transfer any ownership rights in the application to any
            user, organisation, contractor, technician, or third party.
          </p>
          <p>
            Users shall not copy, modify, reproduce, distribute, sell, sublicense, reverse-engineer, decompile, or
            create derivative works from the application, in whole or in part, without prior written permission from{' '}
            <span className="font-semibold text-gray-700">Dr. Poti Chaopaisarn / NNR Solutions</span>.
          </p>
          <p className="pt-2 border-t border-gray-100 text-gray-400">
            © {new Date().getFullYear()} Dr. Poti Chaopaisarn / NNR Solutions · Kaizen System by NNR Ver. 1.0
          </p>
        </div>
      </div>

    </div>
  )
}
