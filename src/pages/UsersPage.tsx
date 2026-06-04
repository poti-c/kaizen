import { useEffect, useState } from 'react'
import { Plus, Trash2, Shield, Users, Loader2, Eye, EyeOff, Pencil, PowerOff, Power } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { DepartmentBadge } from '@/components/StatusBadge'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { getInitials, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { DEPARTMENTS } from '@/types'
import type { KaizenProfile, Role, Department } from '@/types'
import { toast } from 'sonner'
import { Navigate, Link } from 'react-router-dom'

export function UsersPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()
  const [users, setUsers] = useState<KaizenProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  // Create form state
  const [newFullName, setNewFullName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [newRole, setNewRole] = useState<Role>('staff')
  const [newDepartment, setNewDepartment] = useState<Department>('front_office')

  // Edit modal state
  const [showEdit, setShowEdit] = useState(false)
  const [editUser, setEditUser] = useState<KaizenProfile | null>(null)
  const [editFullName, setEditFullName] = useState('')
  const [editDepartment, setEditDepartment] = useState<Department>('front_office')
  const [editRole, setEditRole] = useState<Role>('staff')
  const [editNewPassword, setEditNewPassword] = useState('')
  const [showEditPassword, setShowEditPassword] = useState(false)
  const [saving, setSaving] = useState(false)

  // Only admins and managers can access this page
  if (profile && profile.role === 'staff') {
    return <Navigate to="/dashboard" replace />
  }

  useEffect(() => {
    fetchUsers()
  }, [profile, activeCompany])

  async function fetchUsers() {
    setLoading(true)
    let query = supabase.from('kaizen_profiles').select('*').order('role').order('department').order('full_name')

    if (activeCompany) query = query.eq('company_id', activeCompany.id)
    const isHRMgr = profile?.role === 'manager' && profile?.department === 'human_resource'
    if (profile?.role === 'manager' && !isHRMgr) {
      // Regular manager: only their own dept staff
      query = query.eq('department', profile.department).eq('role', 'staff')
    } else if (isHRMgr) {
      // HR Manager: all staff + managers, never super_admin
      query = query.neq('role', 'super_admin')
    }

    const { data } = await query
    setUsers((data || []) as KaizenProfile[])
    setLoading(false)
  }

  function resetForm() {
    setNewFullName(''); setNewEmail(''); setNewUsername(''); setNewPassword('')
    setNewRole('staff')
    setNewDepartment(profile?.role === 'manager' ? profile.department : 'front_office')
    setShowPassword(false)
  }

  function openEdit(user: KaizenProfile) {
    setEditUser(user)
    setEditFullName(user.full_name)
    setEditDepartment(user.department)
    setEditRole(user.role)
    setEditNewPassword('')
    setShowEditPassword(false)
    setShowEdit(true)
  }

  async function handleCreate() {
    if (!newFullName.trim() || !newPassword.trim()) {
      toast.error(t.users.fillRequired)
      return
    }
    if (newRole === 'staff' && !newUsername.trim()) {
      toast.error(t.users.usernameRequired)
      return
    }
    if ((newRole === 'manager' || newRole === 'super_admin') && !newEmail.trim()) {
      toast.error(t.users.emailRequired)
      return
    }
    if (newPassword.length < 6) {
      toast.error(t.users.minPwd)
      return
    }

    setCreating(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kaizen-manage-users`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({
            action: 'create',
            role: profile?.role === 'manager' ? 'staff' : newRole,
            full_name: newFullName.trim(),
            username: newUsername.trim() || undefined,
            email: newEmail.trim() || undefined,
            department: profile?.role === 'manager' ? profile.department : newRole === 'super_admin' ? 'top_management' : newDepartment,
            password: newPassword,
            company_id: activeCompany?.id ?? null,
          }),
        }
      )
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Failed to create user')

      toast.success(t.users.created)
      setShowCreate(false)
      resetForm()
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.users.failedCreate)
    } finally {
      setCreating(false)
    }
  }

  async function handleSaveEdit() {
    if (!editUser || !editFullName.trim()) { toast.error(t.users.fillRequired); return }
    setSaving(true)
    try {
      await supabase.from('kaizen_profiles').update({ full_name: editFullName.trim(), department: editDepartment, role: editRole }).eq('id', editUser.id)
      if (editNewPassword.trim().length >= 6) {
        const { data: { session } } = await supabase.auth.getSession()
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kaizen-manage-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'reset_password', userId: editUser.id, password: editNewPassword }),
        })
      }
      toast.success(t.users.created)
      setShowEdit(false)
      fetchUsers()
    } catch { toast.error(t.users.failedCreate) }
    finally { setSaving(false) }
  }

  async function handleDeactivate(userId: string, isActive: boolean) {
    if (!confirm(t.users.confirmDeactivate(isActive))) return
    setDeleting(userId)
    try {
      await supabase.from('kaizen_profiles').update({ is_active: !isActive }).eq('id', userId)
      toast.success(isActive ? t.users.deactivated : t.users.reactivated)
      fetchUsers()
    } catch {
      toast.error(t.users.failedStatus)
    } finally {
      setDeleting(null)
    }
  }

  async function handleDelete(userId: string, userName: string) {
    if (!confirm(t.users.confirmDelete(userName))) return
    setDeleting(userId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kaizen-manage-users`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ action: 'delete', userId }),
        }
      )
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Failed to delete user')
      toast.success(t.users.deleted)
      fetchUsers()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.users.failedDelete)
    } finally {
      setDeleting(null)
    }
  }

  const [deptFilter, setDeptFilter] = useState<Department | 'all'>('all')
  const [staffDeptFilter, setStaffDeptFilter] = useState<Department | 'all'>('all')


  // Departments that actually have users (for the filter pills)
  const activeDepts = DEPARTMENTS.filter(d => users.some(u => u.department === d.value))

  // Managing Director account is hidden from everyone except themselves
  const MD_EMAIL = 'poti@nanirand.com'
  const visibleUsers = (deptFilter === 'all' ? users : users.filter(u => u.department === deptFilter))
    .filter(u => u.email !== MD_EMAIL || profile?.email === MD_EMAIL)

  const staffDepts = DEPARTMENTS.filter(d => users.some(u => u.role === 'staff' && u.department === d.value))

  const roleGroups = {
    super_admin: visibleUsers.filter((u) => u.role === 'super_admin'),
    manager: visibleUsers.filter((u) => u.role === 'manager'),
    staff: visibleUsers
      .filter((u) => u.role === 'staff')
      .filter((u) => staffDeptFilter === 'all' || u.department === staffDeptFilter),
  }

  const roleIcons = { super_admin: Shield, manager: Shield, staff: Users }
  const roleLabels = { super_admin: t.users.superAdmins, manager: t.users.managers, staff: t.users.staff }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.users.title}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{visibleUsers.length} {t.users.accounts}</p>
        </div>
        {(profile?.role === 'super_admin' || profile?.role === 'manager') && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            {t.users.addUser}
          </Button>
        )}
      </div>

      {/* Department filter dropdown */}
      {!loading && profile?.role === 'super_admin' && (
        <div className="mb-5">
          <Select value={deptFilter} onValueChange={(v) => setDeptFilter(v as Department | 'all')}>
            <SelectTrigger className="h-9 w-full text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t.calendar.allDepts} ({users.length})</SelectItem>
              {activeDepts.map(d => {
                const count = users.filter(u => u.department === d.value).length
                return (
                  <SelectItem key={d.value} value={d.value}>{d.label} ({count})</SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-6">
          {(profile?.role === 'super_admin'
            ? ['super_admin', 'manager', 'staff'] as Role[]
            : profile?.role === 'manager' && profile?.department === 'human_resource'
              ? ['manager', 'staff'] as Role[]
              : ['staff'] as Role[]
          ).map((role) => {
            const group = roleGroups[role]
            if (group.length === 0) return null
            const Icon = roleIcons[role]

            return (
              <div key={role} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 bg-gray-50">
                  <Icon className="h-4 w-4 text-gray-500" />
                  <h2 className="font-semibold text-gray-700 text-sm">{roleLabels[role]}</h2>
                  {/* Staff-only department filter */}
                  {role === 'staff' && staffDepts.length > 1 && (
                    <div className="ml-auto mr-2">
                      <Select value={staffDeptFilter} onValueChange={(v) => setStaffDeptFilter(v as Department | 'all')}>
                        <SelectTrigger className="h-7 text-xs border-gray-200 bg-white px-2 w-auto min-w-[110px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Depts ({users.filter(u => u.role === 'staff').length})</SelectItem>
                          {staffDepts.map(d => {
                            const count = users.filter(u => u.role === 'staff' && u.department === d.value).length
                            return <SelectItem key={d.value} value={d.value}>{d.label} ({count})</SelectItem>
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <span className={`text-xs text-gray-400 ${role === 'staff' && staffDepts.length > 1 ? '' : 'ml-auto'}`}>{group.length}</span>
                </div>
                {group.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-gray-400">{t.users.noYet(roleLabels[role])}</p>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {group.map((user) => {
                      // Determine if the viewer can tap to open this user's profile
                      const isHRManager = profile?.role === 'manager' && profile?.department === 'human_resource'
                      const canViewProfile =
                        // Super admin: can view manager + staff (not other super admins)
                        (profile?.role === 'super_admin' && user.role !== 'super_admin') ||
                        // HR manager: can view all managers + staff
                        (isHRManager && (user.role === 'manager' || user.role === 'staff')) ||
                        // Other managers: own profile, or staff in same department
                        (profile?.role === 'manager' && !isHRManager && (
                          user.id === profile.id ||
                          (user.role === 'staff' && user.department === profile.department)
                        ))

                      const nameContent = (
                        <div className={cn('flex-1 min-w-0', canViewProfile && 'cursor-pointer')}>
                          <div className="flex items-center gap-2">
                            <p className={cn('text-sm font-medium truncate', canViewProfile ? 'text-[var(--brand-primary)]' : 'text-gray-900')}>
                              {user.full_name}
                            </p>
                            {!user.is_active && <span className="text-xs text-red-500 font-medium">{t.users.inactive}</span>}
                          </div>
                          <div className="mt-0.5 space-y-0.5">
                            <div className="flex items-center gap-2">
                              {user.username && <span className="text-xs text-gray-400">@{user.username}</span>}
                              {user.email && <span className="text-xs text-gray-400">{user.email}</span>}
                            </div>
                            <DepartmentBadge department={user.department} />
                          </div>
                        </div>
                      )

                      return (
                      <div key={user.id} className={cn('flex items-center gap-4 px-5 py-3.5', !user.is_active && 'bg-red-50/30')}>
                        {canViewProfile ? (
                          <Link to={`/performance/${user.id}`} className="flex items-center gap-4 flex-1 min-w-0">
                            <Avatar className="h-9 w-9 flex-shrink-0">
                              {user.avatar_url && <AvatarImage src={user.avatar_url} alt={user.full_name} className="object-cover" />}
                              <AvatarFallback className="text-xs">{getInitials(user.full_name)}</AvatarFallback>
                            </Avatar>
                            {nameContent}
                          </Link>
                        ) : (
                          <>
                            <Avatar className="h-9 w-9 flex-shrink-0">
                              {user.avatar_url && <AvatarImage src={user.avatar_url} alt={user.full_name} className="object-cover" />}
                              <AvatarFallback className="text-xs">{getInitials(user.full_name)}</AvatarFallback>
                            </Avatar>
                            {nameContent}
                          </>
                        )}
                        <div className="hidden sm:block text-xs text-gray-400 flex-shrink-0">{formatDate(user.created_at)}</div>
                        {profile?.role === 'super_admin' && user.email !== 'poti@nanirand.com' && user.id !== profile.id && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => openEdit(user)}
                              title="Edit user"
                              className="text-gray-400 hover:text-blue-600"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleDeactivate(user.id, user.is_active)}
                              disabled={deleting === user.id}
                              title={user.is_active ? 'Deactivate' : 'Reactivate'}
                              className="text-gray-400 hover:text-gray-700"
                            >
                              {deleting === user.id ? <Loader2 className="h-4 w-4 animate-spin" /> : user.is_active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4 text-green-600" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleDelete(user.id, user.full_name)}
                              disabled={deleting === user.id}
                              className="text-gray-400 hover:text-red-600"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Create user dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => { setShowCreate(open); if (!open) resetForm() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.users.createTitle}</DialogTitle>
            <DialogDescription>
              {profile?.role === 'manager'
                ? (lang === 'th' ? 'เพิ่มพนักงานใหม่ในแผนกของคุณ' : 'Add a new staff account to your department.')
                : t.users.createSubtitle}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Role selector — super_admin only; managers always create staff */}
            {profile?.role === 'super_admin' && (
              <div className="grid grid-cols-3 gap-2">
                {(['staff', 'manager', 'super_admin'] as Role[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setNewRole(r)}
                    className={`py-2 px-3 rounded-lg text-xs font-medium border transition-all ${
                      newRole === r ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white' : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {r === 'super_admin' ? t.login.superAdmin : r === 'manager' ? t.users.managers.replace(/s$/, '') : t.users.staff}
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{t.users.fullName} *</Label>
              <Input value={newFullName} onChange={(e) => setNewFullName(e.target.value)} placeholder={t.users.fullNamePlaceholder} />
            </div>

            {(profile?.role === 'manager' || newRole === 'staff') ? (
              <div className="space-y-1.5">
                <Label>{t.users.username} *</Label>
                <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="e.g. somchai.k" />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>{t.users.emailAddress} *</Label>
                <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder={t.users.emailPlaceholder} />
              </div>
            )}

            {newRole !== 'super_admin' && (
            <div className="space-y-1.5">
              <Label>{t.users.dept} *</Label>
              {profile?.role === 'manager' ? (
                <Input value={DEPARTMENTS.find(d => d.value === profile.department)?.label || profile.department} disabled className="bg-gray-50 text-gray-500" />
              ) : (
                <Select value={newDepartment} onValueChange={(v) => setNewDepartment(v as Department)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.filter(d => d.value !== 'top_management').map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
            )}

            <div className="space-y-1.5">
              <Label>{t.users.password} *</Label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t.users.minPassword}
                  className="pr-10"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); resetForm() }}>{t.users.cancel}</Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : t.users.createAccount}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit user dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.users.editTitle}</DialogTitle>
            <DialogDescription>{t.users.editSubtitle}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t.users.fullName} *</Label>
              <Input value={editFullName} onChange={(e) => setEditFullName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t.users.dept}</Label>
              <Select value={editDepartment} onValueChange={(v) => setEditDepartment(v as Department)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{DEPARTMENTS.filter(d => d.value !== 'top_management').map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t.users.roleLabel}</Label>
              <Select value={editRole} onValueChange={(v) => setEditRole(v as Role)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff">{t.login.staff}</SelectItem>
                  <SelectItem value="manager">{t.login.manager}</SelectItem>
                  <SelectItem value="super_admin">{t.login.superAdmin}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 border-t pt-4">
              <Label>{t.users.resetPassword} <span className="text-gray-400 text-xs font-normal">{t.users.keepCurrent}</span></Label>
              <div className="relative">
                <Input type={showEditPassword ? 'text' : 'password'} value={editNewPassword} onChange={(e) => setEditNewPassword(e.target.value)} placeholder={t.users.minPassword} className="pr-10" />
                <button type="button" onClick={() => setShowEditPassword(!showEditPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                  {showEditPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEdit(false)}>{t.users.cancel}</Button>
            <Button onClick={handleSaveEdit} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t.users.saveChanges}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
