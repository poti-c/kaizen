import { useEffect, useState } from 'react'
import { Plus, Trash2, Shield, Users, Loader2, Eye, EyeOff, Pencil, PowerOff, Power, KeyRound, History } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { createClient } from '@supabase/supabase-js'
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
import { getInitials, formatDate, activityLabel } from '@/lib/utils'
import { usePresence } from '@/contexts/PresenceContext'
import { cn } from '@/lib/utils'
import { DEPARTMENTS } from '@/types'
import type { KaizenProfile, Role, Department } from '@/types'
import { toast } from 'sonner'
import { Navigate, Link } from 'react-router-dom'

export function UsersPage() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { isOnline } = usePresence()
  const { t, lang } = useLanguage()
  const [users, setUsers] = useState<KaizenProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [actioning, setActioning] = useState<string | null>(null)

  // Create form
  const [newFullName, setNewFullName] = useState('')
  const [newPosition, setNewPosition] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [newRole, setNewRole] = useState<Role>('staff')
  const [newDepartment, setNewDepartment] = useState<Department>('front_office')

  // Edit modal
  const [showEdit, setShowEdit] = useState(false)
  const [editUser, setEditUser] = useState<KaizenProfile | null>(null)
  const [editFullName, setEditFullName] = useState('')
  const [editPosition, setEditPosition] = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [editDepartment, setEditDepartment] = useState<Department>('front_office')
  const [editRole, setEditRole] = useState<Role>('staff')
  const [editNewPassword, setEditNewPassword] = useState('')
  const [showEditPassword, setShowEditPassword] = useState(false)
  const [saving, setSaving] = useState(false)

  // Suspend dialog
  const [suspendUser, setSuspendUser] = useState<KaizenProfile | null>(null)

  // Delete dialog
  const [deleteUser, setDeleteUser] = useState<KaizenProfile | null>(null)
  const [deletePw, setDeletePw] = useState('')
  const [deleteErr, setDeleteErr] = useState('')
  const [showDeletePw, setShowDeletePw] = useState(false)

  // Activity log
  const [showLog, setShowLog] = useState(false)
  const [activityLog, setActivityLog] = useState<Array<{
    id: string; action: string; details: string | null
    target_user_name: string | null; created_at: string
    performer: { full_name: string } | null
  }>>([])
  const [loadingLog, setLoadingLog] = useState(false)

  const [deptFilter, setDeptFilter] = useState<Department | 'all'>('all')
  const [staffDeptFilter, setStaffDeptFilter] = useState<Department | 'all'>('all')

  const isHRManager = profile?.role === 'manager' && profile?.department === 'human_resource'
  const isOwner = profile?.role === 'super_admin' && profile?.job_title === 'Owner'

  const isStaffViewer = profile?.role === 'staff'

  useEffect(() => { if (!isStaffViewer) fetchUsers() }, [profile, activeCompany, isStaffViewer])

  // Staff have no access (returned after hooks so hook order stays stable)
  if (isStaffViewer) return <Navigate to="/dashboard" replace />

  async function fetchUsers() {
    setLoading(true)
    let query = supabase.from('kaizen_profiles').select('*').order('role').order('department').order('full_name')
    if (activeCompany) query = query.eq('company_id', activeCompany.id)
    if (profile?.role === 'manager' && !isHRManager) {
      query = query.eq('department', profile.department).eq('role', 'staff')
    } else if (isHRManager) {
      query = query.neq('role', 'super_admin')
    }
    const { data } = await query
    setUsers((data || []) as KaizenProfile[])
    setLoading(false)
  }

  async function logActivity(targetUser: KaizenProfile, action: string, details?: string) {
    await supabase.from('kaizen_user_activity_log').insert({
      company_id: activeCompany?.id,
      performed_by: profile?.id,
      target_user_id: targetUser.id,
      target_user_name: targetUser.full_name,
      action,
      details: details || null,
    })
  }

  // Call the kaizen-manage-users edge function (service role; bypasses RLS with server-side checks)
  async function callManageUsers(payload: Record<string, unknown>) {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kaizen-manage-users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify(payload),
    })
    const result = await res.json()
    if (!res.ok) throw new Error(result.error || 'Request failed')
    return result
  }

  async function fetchLog() {
    setLoadingLog(true)
    const { data } = await supabase
      .from('kaizen_user_activity_log')
      .select('*, performer:kaizen_profiles!kaizen_user_activity_log_performed_by_fkey(full_name)')
      .eq('company_id', activeCompany?.id ?? '')
      .order('created_at', { ascending: false })
      .limit(100)
    setActivityLog((data || []) as typeof activityLog)
    setLoadingLog(false)
  }

  function resetForm() {
    setNewFullName(''); setNewPosition(''); setNewEmail(''); setNewUsername(''); setNewPassword('')
    setNewRole('staff')
    setNewDepartment(profile?.role === 'manager' ? profile.department : 'front_office')
    setShowPassword(false)
  }

  function openEdit(user: KaizenProfile) {
    setEditUser(user)
    setEditFullName(user.full_name)
    setEditPosition(user.position || '')
    setEditUsername(user.username || '')
    setEditDepartment(user.department)
    setEditRole(user.role)
    setEditNewPassword('')
    setShowEditPassword(false)
    setShowEdit(true)
  }

  async function handleCreate() {
    if (!newFullName.trim() || !newPassword.trim()) { toast.error(t.users.fillRequired); return }
    if (newRole === 'staff' && !newUsername.trim()) { toast.error(t.users.usernameRequired); return }
    if ((newRole === 'manager' || newRole === 'super_admin') && !newEmail.trim()) { toast.error(t.users.emailRequired); return }
    if (newPassword.length < 6) { toast.error(t.users.minPwd); return }
    setCreating(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kaizen-manage-users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          action: 'create',
          role: profile?.role === 'manager' ? 'staff' : newRole,
          full_name: newFullName.trim(),
          position: newPosition.trim() || undefined,
          username: newUsername.trim() || undefined,
          email: newEmail.trim() || undefined,
          department: profile?.role === 'manager' ? profile.department : newRole === 'super_admin' ? 'top_management' : newDepartment,
          password: newPassword,
          company_id: activeCompany?.id ?? null,
        }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Failed to create user')
      toast.success(t.users.created)
      setShowCreate(false); resetForm(); fetchUsers()
    } catch (err) { toast.error(err instanceof Error ? err.message : t.users.failedCreate) }
    finally { setCreating(false) }
  }

  async function handleSaveEdit() {
    if (!editUser || !editFullName.trim()) { toast.error(t.users.fillRequired); return }
    setSaving(true)
    try {
      const updates: Record<string, unknown> = {
        full_name: editFullName.trim(),
        position: editPosition.trim() || null,
        username: editUsername.trim() || null,
      }
      // Only super admins can change role/department (the edge function also re-validates this)
      if (profile?.role === 'super_admin') {
        updates.department = editDepartment
        updates.role = editRole
      }

      if (editNewPassword.trim().length >= 6) {
        updates.must_change_password = true
        await callManageUsers({ action: 'reset_password', userId: editUser.id, password: editNewPassword })
      }

      await callManageUsers({ action: 'update_profile', userId: editUser.id, updates })

      const changes: string[] = []
      if (editFullName.trim() !== editUser.full_name) changes.push(`Name → ${editFullName.trim()}`)
      if (editPosition.trim() !== (editUser.position || '')) changes.push(`Position → ${editPosition.trim() || '(cleared)'}`)
      if (editUsername.trim() !== (editUser.username || '')) changes.push(`Username → @${editUsername.trim()}`)
      if (editNewPassword.trim().length >= 6) changes.push('Password reset (must change on login)')

      await logActivity(editUser, 'edit_profile', changes.join(', ') || 'No changes')

      toast.success('User updated.')
      setShowEdit(false); fetchUsers()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Failed to save changes.'
      toast.error(msg)
      console.error('Edit user error:', err)
    }
    finally { setSaving(false) }
  }

  async function handleSuspend() {
    if (!suspendUser) return
    setActioning(suspendUser.id)
    const newState = !suspendUser.is_active
    try {
      await callManageUsers({ action: 'set_active', userId: suspendUser.id, is_active: newState })
      await logActivity(suspendUser, newState ? 'reactivated' : 'suspended')
      toast.success(newState ? t.users.reactivated : t.users.deactivated)
      setSuspendUser(null); fetchUsers()
    } catch (err) { toast.error(err instanceof Error ? err.message : t.users.failedStatus) }
    finally { setActioning(null) }
  }

  async function handleDelete() {
    if (!deleteUser || !deletePw) { setDeleteErr('Enter your password to confirm.'); return }
    setActioning(deleteUser.id)
    setDeleteErr('')
    try {
      // Verify the actor's own password on a THROWAWAY client so the active
      // app session/tokens are never disturbed by this confirmation check.
      const verifyClient = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
      )
      const { error: authErr } = await verifyClient.auth.signInWithPassword({
        email: profile?.email ?? '',
        password: deletePw,
      })
      if (authErr) { setDeleteErr('Incorrect password.'); setActioning(null); return }

      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kaizen-manage-users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'delete', userId: deleteUser.id }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Failed to delete')

      await logActivity(deleteUser, 'deleted', `Deleted by ${profile?.full_name}`)
      toast.success(t.users.deleted)
      setDeleteUser(null); setDeletePw(''); fetchUsers()
    } catch (err) { setDeleteErr(err instanceof Error ? err.message : 'Failed to delete user.') }
    finally { setActioning(null) }
  }

  const activeDepts = DEPARTMENTS.filter(d => users.some(u => u.department === d.value))
  const MD_EMAIL = 'poti@nanirand.com'
  const visibleUsers = (deptFilter === 'all' ? users : users.filter(u => u.department === deptFilter))
    .filter(u => u.email !== MD_EMAIL || profile?.email === MD_EMAIL)
  const staffDepts = DEPARTMENTS.filter(d => users.some(u => u.role === 'staff' && u.department === d.value))

  const roleGroups = {
    super_admin: visibleUsers.filter(u => u.role === 'super_admin'),
    manager: visibleUsers.filter(u => u.role === 'manager'),
    staff: visibleUsers.filter(u => u.role === 'staff').filter(u => staffDeptFilter === 'all' || u.department === staffDeptFilter),
  }
  const roleIcons = { super_admin: Shield, manager: Shield, staff: Users }
  const roleLabels = { super_admin: t.users.superAdmins, manager: t.users.managers, staff: t.users.staff }

  const ACTION_LABELS: Record<string, string> = {
    edit_profile: 'Edited profile',
    reset_password: 'Reset password',
    suspended: 'Suspended user',
    reactivated: 'Reactivated user',
    deleted: 'Deleted user',
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.users.title}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{visibleUsers.length} {t.users.accounts}</p>
        </div>
        <div className="flex items-center gap-2">
          {profile?.role === 'super_admin' && (
            <Button variant="outline" size="sm" onClick={() => { setShowLog(true); fetchLog() }}>
              <History className="h-4 w-4" />
              <span className="hidden sm:inline">Activity Log</span>
            </Button>
          )}
          {(profile?.role === 'super_admin' || profile?.role === 'manager') && (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />{profile?.role === 'manager' ? 'Add Staff' : t.users.addUser}
            </Button>
          )}
        </div>
      </div>

      {!loading && profile?.role === 'super_admin' && (
        <div className="mb-5">
          <Select value={deptFilter} onValueChange={(v) => setDeptFilter(v as Department | 'all')}>
            <SelectTrigger className="h-9 w-full text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t.calendar.allDepts} ({users.length})</SelectItem>
              {activeDepts.map(d => <SelectItem key={d.value} value={d.value}>{d.label} ({users.filter(u => u.department === d.value).length})</SelectItem>)}
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
            : isHRManager ? ['manager', 'staff'] as Role[]
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
                  {role === 'staff' && staffDepts.length > 1 && (
                    <div className="ml-auto mr-2">
                      <Select value={staffDeptFilter} onValueChange={(v) => setStaffDeptFilter(v as Department | 'all')}>
                        <SelectTrigger className="h-7 text-xs border-gray-200 bg-white px-2 w-auto min-w-[110px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Depts ({users.filter(u => u.role === 'staff').length})</SelectItem>
                          {staffDepts.map(d => <SelectItem key={d.value} value={d.value}>{d.label} ({users.filter(u => u.role === 'staff' && u.department === d.value).length})</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <span className={`text-xs text-gray-400 ${role === 'staff' && staffDepts.length > 1 ? '' : 'ml-auto'}`}>{group.length}</span>
                </div>
                <div className="divide-y divide-gray-50">
                  {group.map((user) => {
                    const canViewProfile =
                      (profile?.role === 'super_admin' && user.role !== 'super_admin') ||
                      (isHRManager && (user.role === 'manager' || user.role === 'staff')) ||
                      (profile?.role === 'manager' && !isHRManager && (user.id === profile.id || (user.role === 'staff' && user.department === profile.department)))

                    // Who can manage (edit/suspend) this user
                    const canManage =
                      user.email !== MD_EMAIL && user.id !== profile?.id &&
                      (
                        // Super admin manages managers + staff (not other super admins unless Owner)
                        (profile?.role === 'super_admin' && (user.role !== 'super_admin' || isOwner) && user.job_title !== 'Owner') ||
                        // Regular manager: staff in own dept
                        (profile?.role === 'manager' && !isHRManager && user.role === 'staff' && user.department === profile.department) ||
                        // HR manager: all staff + managers
                        (isHRManager && (user.role === 'staff' || user.role === 'manager'))
                      )

                    // HR Manager cannot delete
                    const canDelete = canManage && !isHRManager

                    return (
                      <div key={user.id} className={cn('flex items-center gap-4 px-5 py-3.5', !user.is_active && 'bg-red-50 opacity-90')}>
                        {canViewProfile ? (
                          <Link to={`/performance/${user.id}`} className="flex items-center gap-4 flex-1 min-w-0">
                            <Avatar className="h-9 w-9 flex-shrink-0">
                              {user.avatar_url && <AvatarImage src={user.avatar_url} alt={user.full_name} className="object-cover" />}
                              <AvatarFallback className="text-xs">{getInitials(user.full_name)}</AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0 cursor-pointer">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium truncate text-[var(--brand-primary)]">{user.full_name}</p>
                                {!user.is_active && <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-red-700 bg-red-100 border border-red-200 px-2 py-0.5 rounded-full"><PowerOff className="h-3 w-3" />Suspended</span>}
                                {user.must_change_password && <span className="text-xs text-amber-600 font-medium">· change pwd</span>}
                              </div>
                              {user.position && <p className="text-xs font-medium text-gray-600 mt-0.5">{user.position}</p>}
                              <div className="mt-0.5 flex items-center gap-2 flex-wrap">
                                {user.username && <span className="text-xs text-gray-400">@{user.username}</span>}
                                {user.email && <span className="text-xs text-gray-400">{user.email}</span>}
                                <DepartmentBadge department={user.department} />
                              </div>
                              <div className="mt-1 flex items-center gap-1.5">
                                <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', isOnline(user.id) ? 'bg-green-500' : 'bg-gray-300')} />
                                <span className={cn('text-[11px]', isOnline(user.id) ? 'text-green-600 font-medium' : 'text-gray-400')}>{activityLabel(user.last_active_at, isOnline(user.id))}</span>
                              </div>
                            </div>
                          </Link>
                        ) : (
                          <>
                            <Avatar className="h-9 w-9 flex-shrink-0">
                              {user.avatar_url && <AvatarImage src={user.avatar_url} alt={user.full_name} className="object-cover" />}
                              <AvatarFallback className="text-xs">{getInitials(user.full_name)}</AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium truncate text-gray-900">{user.full_name}</p>
                                {!user.is_active && <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-red-700 bg-red-100 border border-red-200 px-2 py-0.5 rounded-full"><PowerOff className="h-3 w-3" />Suspended</span>}
                              </div>
                              {user.position && <p className="text-xs font-medium text-gray-600 mt-0.5">{user.position}</p>}
                              <div className="mt-0.5 flex items-center gap-2 flex-wrap">
                                {user.username && <span className="text-xs text-gray-400">@{user.username}</span>}
                                <DepartmentBadge department={user.department} />
                              </div>
                              <div className="mt-1 flex items-center gap-1.5">
                                <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', isOnline(user.id) ? 'bg-green-500' : 'bg-gray-300')} />
                                <span className={cn('text-[11px]', isOnline(user.id) ? 'text-green-600 font-medium' : 'text-gray-400')}>{activityLabel(user.last_active_at, isOnline(user.id))}</span>
                              </div>
                            </div>
                          </>
                        )}
                        <div className="hidden sm:block text-xs text-gray-400 flex-shrink-0">{formatDate(user.created_at)}</div>
                        {canManage && (
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="icon-sm" onClick={() => openEdit(user)} title="Edit" className="text-gray-400 hover:text-blue-600">
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon-sm" onClick={() => setSuspendUser(user)} disabled={actioning === user.id} title={user.is_active ? 'Suspend' : 'Reactivate'} className="text-gray-400 hover:text-gray-700">
                              {actioning === user.id ? <Loader2 className="h-4 w-4 animate-spin" /> : user.is_active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4 text-green-600" />}
                            </Button>
                            {canDelete && (
                              <Button variant="ghost" size="icon-sm" onClick={() => { setDeleteUser(user); setDeletePw(''); setDeleteErr('') }} disabled={actioning === user.id} className="text-gray-400 hover:text-red-600">
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Create user dialog ── */}
      <Dialog open={showCreate} onOpenChange={(open) => { setShowCreate(open); if (!open) resetForm() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.users.createTitle}</DialogTitle>
            <DialogDescription>{profile?.role === 'manager' ? (lang === 'th' ? 'เพิ่มพนักงานใหม่ในแผนกของคุณ' : 'Add a new staff account to your department.') : t.users.createSubtitle}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {profile?.role === 'super_admin' && (
              <div className={`grid ${isOwner ? 'grid-cols-3' : 'grid-cols-2'} gap-2`}>
                {((isOwner ? ['staff', 'manager', 'super_admin'] : ['staff', 'manager']) as Role[]).map((r) => (
                  <button key={r} type="button" onClick={() => setNewRole(r)}
                    className={`py-2 px-3 rounded-lg text-xs font-medium border transition-all ${newRole === r ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                    {r === 'super_admin' ? t.login.superAdmin : r === 'manager' ? t.users.managers.replace(/s$/, '') : t.users.staff}
                  </button>
                ))}
              </div>
            )}
            <div className="space-y-1.5"><Label>{t.users.fullName} *</Label><Input value={newFullName} onChange={(e) => setNewFullName(e.target.value)} placeholder={t.users.fullNamePlaceholder} /></div>
            <div className="space-y-1.5"><Label>Position / Job Title</Label><Input value={newPosition} onChange={(e) => setNewPosition(e.target.value)} placeholder="e.g. Front Office Supervisor" /></div>
            {(profile?.role === 'manager' || newRole === 'staff') ? (
              <div className="space-y-1.5"><Label>{t.users.username} *</Label><Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="e.g. somchai.k" /></div>
            ) : (
              <div className="space-y-1.5"><Label>{t.users.emailAddress} *</Label><Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder={t.users.emailPlaceholder} /></div>
            )}
            {newRole !== 'super_admin' && (
              <div className="space-y-1.5">
                <Label>{t.users.dept} *</Label>
                {profile?.role === 'manager' ? (
                  <Input value={DEPARTMENTS.find(d => d.value === profile.department)?.label || profile.department} disabled className="bg-gray-50 text-gray-500" />
                ) : (
                  <Select value={newDepartment} onValueChange={(v) => setNewDepartment(v as Department)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{DEPARTMENTS.filter(d => d.value !== 'top_management').map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{t.users.password} *</Label>
              <div className="relative">
                <Input type={showPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={t.users.minPassword} className="pr-10" />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); resetForm() }}>{t.users.cancel}</Button>
            <Button onClick={handleCreate} disabled={creating}>{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : t.users.createAccount}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit user dialog ── */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.users.editTitle}</DialogTitle>
            <DialogDescription>{editUser?.full_name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5"><Label>Full Name *</Label><Input value={editFullName} onChange={(e) => setEditFullName(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label>Position</Label>
              <Input value={editPosition} onChange={(e) => setEditPosition(e.target.value)} placeholder="e.g. Front Office Supervisor" />
            </div>
            <div className="space-y-1.5">
              <Label>Username</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">@</span>
                <Input value={editUsername} onChange={(e) => setEditUsername(e.target.value)} placeholder="username" className="pl-7" />
              </div>
            </div>
            {profile?.role === 'super_admin' && (
              <>
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
                      {isOwner && <SelectItem value="super_admin">{t.login.superAdmin}</SelectItem>}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            <div className="space-y-1.5 border-t pt-4">
              <Label className="flex items-center gap-2"><KeyRound className="h-3.5 w-3.5 text-gray-400" /> Reset Password <span className="text-gray-400 text-xs font-normal">(staff will be prompted to change on next login)</span></Label>
              <div className="relative">
                <Input type={showEditPassword ? 'text' : 'password'} value={editNewPassword} onChange={(e) => setEditNewPassword(e.target.value)} placeholder="New password (min 6 chars)" className="pr-10" />
                <button type="button" onClick={() => setShowEditPassword(!showEditPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">{showEditPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEdit(false)}>{t.users.cancel}</Button>
            <Button onClick={handleSaveEdit} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t.users.saveChanges}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Suspend dialog ── */}
      <Dialog open={!!suspendUser} onOpenChange={(open) => { if (!open) setSuspendUser(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {suspendUser?.is_active ? <PowerOff className="h-5 w-5 text-orange-500" /> : <Power className="h-5 w-5 text-green-500" />}
              {suspendUser?.is_active ? 'Suspend User' : 'Reactivate User'}
            </DialogTitle>
            <DialogDescription>
              {suspendUser?.is_active
                ? `Suspending ${suspendUser?.full_name} will disable their login and stop all notifications to them.`
                : `Reactivating ${suspendUser?.full_name} will restore their access.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSuspendUser(null)}>Cancel</Button>
            <Button
              onClick={handleSuspend}
              disabled={!!actioning}
              className={suspendUser?.is_active ? 'bg-orange-600 hover:bg-orange-700 text-white' : 'bg-green-600 hover:bg-green-700 text-white'}
            >
              {actioning ? <Loader2 className="h-4 w-4 animate-spin" /> : suspendUser?.is_active ? 'Suspend' : 'Reactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete dialog ── */}
      <Dialog open={!!deleteUser} onOpenChange={(open) => { if (!open) { setDeleteUser(null); setDeletePw(''); setDeleteErr('') } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" /> Delete User
            </DialogTitle>
            <DialogDescription>
              Permanently delete <strong>{deleteUser?.full_name}</strong>? This cannot be undone. Enter your password to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <div className="relative">
              <Input
                type={showDeletePw ? 'text' : 'password'}
                value={deletePw}
                onChange={(e) => { setDeletePw(e.target.value); setDeleteErr('') }}
                placeholder="Your password"
                className={cn('pr-10', deleteErr && 'border-red-400')}
              />
              <button type="button" onClick={() => setShowDeletePw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">{showDeletePw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
            </div>
            {deleteErr && <p className="text-xs text-red-500">{deleteErr}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setDeleteUser(null); setDeletePw(''); setDeleteErr('') }}>Cancel</Button>
            <Button onClick={handleDelete} disabled={!!actioning || !deletePw} className="bg-red-600 hover:bg-red-700 text-white">
              {actioning ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete Permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Activity Log dialog (super_admin only) ── */}
      <Dialog open={showLog} onOpenChange={setShowLog}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><History className="h-5 w-5" /> User Management Activity Log</DialogTitle>
            <DialogDescription>All user management actions by managers and admins.</DialogDescription>
          </DialogHeader>
          {loadingLog ? (
            <div className="flex items-center justify-center py-10"><div className="w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" /></div>
          ) : activityLog.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No activity recorded yet.</p>
          ) : (
            <div className="overflow-y-auto divide-y divide-gray-50 flex-1">
              {activityLog.map(entry => (
                <div key={entry.id} className="flex items-start gap-3 px-1 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-800">{entry.performer?.full_name ?? '—'}</span>
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                      {entry.target_user_name && <span className="text-xs text-gray-500">→ {entry.target_user_name}</span>}
                    </div>
                    {entry.details && <p className="text-xs text-gray-400 mt-0.5">{entry.details}</p>}
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0">{new Date(entry.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
