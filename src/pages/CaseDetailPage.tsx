import React, { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Clock, CheckCircle2, XCircle, RefreshCw, Loader2,
  User, Calendar, Building2, AlertTriangle, MessageSquare, MessageCircle, Pencil, Printer,
  RotateCcw, X, ChevronDown, ChevronUp,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { StatusBadge, PriorityBadge, DepartmentBadge } from '@/components/StatusBadge'
import { PhotoUpload, PhotoGallery } from '@/components/PhotoUpload'
import { ResolutionCard } from '@/components/case/ResolutionCard'
import { CaseTimeline } from '@/components/case/CaseTimeline'
import { formatDateTime, formatDuration, LOCATIONS, CATEGORIES } from '@/lib/utils'
import { DEPARTMENTS, DEPARTMENT_LABELS, STATUS_LABELS } from '@/types'
import type { KaizenCase, KaizenProfile, KaizenCaseTimeline, KaizenCasePhoto, Department, CasePriority, CaseStatus } from '@/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { buildCasePrintHtml, CATEGORY_LABELS_EN } from '@/lib/casePrint'

export function CaseDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { t } = useLanguage()

  const [kcase, setKcase] = useState<KaizenCase | null>(null)
  const [timeline, setTimeline] = useState<KaizenCaseTimeline[]>([])
  const [photos, setPhotos] = useState<KaizenCasePhoto[]>([])
  const [assignments, setAssignments] = useState<Array<{ id: string; department: Department; assigned_staff: string | null; status: string; staff?: KaizenProfile }>>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // Staff resolution form
  const [resolutionNote, setResolutionNote] = useState('')
  const [resolutionPhotos, setResolutionPhotos] = useState<string[]>([])

  // Priority change (super_admin only)
  const [selectedPriority, setSelectedPriority] = useState<CasePriority | ''>('')

  // Comments + @mentions
  const [comments, setComments] = useState<Array<{id:string,content:string,created_at:string,user:KaizenProfile}>>([])
  const [newComment, setNewComment] = useState('')
  const [mentionUsers, setMentionUsers] = useState<KaizenProfile[]>([])
  const [showMentions, setShowMentions] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const commentRef = useRef<HTMLTextAreaElement>(null)

  // Add department (super_admin only)
  const [addDeptValue, setAddDeptValue] = useState<Department | ''>('')
  const [addingDept, setAddingDept] = useState(false)

  // Edit case (super_admin only)
  const [showApproveConfirm, setShowApproveConfirm] = useState(false)
  const [showAdminApproveConfirm, setShowAdminApproveConfirm] = useState(false)
  const [showEditCase, setShowEditCase] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editDepartment, setEditDepartment] = useState<Department | ''>('')
  const [editDueDate, setEditDueDate] = useState('')
  const [editStatus, setEditStatus] = useState<CaseStatus | ''>('')

  // Previous resolution (reopened cases)
  const [prevResolutionCollapsed, setPrevResolutionCollapsed] = useState(true)

  // Recurring issue detection
  const [recurringCases, setRecurringCases] = useState<KaizenCase[]>([])
  const [recurringOpen, setRecurringOpen] = useState(false)

  // Person in Charge (multi-select)
  const [picProfiles, setPicProfiles] = useState<KaizenProfile[]>([])
  const [showPicEditor, setShowPicEditor] = useState(false)
  const [picCandidates, setPicCandidates] = useState<KaizenProfile[]>([])
  const [selectedPics, setSelectedPics] = useState<string[]>([])
  const [notifyDepts, setNotifyDepts] = useState<string[]>([])
  const [savingPic, setSavingPic] = useState(false)

  // Due date (manager can set if missing)
  const [showDueDateEditor, setShowDueDateEditor] = useState(false)
  const [newDueDate, setNewDueDate] = useState('')
  const [savingDueDate, setSavingDueDate] = useState(false)

  // ── Incomplete info detection & fix ────────────────────────────────────────
  const [validDeptValues, setValidDeptValues] = useState<string[]>(DEPARTMENTS.map(d => d.value))
  const [validLocations, setValidLocations] = useState<string[]>([...LOCATIONS] as string[])
  const [validCategories, setValidCategories] = useState<string[]>([...CATEGORIES] as string[])
  const [customDeptLabels, setCustomDeptLabels] = useState<string[]>(DEPARTMENTS.filter(d=>d.value!=='top_management').map(d=>d.label))
  const [customLocList, setCustomLocList] = useState<string[]>([...LOCATIONS] as string[])
  const [customCatList, setCustomCatList] = useState<string[]>([...CATEGORIES] as string[])
  // Fix form state
  const [fixDept, setFixDept] = useState<string>('')
  const [fixLocation, setFixLocation] = useState<string>('')
  const [fixCategory, setFixCategory] = useState<string>('')
  const [savingFix, setSavingFix] = useState(false)

  useEffect(() => {
    supabase.from('kaizen_settings').select('key, value')
      .in('key', ['custom_departments', 'custom_locations', 'custom_categories'])
      .then(({ data }) => {
        if (!data) return
        data.forEach((row: { key: string; value: unknown }) => {
          if (!Array.isArray(row.value) || row.value.length === 0) return
          if (row.key === 'custom_departments') {
            setCustomDeptLabels(row.value as string[])
            const vals = (row.value as string[]).map(l => DEPARTMENTS.find(d => d.label === l)?.value).filter(Boolean) as string[]
            if (vals.length) setValidDeptValues(vals)
          }
          if (row.key === 'custom_locations') {
            setCustomLocList(row.value as string[])
            setValidLocations(row.value as string[])
          }
          if (row.key === 'custom_categories') {
            setCustomCatList(row.value as string[])
            const slugs = (row.value as string[]).map(c => c.toLowerCase().replace(/ /g, '_'))
            if (slugs.length) setValidCategories(slugs)
          }
        })
      })
  }, [])

  async function saveFixedInfo() {
    if (!kcase || !id) return
    setSavingFix(true)
    const updates: Record<string, string> = {}
    const changes: string[] = []

    if (fixDept && fixDept !== kcase.department) {
      updates.department = fixDept
      changes.push(`Department → ${DEPARTMENT_LABELS[fixDept as Department] ?? fixDept}`)
    }
    if (fixLocation && fixLocation !== kcase.location) {
      updates.location = fixLocation
      changes.push(`Location → ${fixLocation}`)
    }
    if (fixCategory && fixCategory !== kcase.category) {
      updates.category = fixCategory
      changes.push(`Category → ${fixCategory}`)
    }

    if (Object.keys(updates).length === 0) { setSavingFix(false); return }

    await supabase.from('kaizen_cases').update(updates).eq('id', id)
    await addTimeline('info_corrected', `Registration info updated: ${changes.join(', ')}`)
    toast.success('Case information updated.')
    setSavingFix(false)
    fetchCase()
  }
  // ───────────────────────────────────────────────────────────────────────────

  // ── Person in Charge ───────────────────────────────────────────────────────
  async function loadPicCandidates() {
    if (!kcase) return
    // Both manager and super_admin can pick from all departments
    const { data } = await supabase
      .from('kaizen_profiles').select('*')
      .eq('is_active', true)
      .eq('company_id', kcase.company_id)
      .in('role', ['staff', 'manager'])
      .order('department').order('role', { ascending: false }).order('full_name')
    setPicCandidates((data || []) as KaizenProfile[])
  }

  async function savePic() {
    if (!kcase || selectedPics.length === 0) return
    setSavingPic(true)
    try {
      // If case is open/reopened, move to assigned when PIC is set
      const statusUpdate = ['open', 'reopened'].includes(kcase.status) ? { status: 'assigned' } : {}
      await supabase.from('kaizen_cases').update({
        pic_ids: selectedPics,
        person_in_charge: selectedPics[0],
        updated_at: new Date().toISOString(),
        ...statusUpdate,
      }).eq('id', id!)

      // Create/update assignment record for the case's primary department
      if (['open', 'reopened'].includes(kcase.status)) {
        await supabase.from('kaizen_case_assignments').upsert({
          case_id: id!,
          department: kcase.department,
          assigned_by: profile?.id,
          status: 'pending',
        }, { onConflict: 'case_id,department' })
        await addTimeline('case_assigned', `Case assigned to ${DEPARTMENT_LABELS[kcase.department] ?? kcase.department}`)
      }

      const names = selectedPics.map(id => picCandidates.find(p => p.id === id)?.full_name || 'Unknown').join(', ')
      await addTimeline('pic_changed', `In Charge set to: ${names}`)

      // Notify selected PICs
      const notifRows = selectedPics.map(uid => ({
        user_id: uid,
        case_id: id!,
        title: 'Assigned as In Charge',
        message: `You have been assigned as In Charge for case ${kcase.case_number}: "${kcase.title}"`,
        notification_type: 'assignment',
      }))

      // Notify selected departments
      if (notifyDepts.length > 0) {
        const { data: deptMembers } = await supabase
          .from('kaizen_profiles').select('id, department')
          .eq('company_id', kcase.company_id)
          .in('department', notifyDepts)
          .eq('is_active', true)
          .not('id', 'in', `(${selectedPics.join(',')})`)
        if (deptMembers?.length) {
          deptMembers.forEach((m: { id: string; department: string }) => notifRows.push({
            user_id: m.id,
            case_id: id!,
            title: 'Department Case Update',
            message: `${names} assigned as In Charge for case ${kcase.case_number}: "${kcase.title}"`,
            notification_type: 'info',
          }))
        }
        const deptNames = notifyDepts.map(d => DEPARTMENT_LABELS[d as Department] ?? d).join(', ')
        await addTimeline('dept_notified', `Departments notified: ${deptNames}`)
      }

      if (notifRows.length) {
        await supabase.from('kaizen_notifications').insert(notifRows)
        toast.success(`Notified ${notifRows.length} ${notifRows.length === 1 ? 'person' : 'people'}`)
      }

      // Auto-add departments of selected PICs + notified depts to assigned_departments
      const picDepts = selectedPics
        .map(uid => picCandidates.find(p => p.id === uid)?.department)
        .filter((d): d is Department => !!d && d !== kcase.department)
      const allNewDepts = [...new Set([...picDepts, ...notifyDepts as Department[]])]
      const existingDepts = kcase.assigned_departments || []
      const toAdd = allNewDepts.filter(d => !existingDepts.includes(d))
      if (toAdd.length > 0) {
        const merged = [...existingDepts, ...toAdd]
        await supabase.from('kaizen_cases').update({ assigned_departments: merged }).eq('id', id!)
        await addTimeline('department_added', `Departments added: ${toAdd.map(d => DEPARTMENT_LABELS[d] ?? d).join(', ')}`)
      }

      setShowPicEditor(false)
      setNotifyDepts([])
      fetchCase()
    } finally { setSavingPic(false) }
  }

  // ── Due Date (manager can add if missing) ──────────────────────────────────
  async function saveManagerDueDate() {
    if (!kcase || !newDueDate) return
    setSavingDueDate(true)
    try {
      await supabase.from('kaizen_cases').update({ due_date: newDueDate, updated_at: new Date().toISOString() }).eq('id', id!)
      await addTimeline('due_date_set', `Due date set to ${new Date(newDueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`)
      setShowDueDateEditor(false)
      setNewDueDate('')
      fetchCase()
    } finally { setSavingDueDate(false) }
  }
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (id) fetchCase()
  }, [id])

  // Load all active users for @mentions
  useEffect(() => {
    supabase.from('kaizen_profiles').select('*').eq('is_active', true)
      .then(({ data }) => setMentionUsers((data || []) as KaizenProfile[]))
  }, [])

  async function fetchCase() {
    setLoading(true)
    const { data } = await supabase
      .from('kaizen_cases')
      .select('*, creator:kaizen_profiles!kaizen_cases_created_by_fkey(*)')
      .eq('id', id!)
      .single()

    if (data) {
      setKcase(data as KaizenCase)

      // Fetch recurring cases — same location + company, excluding this case
      if (data.location && data.company_id) {
        const { data: recurring } = await supabase
          .from('kaizen_cases')
          .select('id, case_number, title, status, priority, created_at, category')
          .eq('company_id', data.company_id)
          .eq('location', data.location)
          .neq('id', data.id)
          .order('created_at', { ascending: false })
          .limit(20)
        setRecurringCases((recurring || []) as KaizenCase[])
      } else {
        setRecurringCases([])
      }

      // Fetch PIC profiles (array)
      const ids: string[] = data.pic_ids?.length ? data.pic_ids : (data.person_in_charge ? [data.person_in_charge] : [data.created_by])
      if (ids.length) {
        const { data: pics } = await supabase.from('kaizen_profiles').select('*').in('id', ids)
        setPicProfiles((pics || []) as KaizenProfile[])
        setSelectedPics(ids)
      }
    }

    const [tl, ph, asn, cmts] = await Promise.all([
      supabase.from('kaizen_case_timeline').select('*, performer:kaizen_profiles!kaizen_case_timeline_performed_by_fkey(full_name, role)').eq('case_id', id!).order('created_at', { ascending: true }),
      supabase.from('kaizen_case_photos').select('*').eq('case_id', id!).order('created_at', { ascending: true }),
      supabase.from('kaizen_case_assignments').select('*, staff:kaizen_profiles!kaizen_case_assignments_assigned_staff_fkey(id, full_name)').eq('case_id', id!),
      supabase.from('kaizen_case_comments').select('*, user:kaizen_profiles!kaizen_case_comments_user_id_fkey(id,full_name,role)').eq('case_id', id!).order('created_at', { ascending: true }),
    ])

    setTimeline((tl.data || []) as KaizenCaseTimeline[])
    setPhotos((ph.data || []) as KaizenCasePhoto[])
    setAssignments(asn.data || [])
    setComments((cmts.data || []) as Array<{id:string,content:string,created_at:string,user:KaizenProfile}>)
    setLoading(false)
  }

  async function addTimeline(action: string, description: string) {
    await supabase.from('kaizen_case_timeline').insert({
      case_id: id!,
      action,
      description,
      performed_by: profile?.id,
    })
  }

  async function notifyUsers(userIds: string[], title: string, message: string) {
    if (userIds.length === 0) return
    await supabase.from('kaizen_notifications').insert(
      userIds.map((uid) => ({ user_id: uid, case_id: id!, title, message, notification_type: 'case_update' }))
    )
  }

  // Resolve a de-duplicated list of recipient ids from departments + roles,
  // plus any explicit extra ids, always excluding the current user.
  async function fetchRecipientIds(opts: {
    departments?: (string | null | undefined)[]
    roles?: string[]
    extraIds?: (string | null | undefined)[]
  }): Promise<string[]> {
    const ids = new Set<string>()
    const depts = (opts.departments || []).filter(Boolean) as string[]
    if (opts.roles && opts.roles.length > 0) {
      let query = supabase
        .from('kaizen_profiles')
        .select('id')
        .in('role', opts.roles)
        .eq('is_active', true)
      // Optional department scoping; omit to target a role across all departments.
      if (depts.length > 0) query = query.in('department', depts)
      const { data } = await query
      ;(data || []).forEach((u: { id: string }) => ids.add(u.id))
    }
    ;(opts.extraIds || []).forEach((uid) => { if (uid) ids.add(uid) })
    return Array.from(ids).filter((uid) => uid !== profile?.id)
  }

  // Convenience: resolve recipients then send a single notification batch.
  async function notifyByDeptRole(
    opts: { departments?: (string | null | undefined)[]; roles?: string[]; extraIds?: (string | null | undefined)[] },
    title: string,
    message: string,
  ) {
    const ids = await fetchRecipientIds(opts)
    await notifyUsers(ids, title, message)
  }

  // @mention handling in textarea
  function handleCommentChange(value: string) {
    setNewComment(value)
    const lastAt = value.lastIndexOf('@')
    if (lastAt !== -1 && lastAt > value.lastIndexOf(' ', lastAt - 1)) {
      const afterAt = value.slice(lastAt + 1)
      // Don't reopen if this @ is already a completed mention (name + space already inserted)
      const alreadyCompleted = mentionUsers.some(u =>
        afterAt.startsWith(u.full_name + ' ') || afterAt.startsWith(u.full_name + '\n')
      )
      if (alreadyCompleted) {
        setShowMentions(false)
        return
      }
      const query = afterAt.split(' ')[0]
      setMentionQuery(query)
      setShowMentions(true)
    } else {
      setShowMentions(false)
    }
  }

  function insertMention(user: KaizenProfile) {
    const lastAt = newComment.lastIndexOf('@')
    const before = newComment.slice(0, lastAt)
    const after = newComment.slice(lastAt).replace(/@\S*/, `@${user.full_name} `)
    setNewComment(before + after)
    setShowMentions(false)
    commentRef.current?.focus()
  }

  function renderCommentWithMentions(content: string) {
    // Build regex from known user names (longest first to avoid partial matches)
    const names = [...mentionUsers].sort((a, b) => b.full_name.length - a.full_name.length)
    if (names.length === 0) return <span>{content}</span>
    const pattern = names.map(u => `@${u.full_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).join('|')
    const splitRegex = new RegExp(`(${pattern})`, 'gi')  // for splitting
    const testRegex = new RegExp(`^(${pattern})$`, 'i')   // stateless, for testing each part
    const parts = content.split(splitRegex)
    return parts.map((part, i) =>
      testRegex.test(part) ? (
        <span key={i} className="text-blue-600 font-medium">{part}</span>
      ) : (
        <span key={i}>{part}</span>
      )
    )
  }

  const filteredMentionUsers = mentionUsers.filter(u =>
    u.full_name.toLowerCase().includes(mentionQuery.toLowerCase())
  )

  // Print / PDF
  function handlePrint() {
    const printWindow = window.open('', '_blank')
    if (!printWindow || !kcase) return
    printWindow.document.write(buildCasePrintHtml(kcase, photos, timeline))
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 500)
  }

  // Manager: assign departments + propose solution
  // Manager: assign staff to an assignment
  // Staff: resolve case
  async function handleResolve() {
    if (!resolutionNote.trim()) {
      toast.error('Please provide a resolution description.')
      return
    }
    if (resolutionPhotos.length === 0) {
      toast.error('Please upload at least one photo as proof of resolution.')
      return
    }
    setSubmitting(true)
    try {
      await supabase.from('kaizen_case_photos').insert(
        resolutionPhotos.map((url) => ({
          case_id: id!,
          photo_url: url,
          photo_type: 'resolution',
          uploaded_by: profile?.id,
        }))
      )

      await supabase.from('kaizen_cases').update({
        status: 'pending_manager_approval',
        resolved_by: profile?.id,
        resolution_note: resolutionNote.trim(),
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', id!)

      await addTimeline('resolved', `Staff resolved the case: ${resolutionNote}`)

      // Notify the manager of the CASE's department
      await notifyByDeptRole(
        { departments: [kcase?.department], roles: ['manager'] },
        'Case Ready for Approval',
        `${profile?.full_name} resolved case ${kcase?.case_number} — awaiting your approval.`,
      )

      toast.success('Case marked as resolved. Awaiting manager approval.')
      fetchCase()
    } catch {
      toast.error('Failed to submit resolution.')
    } finally {
      setSubmitting(false)
    }
  }

  // Manager: approve resolution
  async function handleManagerApprove() {
    setSubmitting(true)
    try {
      await supabase.from('kaizen_cases').update({
        status: 'pending_admin_approval',
        manager_approved_by: profile?.id,
        manager_approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', id!)

      await addTimeline('manager_approved', `Manager approved the resolution.`)

      await notifyByDeptRole(
        { roles: ['super_admin'] },
        'Case Awaiting Final Closure',
        `Case ${kcase?.case_number} has been approved by ${profile?.full_name} — ready for Top Management review and closure.`,
      )

      toast.success('Approved. Top Management has been notified for final closure.')
      fetchCase()
    } catch {
      toast.error('Failed to approve.')
    } finally {
      setSubmitting(false)
    }
  }

  // Admin: final approve → close
  async function handleAdminApprove() {
    setSubmitting(true)
    try {
      await supabase.from('kaizen_cases').update({
        status: 'closed',
        admin_approved_by: profile?.id,
        admin_approved_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', id!)

      await addTimeline('closed', `Case closed after final admin approval.`)

      // Notify reporter, resolver, and all In Charge members that the case is closed
      const picIds = kcase?.pic_ids || (kcase?.person_in_charge ? [kcase.person_in_charge] : [])
      await notifyByDeptRole(
        { extraIds: [kcase?.created_by, kcase?.resolved_by, ...picIds] },
        'Case Closed',
        `Case ${kcase?.case_number} has been reviewed and officially closed by Top Management.`,
      )

      toast.success('Case officially closed.')
      fetchCase()
    } catch {
      toast.error('Failed to close case.')
    } finally {
      setSubmitting(false)
    }
  }

  // Admin: reopen case
  async function handleReopen() {
    setSubmitting(true)
    try {
      await supabase.from('kaizen_cases').update({
        status: 'reopened',
        // Clear closure/approval state so the case counts as open again.
        // (resolution_note + resolution photos are kept intentionally so the
        // "Previous Resolution" card can still display the prior fix.)
        closed_at: null,
        resolved_at: null,
        manager_approved_at: null,
        manager_approved_by: null,
        admin_approved_at: null,
        admin_approved_by: null,
        updated_at: new Date().toISOString(),
      }).eq('id', id!)

      await addTimeline('reopened', `Case reopened by ${profile?.full_name}`)

      // Notify staff & managers in all related departments (primary + assigned),
      // plus the original case creator.
      await notifyByDeptRole(
        {
          departments: [kcase!.department, ...(kcase!.assigned_departments || [])],
          roles: ['staff', 'manager'],
          extraIds: [kcase?.created_by],
        },
        'Case Reopened',
        `Case ${kcase!.case_number} has been reopened by ${profile?.full_name} and requires further action.`,
      )

      toast.success('Case reopened.')
      fetchCase()
    } catch {
      toast.error('Failed to reopen case.')
    } finally {
      setSubmitting(false)
    }
  }

  // Comments: add note with @mention notifications
  async function handleAddComment() {
    if (!newComment.trim()) return
    setSubmitting(true)
    try {
      await supabase.from('kaizen_case_comments').insert({ case_id: id!, user_id: profile?.id, content: newComment.trim() })

      // Parse @mentions: check which known users are mentioned by name
      if (profile) {
        const commentLower = newComment.toLowerCase()
        const mentionedUserIds = mentionUsers
          .filter(u => commentLower.includes(`@${u.full_name.toLowerCase()}`))
          .map(u => u.id)
          .filter(uid => uid !== profile.id)

        if (mentionedUserIds.length > 0) {
          const preview = newComment.trim().length > 80 ? newComment.trim().slice(0, 80) + '…' : newComment.trim()
          await supabase.from('kaizen_notifications').insert(
            mentionedUserIds.map((uid) => ({
              user_id: uid,
              case_id: id!,
              title: `${profile.full_name} mentioned you in ${kcase?.case_number}`,
              message: preview,
              notification_type: 'mention',
            }))
          )
        }
      }

      setNewComment('')
      setShowMentions(false)
      fetchCase()
    } catch { toast.error('Failed to add comment.') }
    finally { setSubmitting(false) }
  }

  // Admin: remove a department assignment
  async function handleRemoveDepartment(dept: Department, assignmentId: string) {
    if (!confirm(`Remove ${DEPARTMENT_LABELS[dept]} from this case?`)) return
    setSubmitting(true)
    try {
      // Delete assignment record
      await supabase.from('kaizen_case_assignments').delete().eq('id', assignmentId)

      // Update assigned_departments array on the case
      const newDepts = (kcase?.assigned_departments || []).filter(d => d !== dept)
      await supabase.from('kaizen_cases').update({
        assigned_departments: newDepts.length > 0 ? newDepts : null,
        updated_at: new Date().toISOString(),
      }).eq('id', id!)

      await addTimeline('department_removed', `${profile?.full_name} removed ${DEPARTMENT_LABELS[dept]} from the case.`)

      toast.success(`${DEPARTMENT_LABELS[dept]} removed from the case.`)
      fetchCase()
    } catch {
      toast.error('Failed to remove department.')
    } finally {
      setSubmitting(false)
    }
  }

  // Admin: add additional department
  async function handleAddDepartment() {
    if (!addDeptValue) return
    setAddingDept(true)
    try {
      const currentDepts = kcase?.assigned_departments || []
      const newDepts = [...currentDepts, addDeptValue]

      await supabase.from('kaizen_case_assignments').upsert({
        case_id: id!,
        department: addDeptValue,
        assigned_by: profile?.id,
        status: 'pending',
      }, { onConflict: 'case_id,department' })

      await supabase.from('kaizen_cases').update({
        assigned_departments: newDepts,
        updated_at: new Date().toISOString(),
      }).eq('id', id!)

      await addTimeline('department_added', `${profile?.full_name} added ${DEPARTMENT_LABELS[addDeptValue]} to the case.`)

      await notifyByDeptRole(
        { departments: [addDeptValue], roles: ['manager', 'staff'] },
        'Case Assigned to Your Department',
        `Case ${kcase?.case_number} has been additionally assigned to your department by Super Admin.`,
      )

      toast.success(`${DEPARTMENT_LABELS[addDeptValue]} added to the case.`)
      setAddDeptValue('')
      fetchCase()
    } catch {
      toast.error('Failed to add department.')
    } finally {
      setAddingDept(false)
    }
  }

  // Admin: open edit modal
  function openEditCase() {
    if (!kcase) return
    setEditTitle(kcase.title)
    setEditDescription(kcase.description)
    setEditDepartment(kcase.department)
    setEditDueDate(kcase.due_date || '')
    setEditStatus(kcase.status)
    setShowEditCase(true)
  }

  // Admin: save case edits
  async function handleSaveEditCase() {
    if (!editTitle.trim() || !editDescription.trim() || !editDepartment) {
      toast.error('Title, description and department are required.')
      return
    }
    setSubmitting(true)
    try {
      const changes: string[] = []
      if (editTitle.trim() !== kcase?.title) changes.push(`title: "${kcase?.title}" → "${editTitle.trim()}"`)
      if (editDescription.trim() !== kcase?.description) changes.push('description updated')
      if (editDepartment !== kcase?.department) changes.push(`department: ${DEPARTMENT_LABELS[kcase?.department as Department]} → ${DEPARTMENT_LABELS[editDepartment as Department]}`)
      if (editDueDate !== (kcase?.due_date || '')) changes.push(`due date: ${editDueDate || 'removed'}`)
      if (editStatus && editStatus !== kcase?.status) changes.push(`status: ${kcase?.status} → ${editStatus}`)

      await supabase.from('kaizen_cases').update({
        title: editTitle.trim(),
        description: editDescription.trim(),
        department: editDepartment,
        due_date: editDueDate || null,
        ...(editStatus && editStatus !== kcase?.status ? { status: editStatus } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', id!)

      await addTimeline('case_edited', `Case edited by ${profile?.full_name}${changes.length ? ': ' + changes.join('; ') : ''}`)

      toast.success('Case updated successfully.')
      setShowEditCase(false)
      fetchCase()
    } catch {
      toast.error('Failed to update case.')
    } finally {
      setSubmitting(false)
    }
  }

  // Admin: delete case
  async function handleDelete() {
    if (!confirm(`Are you sure you want to permanently delete case ${kcase?.case_number}? This cannot be undone.`)) return
    setSubmitting(true)
    try {
      await supabase.from('kaizen_cases').delete().eq('id', id!)
      toast.success('Case deleted.')
      navigate('/cases')
    } catch {
      toast.error('Failed to delete case.')
    } finally {
      setSubmitting(false)
    }
  }

  // Admin: change priority
  async function handleChangePriority() {
    if (!selectedPriority || selectedPriority === kcase?.priority) return
    setSubmitting(true)
    try {
      const priorityLabel = selectedPriority.charAt(0).toUpperCase() + selectedPriority.slice(1)

      await supabase.from('kaizen_cases').update({
        priority: selectedPriority,
        updated_at: new Date().toISOString(),
      }).eq('id', id!)

      await addTimeline('priority_changed', `Priority changed from ${kcase?.priority} to ${selectedPriority} by ${profile?.full_name}`)

      const depts = (kcase?.assigned_departments && kcase.assigned_departments.length > 0)
        ? kcase.assigned_departments
        : [kcase?.department]
      await notifyByDeptRole(
        { departments: depts, roles: ['manager'] },
        'Case Priority Changed',
        t.caseDetail.priorityChangedNotif(kcase?.case_number || '', priorityLabel),
      )

      toast.success(t.caseDetail.priorityChanged(priorityLabel))
      setSelectedPriority('')
      fetchCase()
    } catch {
      toast.error('Failed to update priority.')
    } finally {
      setSubmitting(false)
    }
  }


  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!kcase) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-500">{t.caseDetail.notFound}</p>
        <Link to="/cases"><Button variant="outline" className="mt-4">{t.common.back}</Button></Link>
      </div>
    )
  }

  const problemPhotos = photos.filter((p) => p.photo_type === 'problem')
  const resolutionPhotosList = photos.filter((p) => p.photo_type === 'resolution')

  // HR Manager is read-only across all cases
  const isHRManager = profile?.role === 'manager' && profile?.department === 'human_resource'

  const canManagerAssign  = !isHRManager && (
    profile?.role === 'super_admin' ||
    (profile?.role === 'manager' && profile?.department === kcase.department)
  )
  const canEditDueDate    = kcase.status !== 'closed' && (
    profile?.role === 'super_admin' ||
    (profile?.role === 'manager' && !isHRManager && profile?.department === kcase.department)
  )
  const canStaffResolve   = !isHRManager &&
    (profile?.role === 'staff' || profile?.role === 'manager' || profile?.role === 'super_admin') &&
    ['in_progress', 'assigned', 'reopened'].includes(kcase.status)
  const canManagerApprove = !isHRManager && (profile?.role === 'manager' || profile?.role === 'super_admin') && kcase.status === 'pending_manager_approval'
  const canAdminApprove   = profile?.role === 'super_admin' && kcase.status === 'pending_admin_approval'
  const canReopen         = profile?.role === 'super_admin' && kcase.status === 'closed'
  const canDelete         = profile?.role === 'super_admin'

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto animate-fade-in">
      {/* Header card */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-4 md:mb-6">
        {/* Top row: back + case number + action buttons */}
        <div className="flex items-center gap-2 mb-3">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-xs text-gray-400 whitespace-nowrap flex-1">{kcase.case_number}</span>
          {/* Action buttons — icons only on mobile */}
          <div className="flex items-center gap-1">
            {canManagerAssign && (
              <Button variant="ghost" size="icon-sm" onClick={handlePrint} disabled={submitting} title={t.caseDetail.printPdf}>
                <Printer className="h-4 w-4 text-gray-500" />
              </Button>
            )}
            {canDelete && (
              <Button variant="ghost" size="icon-sm" onClick={openEditCase} disabled={submitting} className="text-[var(--brand-primary)]">
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {canDelete && (
              <Button variant="ghost" size="icon-sm" onClick={handleDelete} disabled={submitting} className="text-red-500">
                <XCircle className="h-4 w-4" />
              </Button>
            )}
            {canReopen && (
              <Button variant="ghost" size="icon-sm" onClick={handleReopen} disabled={submitting} className="text-amber-600">
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Title */}
        <h1 className="text-xl font-bold text-gray-900 mb-3">{kcase.title}</h1>

        {/* Badges row */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          <StatusBadge status={kcase.status} />
          <PriorityBadge priority={kcase.priority} />
          <DepartmentBadge department={kcase.department} />
          {kcase.category && (
            <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full border border-gray-200">
              {kcase.category === 'other' && kcase.category_other ? kcase.category_other : CATEGORY_LABELS_EN[kcase.category] || kcase.category}
            </span>
          )}
          {kcase.location && (
            <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full border border-indigo-200">
              📍 {kcase.location === 'Others' && kcase.location_other ? kcase.location_other : kcase.location}
            </span>
          )}
          {kcase.is_recurring && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full border border-orange-200 font-medium">
              <RefreshCw className="h-3 w-3" />{t.caseDetail.recurringBadge}
            </span>
          )}
        </div>

        {/* ── Incomplete info banner ── */}
        {kcase.status !== 'closed' && (() => {
          const badDept = !validDeptValues.includes(kcase.department)
          const badLocation = kcase.location && kcase.location !== 'Others' &&
            !validLocations.some(v => v.toLowerCase() === kcase.location!.toLowerCase())
          const catLower = (kcase.category || '').toLowerCase().replace(/ /g, '_')
          const badCategory = kcase.category && kcase.category !== 'other' &&
            !validCategories.some(v => v.toLowerCase() === catLower) &&
            !customCatList.some(label => label.toLowerCase().replace(/ /g, '_') === catLower)
          if (!badDept && !badLocation && !badCategory) return null
          return (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                <p className="text-sm font-semibold text-amber-800">This case has outdated registration info — please update it</p>
              </div>
              <div className="space-y-3">
                {badDept && (
                  <div>
                    <label className="text-xs font-medium text-amber-700 block mb-1">
                      Department <span className="font-normal text-amber-600">(current: "{DEPARTMENT_LABELS[kcase.department] ?? kcase.department}" — removed)</span>
                    </label>
                    <Select value={fixDept} onValueChange={setFixDept}>
                      <SelectTrigger className="h-9 text-sm bg-white border-amber-300">
                        <SelectValue placeholder="Select new department…" />
                      </SelectTrigger>
                      <SelectContent>
                        {customDeptLabels.map(label => {
                          const val = DEPARTMENTS.find(d => d.label === label)?.value
                          return val ? <SelectItem key={val} value={val}>{label}</SelectItem> : null
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {badLocation && (
                  <div>
                    <label className="text-xs font-medium text-amber-700 block mb-1">
                      Location <span className="font-normal text-amber-600">(current: "{kcase.location}" — removed)</span>
                    </label>
                    <Select value={fixLocation} onValueChange={setFixLocation}>
                      <SelectTrigger className="h-9 text-sm bg-white border-amber-300">
                        <SelectValue placeholder="Select new location…" />
                      </SelectTrigger>
                      <SelectContent>
                        {customLocList.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {badCategory && (
                  <div>
                    <label className="text-xs font-medium text-amber-700 block mb-1">
                      Category <span className="font-normal text-amber-600">(current: "{kcase.category}" — removed)</span>
                    </label>
                    <Select value={fixCategory} onValueChange={setFixCategory}>
                      <SelectTrigger className="h-9 text-sm bg-white border-amber-300">
                        <SelectValue placeholder="Select new category…" />
                      </SelectTrigger>
                      <SelectContent>
                        {customCatList.map(c => <SelectItem key={c} value={c.toLowerCase().replace(/ /g,'_')}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button
                  size="sm"
                  onClick={saveFixedInfo}
                  disabled={savingFix || (!fixDept && !fixLocation && !fixCategory)}
                  className="w-full mt-1"
                >
                  {savingFix ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Updated Information'}
                </Button>
              </div>
            </div>
          )
        })()}

        {/* Meta info */}
        <div className="space-y-2 text-xs text-gray-500">

          {/* Row 1: Opened by | Open date — same 2-col grid as Row 3 */}
          <div className="grid grid-cols-2 gap-x-4">
            <span className="flex items-center gap-1.5">
              <User className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
              <span className="text-gray-400 mr-0.5">Opened by:</span>
              {(profile?.role === 'super_admin' || profile?.role === 'manager') && kcase.created_by ? (
                <Link to={`/performance/${kcase.created_by}`} className="truncate text-[var(--brand-primary)] hover:underline font-medium">
                  {(kcase.creator as KaizenProfile)?.full_name || 'Unknown'}
                </Link>
              ) : (
                <span className="truncate font-medium text-gray-700">{(kcase.creator as KaizenProfile)?.full_name || 'Unknown'}</span>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
              <span>{new Date(kcase.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            </span>
          </div>

          {/* Row 2: In Charge — full width */}
          <div className="grid grid-cols-1 gap-x-4">
            <div className="flex items-start gap-1.5">
              <User className="h-3.5 w-3.5 flex-shrink-0 text-[var(--brand-primary)] mt-0.5" />
              <div className="flex-1 min-w-0">
                <span className="text-gray-400 mr-0.5">In Charge:</span>
                {showPicEditor ? (
                  <div className="mt-1 border border-gray-200 rounded-lg bg-white shadow-sm overflow-hidden">
                    {/* Grouped checkboxes */}
                    <div className="max-h-56 overflow-y-auto p-2 space-y-1">
                      {(() => {
                        const managers = picCandidates.filter(p => p.role === 'manager')
                        const staff = picCandidates.filter(p => p.role === 'staff')
                        const staffByDept: Record<string, KaizenProfile[]> = {}
                        staff.forEach(p => {
                          const dept = p.department || 'other'
                          if (!staffByDept[dept]) staffByDept[dept] = []
                          staffByDept[dept].push(p)
                        })
                        const Row = ({ p }: { p: KaizenProfile }) => (
                          <label key={p.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-gray-300 accent-[var(--brand-primary)]"
                              checked={selectedPics.includes(p.id)}
                              onChange={() => setSelectedPics(prev =>
                                prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id]
                              )}
                            />
                            <span className="text-xs text-gray-800 flex-1">{p.full_name}</span>
                            {p.role === 'manager' && <span className="text-[10px] text-gray-400">{DEPARTMENT_LABELS[p.department] ?? p.department}</span>}
                          </label>
                        )
                        return (
                          <>
                            {managers.length > 0 && (
                              <div>
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide px-2 mb-0.5">Managers</p>
                                {managers.map(p => <Row key={p.id} p={p} />)}
                              </div>
                            )}
                            {Object.entries(staffByDept).map(([dept, members], idx) => (
                              <div key={dept}>
                                {(managers.length > 0 || idx > 0) && <div className="my-1 border-t border-gray-100" />}
                                {/* Dept header with notify tickbox */}
                                <div className="flex items-center justify-between px-2 mb-0.5">
                                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                                    {DEPARTMENT_LABELS[dept as Department] ?? dept}
                                  </p>
                                  <label className="flex items-center gap-1 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      className="h-3 w-3 rounded border-gray-300 accent-[var(--brand-primary)]"
                                      checked={notifyDepts.includes(dept)}
                                      onChange={() => setNotifyDepts(prev =>
                                        prev.includes(dept) ? prev.filter(d => d !== dept) : [...prev, dept]
                                      )}
                                    />
                                    <span className="text-[10px] text-gray-400">Notify all</span>
                                  </label>
                                </div>
                                {members.map(p => <Row key={p.id} p={p} />)}
                              </div>
                            ))}
                          </>
                        )
                      })()}
                    </div>
                    {/* Actions */}
                    <div className="border-t border-gray-100 px-3 py-2 flex items-center justify-between">
                      <span className="text-[10px] text-gray-400">{selectedPics.length} selected</span>
                      <div className="flex items-center gap-2">
                        <button onClick={() => { setShowPicEditor(false); setNotifyDepts([]) }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                        <button
                          onClick={savePic}
                          disabled={savingPic || selectedPics.length === 0}
                          className="text-xs font-semibold text-white bg-[var(--brand-primary)] px-2.5 py-1 rounded hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                        >
                          {savingPic ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1 flex-wrap">
                    <span className="font-medium text-gray-700">
                      {picProfiles.length > 0
                        ? picProfiles.map(p => p.full_name).join(', ')
                        : (kcase.creator as KaizenProfile)?.full_name || 'Unknown'}
                    </span>
                    {canManagerAssign && kcase.status !== 'closed' && (
                      <button
                        onClick={() => { loadPicCandidates(); setShowPicEditor(true) }}
                        className="text-gray-400 hover:text-[var(--brand-primary)] flex-shrink-0"
                        title="Edit In Charge"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Row 3: Open for | Due date */}
          <div className="grid grid-cols-2 gap-x-4">
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
              <span>{t.caseDetail.openFor} {formatDuration(kcase.created_at, kcase.closed_at || undefined)}</span>
            </span>
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
              {showDueDateEditor ? (
                <div className="flex items-center gap-1">
                  <Input type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)}
                    className="h-6 text-xs w-32 px-1.5" />
                  <button onClick={saveManagerDueDate} disabled={savingDueDate || !newDueDate}
                    className="text-[var(--brand-primary)] font-semibold hover:opacity-75 flex-shrink-0 text-xs">
                    {savingDueDate ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                  </button>
                  <button onClick={() => { setShowDueDateEditor(false); setNewDueDate('') }} className="text-gray-400 hover:text-gray-600">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : kcase.due_date ? (
                <span className="flex items-center gap-1">
                  <span className={cn(new Date(kcase.due_date) < new Date() && kcase.status !== 'closed' ? 'text-red-500 font-semibold' : '')}>
                    Due: {new Date(kcase.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {new Date(kcase.due_date) < new Date() && kcase.status !== 'closed' && ' ⚠️'}
                  </span>
                  {canEditDueDate && (
                    <button onClick={() => { setNewDueDate(kcase.due_date!.split('T')[0]); setShowDueDateEditor(true) }}
                      className="text-gray-400 hover:text-[var(--brand-primary)] transition-colors" title="Edit due date">
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ) : canEditDueDate ? (
                <button onClick={() => setShowDueDateEditor(true)}
                  className="text-gray-400 hover:text-[var(--brand-primary)] flex items-center gap-1 transition-colors">
                  <span>+ Add due date</span>
                </button>
              ) : (
                <span className="text-gray-300">No due date</span>
              )}
            </div>
          </div>

        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-5">
          {/* Description */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="font-semibold text-gray-900 mb-3">{t.caseDetail.caseInfo}</h3>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{kcase.description}</p>
          </div>

          {/* Problem photos */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="font-semibold text-gray-900 mb-3">{t.caseDetail.problemPhotos}</h3>
            <PhotoGallery urls={problemPhotos.map((p) => p.photo_url)} />
          </div>


          {/* Department assignments */}
          {assignments.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <h3 className="font-semibold text-gray-900 mb-3">{t.caseDetail.assignedDepts}</h3>
              <div className="flex flex-wrap gap-2">
                {assignments.map((asn) => (
                  profile?.role === 'super_admin' && kcase.status !== 'closed' ? (
                    <span key={asn.id} className="inline-flex items-center gap-1 group">
                      <DepartmentBadge department={asn.department} />
                      <button
                        type="button"
                        onClick={() => handleRemoveDepartment(asn.department, asn.id)}
                        disabled={submitting}
                        className="ml-[-6px] w-4 h-4 rounded-full bg-gray-200 hover:bg-red-500 text-gray-500 hover:text-white flex items-center justify-center transition-all"
                        title={`Remove ${DEPARTMENT_LABELS[asn.department]}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ) : (
                    <DepartmentBadge key={asn.id} department={asn.department} />
                  )
                ))}
              </div>
            </div>
          )}

          {/* Resolution description + photos (if resolved / previously resolved) */}
          <ResolutionCard
            kcase={kcase}
            timeline={timeline}
            resolutionPhotos={resolutionPhotosList}
            collapsed={prevResolutionCollapsed}
            onToggleCollapsed={() => setPrevResolutionCollapsed((v) => !v)}
            resolutionPhotosLabel={t.caseDetail.resolutionPhotos}
          />

          {/* Comments / Internal Notes */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-4">
              <MessageCircle className="h-4 w-4 text-gray-400" />
              <h3 className="font-semibold text-gray-900">{t.caseDetail.internalNotes}</h3>
              {comments.length > 0 && <span className="text-xs text-gray-400 ml-auto">{t.caseDetail.noteCount(comments.length)}</span>}
            </div>
            {comments.length === 0 && <p className="text-sm text-gray-400 mb-4">{t.caseDetail.noNotes}</p>}
            {comments.length > 0 && (
              <div className="space-y-3 mb-4">
                {comments.map((c) => (
                  <div key={c.id} className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-700">{c.user?.full_name}</span>
                      <span className="text-xs text-gray-400 capitalize">{c.user?.role?.replace('_',' ')}</span>
                      <span className="text-xs text-gray-400 ml-auto">{formatDateTime(c.created_at)}</span>
                    </div>
                    <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">
                      {renderCommentWithMentions(c.content)}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <div className="relative flex gap-2">
              <div className="flex-1 relative">
                <Textarea
                  ref={commentRef}
                  placeholder={t.caseDetail.notePlaceholder}
                  value={newComment}
                  onChange={(e) => handleCommentChange(e.target.value)}
                  className="min-h-[72px]"
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAddComment() }}
                />
                {/* @mention dropdown */}
                {showMentions && filteredMentionUsers.length > 0 && (
                  <div className="absolute bottom-full left-0 mb-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-40 overflow-y-auto">
                    {filteredMentionUsers.slice(0, 8).map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); insertMention(u) }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                      >
                        <span className="font-medium text-gray-800">{u.full_name}</span>
                        <span className="text-xs text-gray-400 capitalize">{u.role.replace('_',' ')}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button onClick={handleAddComment} disabled={!newComment.trim() || submitting} size="sm" className="self-end">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t.caseDetail.postNote}
              </Button>
            </div>
          </div>

          {/* Recurring Issue Detection — auto, managers/admins only */}
          {canManagerAssign && recurringCases.length > 0 && (() => {
            const count = recurringCases.length
            const isChronic = count >= 3
            const isRecurring = count >= 2
            const borderColor = isChronic ? 'border-red-300' : isRecurring ? 'border-orange-300' : 'border-yellow-300'
            const bgColor = isChronic ? 'bg-red-50' : isRecurring ? 'bg-orange-50' : 'bg-yellow-50'
            const textColor = isChronic ? 'text-red-700' : isRecurring ? 'text-orange-700' : 'text-yellow-700'
            const iconColor = isChronic ? 'text-red-500' : isRecurring ? 'text-orange-500' : 'text-yellow-500'
            const badgeLabel = isChronic
              ? `Chronic Issue · ${count} reports`
              : isRecurring
              ? `Recurring Issue · ${count} reports`
              : `Reported Before · ${count} report`
            const advice = isChronic
              ? 'This location has been reported 3+ times. Consider a permanent fix or replacement.'
              : isRecurring
              ? 'This location has been reported multiple times. Monitor closely.'
              : 'This location was reported once before.'
            return (
              <div className={`rounded-xl border ${borderColor} shadow-sm overflow-hidden`}>
                <button
                  type="button"
                  onClick={() => setRecurringOpen(v => !v)}
                  className={`w-full flex items-center justify-between px-5 py-4 ${bgColor} hover:opacity-90 transition-opacity`}
                >
                  <div className="flex items-center gap-2.5">
                    <RotateCcw className={`h-4 w-4 flex-shrink-0 ${iconColor}`} />
                    <div className="text-left">
                      <span className={`text-sm font-semibold ${textColor}`}>{badgeLabel}</span>
                      <p className={`text-xs mt-0.5 ${textColor} opacity-80`}>{advice}</p>
                    </div>
                  </div>
                  {recurringOpen
                    ? <ChevronUp className={`h-4 w-4 ${iconColor} flex-shrink-0`} />
                    : <ChevronDown className={`h-4 w-4 ${iconColor} flex-shrink-0`} />
                  }
                </button>
                {recurringOpen && (
                  <div className="bg-white divide-y divide-gray-50">
                    {recurringCases.map((rc) => (
                      <Link
                        key={rc.id}
                        to={`/cases/${rc.id}`}
                        className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors"
                      >
                        <span className="font-mono text-xs text-gray-400 flex-shrink-0 w-20">{rc.case_number}</span>
                        <span className="text-sm font-medium text-gray-800 flex-1 truncate">{rc.title}</span>
                        <StatusBadge status={rc.status} />
                        <span className="text-xs text-gray-400 flex-shrink-0">
                          {new Date(rc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}

          {/* Action panels */}

          {/* Staff: resolve */}
          {canStaffResolve && (
            <div className="bg-white rounded-xl border border-green-300 shadow-sm p-5">
              <h3 className="font-semibold text-gray-900 mb-4">{t.caseDetail.resolveCase}</h3>
              <div className="space-y-4">
                <div>
                  <Label className="mb-1.5 block">{t.caseDetail.resolutionDesc}</Label>
                  <Textarea
                    placeholder={t.caseDetail.resolutionPlaceholder}
                    value={resolutionNote}
                    onChange={(e) => setResolutionNote(e.target.value)}
                    className="min-h-[100px]"
                  />
                </div>
                <div>
                  <Label className="mb-2 block">{t.caseDetail.uploadEvidence}</Label>
                  <PhotoUpload
                    onUpload={(urls) => setResolutionPhotos((prev) => [...prev, ...urls])}
                    maxFiles={3}
                    label="Upload Resolution Photos"
                  />
                </div>
                <Button onClick={handleResolve} disabled={submitting} className="w-full bg-green-600 hover:bg-green-700">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t.caseDetail.submitResolution}
                </Button>
              </div>
            </div>
          )}

          {/* Manager: approve */}
          {canManagerApprove && (
            <div className="bg-orange-50 border border-orange-300 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-5 w-5 text-orange-600" />
                <h3 className="font-semibold text-orange-900">{t.caseDetail.approveTitle}</h3>
              </div>
              <p className="text-sm text-orange-700 mb-4">{t.caseDetail.approveDesc}</p>
              <Button onClick={() => setShowApproveConfirm(true)} disabled={submitting} className="w-full bg-orange-600 hover:bg-orange-700">
                {t.caseDetail.approveBtn}
              </Button>
            </div>
          )}

          {/* Admin: final approve */}
          {canAdminApprove && (
            <div className="bg-violet-50 border border-violet-300 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="h-5 w-5 text-violet-600" />
                <h3 className="font-semibold text-violet-900">{t.caseDetail.closeTitle}</h3>
              </div>
              <p className="text-sm text-violet-700 mb-4">{t.caseDetail.closeDesc}</p>
              <Button onClick={() => setShowAdminApproveConfirm(true)} disabled={submitting} className="w-full bg-violet-600 hover:bg-violet-700">
                {t.caseDetail.closeBtn}
              </Button>
            </div>
          )}
        </div>

        {/* Sidebar: Timeline + Admin controls */}
        <div className="space-y-5">

          {/* Case timing info card */}
          {(() => {
            const openFor = formatDuration(kcase.created_at, kcase.closed_at || undefined)
            const dueDateObj = kcase.due_date ? new Date(kcase.due_date) : null
            const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0)
            let daysLeftLabel: React.ReactNode = null
            if (dueDateObj) {
              const dueMidnight = new Date(dueDateObj); dueMidnight.setHours(0,0,0,0)
              const diffMs = dueMidnight.getTime() - todayMidnight.getTime()
              const diffDays = Math.round(diffMs / 86400000)
              if (diffDays === 0) {
                daysLeftLabel = <span className="text-sm font-bold text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full">{t.caseDetail.dueToday}</span>
              } else if (diffDays < 0) {
                daysLeftLabel = <span className="text-sm font-bold text-red-600 bg-red-50 border border-red-200 px-3 py-1 rounded-full">{t.caseDetail.overdueBy(Math.abs(diffDays))}</span>
              } else if (diffDays <= 3) {
                daysLeftLabel = <span className="text-sm font-bold text-orange-600 bg-orange-50 border border-orange-200 px-3 py-1 rounded-full">{t.caseDetail.daysLeftCount(diffDays)}</span>
              } else {
                daysLeftLabel = <span className="text-sm font-bold text-green-700 bg-green-50 border border-green-200 px-3 py-1 rounded-full">{t.caseDetail.daysLeftCount(diffDays)}</span>
              }
            }
            return (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />{t.caseDetail.openFor}</span>
                  <span className="text-xs font-semibold text-gray-800">{openFor}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" />{t.caseDetail.dueDateLabel}</span>
                  {dueDateObj
                    ? <span className="text-xs font-semibold text-gray-800">{dueDateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                    : <span className="text-xs text-gray-300">{t.caseDetail.notSet}</span>
                  }
                </div>
                {daysLeftLabel && (
                  <div className="flex items-center justify-between pt-1 border-t border-gray-100">
                    <span className="text-xs text-gray-500">{t.caseDetail.daysLeftLabel}</span>
                    {daysLeftLabel}
                  </div>
                )}
              </div>
            )
          })()}

          {/* Change Priority — super_admin only */}
          {profile?.role === 'super_admin' && (
            <div className="bg-white rounded-xl border border-amber-300 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <h3 className="font-semibold text-gray-900 text-sm">{t.caseDetail.changePriority}</h3>
              </div>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 shrink-0">{t.caseDetail.currentPriority}</span>
                  <PriorityBadge priority={kcase.priority} />
                </div>
                <Select value={selectedPriority} onValueChange={(v) => setSelectedPriority(v as CasePriority)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder={t.caseDetail.selectNewPriority} />
                  </SelectTrigger>
                  <SelectContent>
                    {(['critical', 'high', 'medium', 'low'] as CasePriority[]).filter(p => p !== kcase.priority).map((p) => (
                      <SelectItem key={p} value={p} className="capitalize">{p.charAt(0).toUpperCase() + p.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={handleChangePriority}
                  disabled={!selectedPriority || submitting}
                  size="sm"
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t.caseDetail.changePriorityBtn}
                </Button>
              </div>
            </div>
          )}

          <CaseTimeline
            timeline={timeline}
            title={t.caseDetail.timeline}
            emptyLabel={t.caseDetail.noActivity}
          />
        </div>
      </div>

      {/* Manager Approve Confirmation */}
      <Dialog open={showApproveConfirm} onOpenChange={setShowApproveConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-500" />
              Confirm Approval
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to approve this resolution? It will be forwarded to General Manager for final closure.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowApproveConfirm(false)}>Cancel</Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white"
              disabled={submitting}
              onClick={() => { setShowApproveConfirm(false); handleManagerApprove() }}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Approve Resolution'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin Final Approve Confirmation */}
      <Dialog open={showAdminApproveConfirm} onOpenChange={setShowAdminApproveConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-violet-500" />
              Confirm Final Closure
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to approve and close this case? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowAdminApproveConfirm(false)}>Cancel</Button>
            <Button
              className="bg-violet-600 hover:bg-violet-700 text-white"
              disabled={submitting}
              onClick={() => { setShowAdminApproveConfirm(false); handleAdminApprove() }}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Close Case'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Case Modal — super_admin only */}
      <Dialog open={showEditCase} onOpenChange={setShowEditCase}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-4 w-4 text-[var(--brand-primary)]" />
              {t.caseDetail.editModalTitle}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t.caseDetail.fieldTitle}</Label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder={t.caseDetail.fieldTitle}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t.caseDetail.fieldDescription}</Label>
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t.caseDetail.fieldDescription}
                className="min-h-[100px]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t.createCase.department}</Label>
                <Select value={editDepartment} onValueChange={(v) => setEditDepartment(v as Department)}>
                  <SelectTrigger>
                    <SelectValue placeholder={t.caseDetail.selectDept} />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.filter(d => d.value !== 'top_management').map((d) => (
                      <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>{t.caseDetail.fieldDueDate} <span className="text-gray-400 font-normal">{t.createCase.optional}</span></Label>
                <Input
                  type="date"
                  value={editDueDate}
                  onChange={(e) => setEditDueDate(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t.caseDetail.fieldStatus}</Label>
              <Select value={editStatus} onValueChange={(v) => setEditStatus(v as CaseStatus)}>
                <SelectTrigger>
                  <SelectValue placeholder={t.caseDetail.selectStatus} />
                </SelectTrigger>
                <SelectContent>
                  {(['open', 'assigned', 'in_progress', 'pending_manager_approval', 'pending_admin_approval', 'closed', 'reopened'] as CaseStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-400">{t.caseDetail.statusManualNote}</p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowEditCase(false)} disabled={submitting}>
              {t.caseDetail.cancelBtn}
            </Button>
            <Button onClick={handleSaveEditCase} disabled={submitting || !editTitle.trim()}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t.caseDetail.saveChanges}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
