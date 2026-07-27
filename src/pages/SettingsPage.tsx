import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Loader2, Palette, Lock, Info, Scale, Pencil, Check, X, Bell, BellOff, BellRing, Plus, Trash2, Building2, AlertTriangle, LifeBuoy, HelpCircle, MessageSquare, Smartphone, Mail, ChevronRight, ChevronDown, UserX, Camera, Sparkles, Wrench, SlidersHorizontal, ClipboardList, Users } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { DEPARTMENT_LABELS, DEPARTMENTS, getEffectiveDepts } from '@/types'
import type { KaizenCompany, KaizenProfile, Department } from '@/types'
import { CATEGORIES, LOCATIONS, getInitials, companyHasFeature, companyHasAddon } from '@/lib/utils'
import { PMEquipmentTypes } from '@/components/PMEquipmentTypes'
import { PMSettings } from '@/components/PMSettings'
import { RRSettings } from '@/components/RRSettings'
import { RoomSetupSettings } from '@/components/RoomSetupSettings'
import { RoomRecipesSettings } from '@/components/RoomRecipesSettings'
import { RoomMonitorAccessSettings } from '@/components/RoomMonitorAccessSettings'
import { SpecialApprovalSettings } from '@/components/SpecialApprovalSettings'
import { RoomNotifySettings } from '@/components/RoomNotifySettings'
import { RrFoAccessSettings } from '@/components/RrFoAccessSettings'
import { LoadError } from '@/components/LoadError'
import { CollapsibleCard } from '@/components/CollapsibleCard'
import { loadPerfConfig, DEFAULT_PERF_CONFIG, type PerfConfig, type StaffWeightKey, type ManagerWeightKey } from '@/lib/perfConfig'
import { toast } from 'sonner'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { validatePassword, validatePasswordsMatch } from '@/lib/validators'

// Default lists (hardcoded fallback)
const DEFAULT_DEPARTMENTS = DEPARTMENTS.filter(d => d.value !== 'top_management').map(d => d.label)
const DEFAULT_CATEGORIES = [...CATEGORIES].map(c => c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))
const DEFAULT_LOCATIONS = [...LOCATIONS] as string[]

// "Preventive Maintenance" names the PMS function, not a case category. Its slug
// (preventive_maintenance) is written by kaizen_pm_sync on the cases PMS creates
// automatically, and CaseDetailPage keys its auto-case treatment off it — so a
// company category of the same name would produce hand-filed cases that
// masquerade as auto-generated ones.
function isReservedCategory(label: string): boolean {
  return label.trim().toLowerCase().replace(/\s+/g, '_') === 'preventive_maintenance'
}
function reservedCategoryMessage(lang: string): string {
  return lang === 'th'
    ? '"Preventive Maintenance" สงวนไว้สำหรับระบบ PMS จึงใช้เป็นหมวดหมู่ไม่ได้'
    : '"Preventive Maintenance" is reserved for the PMS function and cannot be used as a category.'
}

// Support
const DEFAULT_SUPPORT_EMAIL = 'potichao@me.com'

const PRESET_COLORS = [
  // Special presets — these also set the page background (no manual bg picker).
  { label: 'Classic',     primary: '#0891b2', accent: '#06b6d4', sidebar: '#1c2b3a', background: '#f8fafc' },
  { label: 'Forest',      primary: '#1a4731', accent: '#d4a853', sidebar: '#0e2e1e', background: '#f2f6f3' },
  { label: 'Crimson Red', primary: '#6b1f2e', accent: '#d4a853', sidebar: '#4a0f1d', background: '#faf4f4' },
  { label: 'Cyberpunk',   primary: '#22d3ee', accent: '#e879f9', sidebar: '#0a0e1a', background: '#0d1117' },
  { label: 'Gentle Grey', primary: '#111827', accent: '#9ca3af', sidebar: '#1f2937', background: '#f3f4f6' },
  { label: 'Pastelian',   primary: '#8b7ad6', accent: '#f7a3c3', sidebar: '#6f5fc0', background: '#f7f3ff' },
]

export function SettingsPage() {
  const { profile, refreshProfile } = useAuth()
  const { activeCompany } = useCompany()
  const navigate = useNavigate()
  const companyId = activeCompany?.id ?? profile?.company_id ?? null
  const { status: pushStatus, isIOS: pushIsIOS, isStandalone: pushIsStandalone, subscribe, unsubscribe } = usePushNotifications(profile?.id)
  const { settings, updateSettings } = useTheme()
  const { t, lang, setLang } = useLanguage()

  // Push-notification coverage (Top Management only). Which team members have a
  // live push subscription — i.e. who actually gets device alerts vs. in-app only.
  // Reads via the kaizen_push_coverage RPC because RLS hides other users' rows.
  type PushCoverageRow = { user_id: string; full_name: string; department: string; role: string; has_push: boolean }
  const [pushCoverage, setPushCoverage] = useState<PushCoverageRow[] | null>(null)
  const [pushCovErr, setPushCovErr] = useState(false)
  useEffect(() => {
    if (profile?.role !== 'super_admin' || !companyId) return
    let cancelled = false
    setPushCoverage(null); setPushCovErr(false)
    ;(async () => {
      const { data, error } = await supabase.rpc('kaizen_push_coverage', { p_company_id: companyId })
      if (cancelled) return
      if (error) { setPushCovErr(true); return }
      setPushCoverage((data ?? []) as PushCoverageRow[])
    })()
    return () => { cancelled = true }
  }, [profile?.role, companyId])

  // Avatar upload
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile?.avatar_url ?? null)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)

  // Keep avatarUrl in sync when profile loads
  React.useEffect(() => { setAvatarUrl(profile?.avatar_url ?? null) }, [profile?.avatar_url])

  function cropToSquare(file: File): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        const size = Math.min(img.width, img.height)
        const canvas = document.createElement('canvas')
        // 300×300 at 72% quality ≈ 15–25 KB — good for avatars, saves storage
        canvas.width = 300; canvas.height = 300
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, 300, 300)
        URL.revokeObjectURL(url)
        canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.72)
      }
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')) }
      img.src = url
    })
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !profile) return
    e.target.value = ''
    setUploadingAvatar(true)
    try {
      const cropped = await cropToSquare(file)
      const path = `avatars/${profile.id}.jpg`
      const { error: uploadErr } = await supabase.storage
        .from('kaizen-photos')
        .upload(path, cropped, { upsert: true, contentType: 'image/jpeg' })
      if (uploadErr) throw uploadErr
      const { data: { publicUrl } } = supabase.storage.from('kaizen-photos').getPublicUrl(path)
      // Bust cache so the browser re-fetches the new photo
      const url = `${publicUrl}?t=${Date.now()}`
      const { error: updateErr } = await supabase
        .from('kaizen_profiles').update({ avatar_url: url }).eq('id', profile.id)
      if (updateErr) throw updateErr
      setAvatarUrl(url)
      await refreshProfile()
      toast.success(lang === 'th' ? 'อัปเดตรูปโปรไฟล์แล้ว' : 'Profile photo updated.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (lang === 'th' ? 'อัปโหลดไม่สำเร็จ' : 'Upload failed.'))
    } finally {
      setUploadingAvatar(false)
    }
  }

  // Profile edit state
  const [editingProfile, setEditingProfile] = useState(false)
  const [editName, setEditName] = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  // Editable-lists tab (declared at top level — hooks must not live inside the JSX IIFE below)
  const [activeListTab, setActiveListTab] = useState<'dept' | 'cat' | 'loc'>('dept')

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
    if (!trimmedName) { toast.error(lang === 'th' ? 'กรุณากรอกชื่อ' : 'Name cannot be empty.'); return }
    setSavingProfile(true)
    try {
      const updates: { full_name: string; username?: string } = { full_name: trimmedName }
      if (profile.role === 'staff') updates.username = editUsername.trim() || profile.username || ''
      const { error } = await supabase.from('kaizen_profiles').update(updates).eq('id', profile.id)
      if (error) throw error
      await refreshProfile()
      toast.success(lang === 'th' ? 'อัปเดตโปรไฟล์แล้ว' : 'Profile updated.')
      setEditingProfile(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (lang === 'th' ? 'อัปเดตโปรไฟล์ไม่สำเร็จ' : 'Failed to update profile.'))
    } finally {
      setSavingProfile(false)
    }
  }

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)


  // ── Editable lists ──────────────────────────────────────────────────────────
  const [deptList, setDeptList] = useState<string[]>(DEFAULT_DEPARTMENTS)
  const [catList, setCatList] = useState<string[]>(DEFAULT_CATEGORIES)
  const [locList, setLocList] = useState<string[]>(DEFAULT_LOCATIONS)

  // new-item inputs
  const [newDept, setNewDept] = useState('')
  const [newCat, setNewCat] = useState('')
  const [newLoc, setNewLoc] = useState('')

  // inline-edit state: { key: 'dept'|'cat'|'loc', index: number, value: string } | null
  const [editingItem, setEditingItem] = useState<{ key: string; index: number; value: string } | null>(null)

  // Load this company's lists. A saved row (even empty) is authoritative;
  // companies with NO saved row fall back to the built-in defaults. New
  // companies are seeded with empty rows, so they start blank.
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    async function loadLists() {
      const { data } = await supabase
        .from('kaizen_settings')
        .select('key, value')
        .eq('company_id', companyId)
        .in('key', ['custom_departments', 'custom_categories', 'custom_locations'])
      if (cancelled) return
      let d = DEFAULT_DEPARTMENTS, c = DEFAULT_CATEGORIES, l = DEFAULT_LOCATIONS
      data?.forEach((row: { key: string; value: unknown }) => {
        if (!Array.isArray(row.value)) return
        if (row.key === 'custom_departments') d = row.value as string[]
        if (row.key === 'custom_categories') c = row.value as string[]
        if (row.key === 'custom_locations') l = row.value as string[]
      })
      // "Preventive Maintenance" is deliberately NOT shown here. It names the PMS
      // function, not a case category: the slug is written only by
      // kaizen_pm_sync on the cases PMS auto-creates. It used to be injected as a
      // virtual row, which meant it appeared in this list as a category nobody
      // could remove, sitting alongside the company's own maintenance category.
      setDeptList(d); setCatList(c); setLocList(l)
    }
    loadLists()
    return () => { cancelled = true }
  }, [companyId])

  // SP-001: check and throw on Supabase write errors so callers can surface failures
  async function saveList(key: string, list: string[]) {
    // Throw here too — a silent return let addItem/removeItem/confirmEdit's
    // try/catch take the success branch and toast success even though no
    // upsert was ever attempted.
    if (!companyId) throw new Error('No active company')
    const { error } = await supabase
      .from('kaizen_settings')
      .upsert({ key, value: list, company_id: companyId, updated_by: profile?.id ?? null }, { onConflict: 'key,company_id' })
    if (error) throw error
  }

  async function addItem(key: string, value: string, list: string[], setList: (l: string[]) => void, setNew: (v: string) => void) {
    const trimmed = value.trim()
    if (!trimmed) return
    if (list.some(i => i.toLowerCase() === trimmed.toLowerCase())) {
      toast.error(lang === 'th' ? 'มีรายการนี้อยู่แล้ว' : 'Item already exists.')
      return
    }
    if (key === 'custom_categories' && isReservedCategory(trimmed)) {
      toast.error(reservedCategoryMessage(lang))
      return
    }
    const updated = [...list, trimmed]
    try {
      await saveList(key, updated)
      setList(updated)
      setNew('')
      toast.success(lang === 'th' ? 'เพิ่มแล้ว' : 'Added.')
    } catch {
      toast.error(lang === 'th' ? 'บันทึกไม่สำเร็จ' : 'Failed to save.')
    }
  }

  async function removeItem(key: string, index: number, list: string[], setList: (l: string[]) => void) {
    // The old SP-004 guard blocking removal of "Preventive Maintenance" is gone
    // with the virtual row it protected — the category is no longer listed here,
    // so there is nothing to stop anyone deleting.
    // Check for open cases using this item before deletion (mirrors the bulk-remove affected-cases guard)
    if (companyId && (key === 'custom_categories' || key === 'custom_locations' || key === 'custom_departments')) {
      const item = list[index]
      let affectedCount = 0
      if (key === 'custom_categories') {
        const { count } = await supabase.from('kaizen_cases').select('*', { count: 'exact', head: true })
          .eq('company_id', companyId).eq('category', item.toLowerCase().replace(/ /g, '_')).neq('status', 'closed')
        affectedCount = count ?? 0
      } else if (key === 'custom_locations') {
        const { count } = await supabase.from('kaizen_cases').select('*', { count: 'exact', head: true })
          .eq('company_id', companyId).eq('location', item).neq('status', 'closed')
        affectedCount = count ?? 0
      } else if (key === 'custom_departments') {
        const deptValue = DEPARTMENTS.find(d => d.label === item)?.value ?? item
        const { count } = await supabase.from('kaizen_cases').select('*', { count: 'exact', head: true })
          .eq('company_id', companyId).eq('department', deptValue).neq('status', 'closed')
        affectedCount = count ?? 0
      }
      if (affectedCount > 0) {
        const msg = lang === 'th'
          ? `มีเคสที่เปิดอยู่ ${affectedCount} เคสที่ใช้ "${list[index]}" ต้องการลบต่อหรือไม่?`
          : `${affectedCount} open case${affectedCount === 1 ? '' : 's'} use "${list[index]}". Remove anyway?`
        if (!window.confirm(msg)) return
      }
    }
    const updated = list.filter((_, i) => i !== index)
    try {
      await saveList(key, updated)
      setList(updated)
      toast.success(lang === 'th' ? 'ลบแล้ว' : 'Removed.')
    } catch {
      toast.error(lang === 'th' ? 'บันทึกไม่สำเร็จ' : 'Failed to save.')
    }
  }

  function startEdit(key: string, index: number, value: string) {
    setEditingItem({ key, index, value })
  }

  async function confirmEdit(list: string[], setList: (l: string[]) => void, key: string) {
    if (!editingItem) return
    const trimmed = editingItem.value.trim()
    if (!trimmed) { setEditingItem(null); return }
    if (list.some((it, i) => i !== editingItem.index && it.toLowerCase() === trimmed.toLowerCase())) {
      toast.error(lang === 'th' ? 'มีรายการนี้อยู่แล้ว' : 'Item already exists.')
      return
    }
    if (key === 'custom_categories' && isReservedCategory(trimmed)) {
      toast.error(reservedCategoryMessage(lang))
      return
    }
    const oldLabel = list[editingItem.index]
    const updated = list.map((item, i) => i === editingItem.index ? trimmed : item)
    try {
      await saveList(key, updated)
      // SP-EDIT-ORPHAN-01: cases store the taxonomy value by content (category
      // slug / raw location / dept label→value), so a rename would orphan every
      // existing case still referencing the old value. Migrate them in the same
      // operation so no case is left pointing at a value that no longer exists.
      if (companyId && oldLabel && oldLabel !== trimmed) {
        // supabase-js RESOLVES with { error } rather than rejecting, so the
        // try/catch around this block never sees a failed migration. Left
        // unchecked, a failure here renamed the label, silently left every case
        // pointing at the old value, and still reported "Updated." — the cases
        // then showed up under "Other" with nothing to explain why.
        let migrateError: { message: string } | null = null
        // Populated only in the custom_departments branch below; hoisted so the
        // migrateError rollback branch (which runs after that branch's own
        // block scope has closed) can still see which managers were touched.
        const migratedManagerIds: string[] = []
        if (key === 'custom_categories') {
          const oldSlug = oldLabel.toLowerCase().replace(/ /g, '_')
          const newSlug = trimmed.toLowerCase().replace(/ /g, '_')
          if (oldSlug !== newSlug) {
            const { error } = await supabase.from('kaizen_cases').update({ category: newSlug })
              .eq('company_id', companyId).eq('category', oldSlug)
            migrateError = error
          }
        } else if (key === 'custom_locations') {
          const { error } = await supabase.from('kaizen_cases').update({ location: trimmed })
            .eq('company_id', companyId).eq('location', oldLabel)
          migrateError = error
        } else if (key === 'custom_departments') {
          // Built-in depts store a slug; custom depts store the label as the value.
          const oldVal = DEPARTMENTS.find(d => d.label === oldLabel)?.value ?? oldLabel
          const newVal = DEPARTMENTS.find(d => d.label === trimmed)?.value ?? trimmed
          if (oldVal !== newVal) {
            const { error: caseErr } = await supabase.from('kaizen_cases').update({ department: newVal })
              .eq('company_id', companyId).eq('department', oldVal)
            // SP-DEPT-ORPHAN-01: cases were migrated above, but kaizen_profiles
            // stores the SAME identifier in two places — profiles.department
            // (the user's home department) and profiles.managed_departments (a
            // manager's extra granted departments) — and neither was touched.
            // Renaming a custom department therefore split it in two: cases
            // moved to the new label/slug while every profile still pointed at
            // the old one, so `.in('department', getEffectiveDepts(profile))`
            // filters throughout the app (UsersPage, PerformanceDetailPage, the
            // dashboard) matched zero cases and the whole team lost visibility
            // into work that was still theirs.
            let profErr: { message: string } | null = null
            let managedErr: { message: string } | null = null
            if (!caseErr) {
              ({ error: profErr } = await supabase
                .from('kaizen_profiles').update({ department: newVal })
                .eq('company_id', companyId).eq('department', oldVal))
            }
            if (!caseErr && !profErr) {
              // managed_departments is a text[]; supabase-js has no array-replace
              // update, so this is a scoped read-modify-write over the (small)
              // set of managers who actually have oldVal granted.
              const { data: mgrs, error: fetchErr } = await supabase
                .from('kaizen_profiles').select('id, managed_departments')
                .eq('company_id', companyId).contains('managed_departments', [oldVal])
              if (fetchErr) {
                managedErr = fetchErr
              } else if (mgrs?.length) {
                for (const m of mgrs) {
                  const next = ((m.managed_departments as string[] | null) ?? [])
                    .map((d) => d === oldVal ? newVal : d)
                  const { error } = await supabase.from('kaizen_profiles')
                    .update({ managed_departments: next }).eq('id', m.id)
                  if (error) { managedErr = error; break }
                  migratedManagerIds.push(m.id)
                }
              }
            }
            migrateError = caseErr || profErr || managedErr
          }
        }
        if (migrateError) {
          // SP-DEPT-ROLLBACK-01: the label list was already saved above, and
          // saveList/toast used to just put the OLD label back — but that left
          // any cases/profiles/managers already migrated in an earlier
          // successful step still pointing at newVal, which no longer appears
          // anywhere in the department list. "Reverted" was a lie in that case.
          // Reverse every step that actually committed, in the opposite order,
          // before restoring the label list.
          if (key === 'custom_departments' && oldLabel) {
            const oldVal = DEPARTMENTS.find(d => d.label === oldLabel)?.value ?? oldLabel
            const newVal = DEPARTMENTS.find(d => d.label === trimmed)?.value ?? trimmed
            for (const mgrId of migratedManagerIds) {
              const { data: mgr } = await supabase.from('kaizen_profiles')
                .select('managed_departments').eq('id', mgrId).maybeSingle()
              const reverted = ((mgr?.managed_departments as string[] | null) ?? [])
                .map((d) => d === newVal ? oldVal : d)
              await supabase.from('kaizen_profiles')
                .update({ managed_departments: reverted }).eq('id', mgrId)
            }
            // Only reachable if cases+profiles succeeded (managedErr path) — revert both.
            // If profiles failed, cases were the only thing to revert.
            await supabase.from('kaizen_profiles').update({ department: oldVal })
              .eq('company_id', companyId).eq('department', newVal)
            await supabase.from('kaizen_cases').update({ department: oldVal })
              .eq('company_id', companyId).eq('department', newVal)
          } else if (key === 'custom_categories' && oldLabel) {
            const oldSlug = oldLabel.toLowerCase().replace(/ /g, '_')
            const newSlug = trimmed.toLowerCase().replace(/ /g, '_')
            await supabase.from('kaizen_cases').update({ category: oldSlug })
              .eq('company_id', companyId).eq('category', newSlug)
          } else if (key === 'custom_locations' && oldLabel) {
            await supabase.from('kaizen_cases').update({ location: oldLabel })
              .eq('company_id', companyId).eq('location', trimmed)
          }
          await saveList(key, list)
          setEditingItem(null)
          toast.error(lang === 'th'
            ? 'เปลี่ยนชื่อไม่สำเร็จ: ย้ายข้อมูลที่เกี่ยวข้องไม่ได้ จึงคืนค่าเดิมแล้ว'
            : 'Rename failed: existing data could not be moved, so the change was reverted.')
          return
        }
      }
      setList(updated)
      setEditingItem(null)
      toast.success(lang === 'th' ? 'อัปเดตแล้ว' : 'Updated.')
    } catch {
      toast.error(lang === 'th' ? 'บันทึกไม่สำเร็จ' : 'Failed to save.')
    }
  }

  // ── Bulk delete ──────────────────────────────────────────────────────────
  const [bulkConfirm, setBulkConfirm] = useState<{
    listKey: string
    dbKey: string
    items: string[]
    indices: number[]
    affectedCases: number
    checking: boolean
  } | null>(null)

  async function handleBulkRemove(
    listKey: string,
    dbKey: string,
    indices: number[],
    list: string[],
    setList: (l: string[]) => void,
  ) {
    // The SP-004 bulk guard went with the virtual "Preventive Maintenance" row it
    // mirrored — that category is no longer listed, so there is nothing to filter.
    const targetIndices = indices
    const items = targetIndices.map(i => list[i])
    const token = ++_bulkTokenRef.current
    // Show dialog immediately with checking state
    setBulkConfirm({ listKey, dbKey, items, indices: targetIndices, affectedCases: 0, checking: true })

    // Count affected cases (location is a direct string match)
    let affected = 0
    if (listKey === 'loc') {
      const { count } = await supabase
        .from('kaizen_cases')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('location', items)
        .neq('status', 'closed')
      affected = count ?? 0
    } else if (listKey === 'cat') {
      // cases store raw keys: 'maintenance', 'guest_complaint' etc.
      const slugs = items.map(i => i.toLowerCase().replace(/ /g, '_'))
      const { count } = await supabase
        .from('kaizen_cases')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('category', slugs)
        .neq('status', 'closed')
      affected = count ?? 0
    } else if (listKey === 'dept') {
      // Cases store the built-in dept SLUG (House Keeping → house_keeping) but a custom
      // dept's RAW LABEL (e.g. "Spa"). Blind slugify missed custom depts, so deleting one
      // reported 0 affected cases and silently orphaned them. Map label → stored value.
      const deptValues = items.map(i => DEPARTMENTS.find(d => d.label === i)?.value ?? i)
      const { count } = await supabase
        .from('kaizen_cases')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('department', deptValues)
        .neq('status', 'closed')
      affected = count ?? 0
    }

    if (_bulkTokenRef.current !== token) return
    setBulkConfirm(prev => prev ? { ...prev, affectedCases: affected, checking: false } : null)

    // Remove the list + setList reference so we can use them in confirmBulkDelete
    _pendingBulkRef.current = { list, setList }
  }

  // We need a ref to pass list/setList through the async gap
  const _pendingBulkRef = useRef<{ list: string[]; setList: (l: string[]) => void } | null>(null)
  const _bulkTokenRef = useRef(0)

  // Support dialog
  const [supportDialog, setSupportDialog] = useState<'help' | 'feedback' | 'compatibility' | 'legal' | null>(null)
  // Support email is configurable in the Console (Company Profile); fall back to the default.
  const [supportEmail, setSupportEmail] = useState(DEFAULT_SUPPORT_EMAIL)
  useEffect(() => {
    supabase.from('kaizen_console_settings').select('support_email').eq('id', true).maybeSingle()
      .then(({ data }) => { if (data?.support_email) setSupportEmail(data.support_email) })
  }, [])

  async function confirmBulkDelete() {
    if (!bulkConfirm || !_pendingBulkRef.current) return
    const { dbKey, indices, items, affectedCases } = bulkConfirm
    const { list, setList } = _pendingBulkRef.current
    const updated = list.filter((_, i) => !indices.includes(i))
    try {
      await saveList(dbKey, updated)
      setList(updated)

      // Create a notification for super admin if cases are affected
      if (affectedCases > 0 && profile) {
        const listLabel = dbKey === 'custom_locations' ? 'location' : dbKey === 'custom_categories' ? 'category' : 'department'
        const admins = await supabase.from('kaizen_profiles').select('id').eq('role', 'super_admin').eq('company_id', companyId ?? '')
        const notifications = (admins.data || []).map((a: { id: string }) => ({
          user_id: a.id,
          case_id: null,
          title: `Incomplete cases detected`,
          message: `${affectedCases} open case${affectedCases > 1 ? 's' : ''} ${affectedCases > 1 ? 'have' : 'has'} a ${listLabel} that was removed: ${items.join(', ')}. Please update the affected cases.`,
          is_read: false,
          notification_type: 'incomplete_case',
          title_key: 'settings_items_removed',
          body_params: { count: affectedCases, kind: listLabel, items: items.join(', ') },
        }))
        if (notifications.length > 0) {
          // Notification failure must not mask a successful deletion — separate try/catch
          try { await supabase.from('kaizen_notifications').insert(notifications) }
          catch (notifErr) { console.error('[confirmBulkDelete:notify]', notifErr) }
        }
      }

      toast.success(lang === 'th' ? `ลบ ${items.length} รายการแล้ว` : `Removed ${items.length} item${items.length > 1 ? 's' : ''}.`)
      setBulkConfirm(null)
    } catch (err) {
      console.error('[confirmBulkDelete]', err)
      toast.error(lang === 'th' ? 'ลบไม่สำเร็จ กรุณาลองใหม่' : 'Delete failed. Please try again.')
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  const [customPrimary, setCustomPrimary] = useState(settings.primary_color)
  const [customAccent, setCustomAccent] = useState(settings.accent_color)
  const [customSidebar, setCustomSidebar] = useState(settings.sidebar_color)
  const [savingTheme, setSavingTheme] = useState(false)

  // ThemeContext starts on DEFAULT_SETTINGS and loads the company's real theme
  // asynchronously. Re-seed the pickers when that resolves, otherwise clicking
  // "Apply Theme" would overwrite the saved colors with the cyan defaults.
  useEffect(() => {
    setCustomPrimary(settings.primary_color)
    setCustomAccent(settings.accent_color)
    setCustomSidebar(settings.sidebar_color)
  }, [settings.primary_color, settings.accent_color, settings.sidebar_color])

  async function handleChangePassword() {
    if (!newPassword || !confirmPassword) { toast.error(lang === 'th' ? 'กรุณากรอกรหัสผ่านและยืนยันรหัสผ่านให้ครบ' : 'Please fill in both password fields.'); return }
    const pwdErr = validatePassword(newPassword)
    if (pwdErr) { toast.error(lang === 'th' ? 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' : pwdErr); return }
    const matchErr = validatePasswordsMatch(newPassword, confirmPassword)
    if (matchErr) { toast.error(t.settings.mismatch); return }
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
      // Custom colours only cover primary / accent / sidebar. The page
      // background (and the dark "console" mode) is reserved for Special
      // Presets, so applying custom colours always reverts the background to
      // the basic light canvas.
      await updateSettings({ primary_color: customPrimary, accent_color: customAccent, sidebar_color: customSidebar, background_color: '#f9fafb' })
      toast.success(t.settings.themeApplied)
    } catch {
      toast.error(t.settings.failedTheme)
    } finally {
      setSavingTheme(false)
    }
  }

  async function applyPreset(preset: typeof PRESET_COLORS[0]) {
    setCustomPrimary(preset.primary)
    setCustomAccent(preset.accent)
    setCustomSidebar(preset.sidebar)
    try {
      // Special presets also set the page background (background has no manual picker).
      await updateSettings({ primary_color: preset.primary, accent_color: preset.accent, sidebar_color: preset.sidebar, background_color: preset.background })
      toast.success(lang === 'th' ? `ใช้ธีม "${preset.label}" แล้ว` : `Applied "${preset.label}" theme.`)
    } catch {
      toast.error(t.settings.failedTheme)
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.settings.title}</h1>
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
              title={lang === 'th' ? 'แก้ไขโปรไฟล์' : 'Edit profile'}
            >
              <Pencil className="h-4 w-4" />
            </button>
          ) : (
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={saveProfile}
                disabled={savingProfile}
                className="p-1.5 rounded-lg hover:bg-green-50 transition-colors text-green-600"
                title={lang === 'th' ? 'บันทึก' : 'Save'}
              >
                {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
              <button
                onClick={cancelProfileEdit}
                className="p-1.5 rounded-lg hover:bg-red-50 transition-colors text-gray-400 hover:text-red-500"
                title={lang === 'th' ? 'ยกเลิก' : 'Cancel'}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Avatar */}
        <div className="flex flex-col items-center mb-6">
          <div
            className="relative group cursor-pointer"
            onClick={() => avatarInputRef.current?.click()}
          >
            <div className="w-20 h-20 rounded-full overflow-hidden bg-[var(--brand-primary)]/10 border-2 border-[var(--brand-primary)]/20 flex items-center justify-center">
              {avatarUrl ? (
                <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                <span className="text-2xl font-bold text-[var(--brand-primary)]">
                  {getInitials(profile?.full_name ?? '')}
                </span>
              )}
            </div>
            <div className="absolute inset-0 rounded-full bg-black/45 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              {uploadingAvatar
                ? <Loader2 className="h-5 w-5 animate-spin text-white" />
                : <Camera className="h-5 w-5 text-white" />}
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            {uploadingAvatar ? (lang === 'th' ? 'กำลังอัปโหลด…' : 'Uploading…') : (lang === 'th' ? 'แตะเพื่อเปลี่ยนรูป' : 'Tap to change photo')}
          </p>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarUpload}
          />
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
            <p className="font-medium text-gray-900">{profile ? (DEPARTMENT_LABELS[profile.department] ?? profile.department) : ''}</p>
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
                  placeholder={lang === 'th' ? 'ชื่อผู้ใช้' : 'username'}
                />
              ) : (
                <p className="font-medium text-gray-900">@{profile?.username}</p>
              )}
            </div>
          )}

          {/* Email — read only */}
          {profile?.email && (
            <div>
              <p className="text-gray-500 text-xs mb-1">{lang === 'th' ? 'อีเมล' : 'Email'}</p>
              <p className="font-medium text-gray-900 truncate">{profile.email}</p>
            </div>
          )}
        </div>
      </div>

      {/* Change password */}
      <CollapsibleCard icon={Lock} title={t.settings.changePassword}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t.settings.newPassword}</Label>
            <div className="relative">
              <Input
                type={showNew ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={lang === 'th' ? 'อย่างน้อย 8 ตัวอักษร' : 'Min. 8 characters'}
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
              placeholder={lang === 'th' ? 'กรอกรหัสผ่านใหม่อีกครั้ง' : 'Repeat your new password'}
            />
          </div>
          <Button onClick={handleChangePassword} disabled={changingPassword}>
            {changingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : t.settings.updatePassword}
          </Button>
        </div>
      </CollapsibleCard>

      {/* Push Notifications */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-1">
          <BellRing className="h-4 w-4 text-gray-400" />
          <h2 className="font-semibold text-gray-900">{lang === 'th' ? 'การแจ้งเตือน' : 'Push Notifications'}</h2>
        </div>
        <p className="text-xs text-gray-400 mb-5">
          {lang === 'th'
            ? 'รับการแจ้งเตือนบนอุปกรณ์นี้แม้ปิดแอปแล้ว'
            : 'Receive alerts on this device even when the app is closed.'}
        </p>

        {/* iOS not installed — show step-by-step install guide */}
        {pushIsIOS && !pushIsStandalone ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
            <p className="text-sm font-semibold text-amber-800">
              {lang === 'th' ? '📲 เพิ่มแอปไปยังหน้าจอหลักก่อน' : '📲 Install the app first'}
            </p>
            <p className="text-xs text-amber-700">
              {lang === 'th'
                ? 'iPhone ต้องการให้ติดตั้งแอปบนหน้าจอหลักก่อนถึงจะรับ Push Notification ได้'
                : 'iPhone requires the app to be installed on your Home Screen before push notifications can be enabled.'}
            </p>
            <ol className="space-y-2">
              {[
                lang === 'th' ? '1. แตะปุ่ม Share (กล่องมีลูกศรขึ้น) ที่แถบด้านล่างของ Safari' : '1. Tap the Share button (box with arrow) in Safari\'s bottom bar',
                lang === 'th' ? '2. เลื่อนลงแล้วแตะ "Add to Home Screen"' : '2. Scroll down and tap "Add to Home Screen"',
                lang === 'th' ? '3. แตะ "Add" มุมขวาบน' : '3. Tap "Add" in the top-right corner',
                lang === 'th' ? '4. เปิดแอป Kaizen จากหน้าจอหลัก แล้วกลับมาที่ Settings เพื่อเปิดการแจ้งเตือน' : '4. Open Kaizen from your Home Screen, then return here to enable notifications',
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-amber-800">
                  <span className="font-semibold flex-shrink-0">{step}</span>
                </li>
              ))}
            </ol>
          </div>

        ) : pushStatus === 'denied' ? (
          /* Blocked by browser */
          <div className="flex items-start gap-3 p-3 bg-red-50 rounded-lg border border-red-100">
            <BellOff className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-700">
                {lang === 'th' ? 'ถูกบล็อกโดยระบบ' : 'Blocked by system'}
              </p>
              <p className="text-xs text-red-500 mt-0.5">
                {lang === 'th'
                  ? 'ไปที่ Settings → Kaizen → Notifications เพื่อเปิดใช้งาน'
                  : 'Go to Settings → Kaizen → Notifications to allow.'}
              </p>
            </div>
          </div>

        ) : pushStatus === 'unsupported' ? (
          /* Non-iOS unsupported browser */
          <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
            <BellOff className="h-4 w-4 text-gray-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-gray-500">
              {lang === 'th'
                ? 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน'
                : 'This browser does not support push notifications.'}
            </p>
          </div>

        ) : (
          /* Supported — show toggle */
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {pushStatus === 'granted'
                ? <Bell className="h-5 w-5 text-[var(--brand-primary)]" />
                : <BellOff className="h-5 w-5 text-gray-300" />}
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {lang === 'th' ? 'อนุญาต Push Notification' : 'Allow Push Notifications'}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {pushStatus === 'granted'
                    ? (lang === 'th' ? 'เปิดอยู่ — แจ้งเตือนแม้ปิดแอป' : 'On — alerts even when app is closed')
                    : (lang === 'th' ? 'แตะเพื่อเปิดการแจ้งเตือน' : 'Tap to enable')}
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={pushStatus === 'granted'}
              disabled={pushStatus === 'loading'}
              onClick={async () => {
                if (pushStatus === 'granted') {
                  await unsubscribe()
                  toast.success(lang === 'th' ? 'ปิดการแจ้งเตือนแล้ว' : 'Push notifications off')
                } else {
                  const ok = await subscribe()
                  if (ok) toast.success(lang === 'th' ? 'เปิดการแจ้งเตือนสำเร็จ!' : 'Push notifications on!')
                  else toast.error(lang === 'th' ? 'ไม่สามารถเปิดได้' : 'Could not enable.')
                }
              }}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${
                pushStatus === 'granted' ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'
              }`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
                pushStatus === 'granted' ? 'translate-x-6' : 'translate-x-1'
              }`}>
                {pushStatus === 'loading' && <Loader2 className="h-3 w-3 animate-spin text-gray-400 m-1" />}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* ── Notification coverage — Top Management (super_admin) only ── */}
      {profile?.role === 'super_admin' && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center gap-2 mb-1">
            <BellRing className="h-4 w-4 text-gray-400" />
            <h2 className="font-semibold text-gray-900">{lang === 'th' ? 'ความครอบคลุมการแจ้งเตือน' : 'Notification Coverage'}</h2>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            {lang === 'th'
              ? 'สมาชิกที่ยังไม่ได้เปิด Push จะได้รับการแจ้งเตือนในแอปเท่านั้น ไม่ได้รับบนอุปกรณ์'
              : 'Members without push enabled still get in-app alerts, but no notification on their device.'}
          </p>
          {pushCovErr ? (
            <p className="text-sm text-gray-400">{lang === 'th' ? 'โหลดข้อมูลไม่สำเร็จ' : 'Could not load coverage.'}</p>
          ) : pushCoverage === null ? (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />{lang === 'th' ? 'กำลังโหลด...' : 'Loading...'}
            </div>
          ) : (() => {
            const total = pushCoverage.length
            const covered = pushCoverage.filter(r => r.has_push).length
            const missing = pushCoverage.filter(r => !r.has_push)
            const pct = total ? Math.round((covered / total) * 100) : 0
            const byDept: Record<string, PushCoverageRow[]> = {}
            missing.forEach(r => { const d = r.department || 'other'; (byDept[d] ??= []).push(r) })
            return (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-900">
                    {covered}/{total} {lang === 'th' ? 'เปิดใช้งานบนอุปกรณ์' : 'devices enabled'}
                  </span>
                  <span className="text-xs text-gray-400">{pct}%</span>
                </div>
                <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden mb-4">
                  <div className="h-full bg-[var(--brand-primary)]" style={{ width: `${pct}%` }} />
                </div>
                {missing.length === 0 ? (
                  <p className="text-sm text-green-600">
                    {lang === 'th' ? 'ทุกคนเปิดการแจ้งเตือนบนอุปกรณ์แล้ว 🎉' : 'Everyone has device notifications enabled 🎉'}
                  </p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs font-medium text-gray-500">
                      {lang === 'th' ? `ยังไม่ได้เปิด (${missing.length})` : `Not enabled (${missing.length})`}
                    </p>
                    {Object.entries(byDept).map(([dept, members]) => (
                      <div key={dept}>
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
                          {DEPARTMENT_LABELS[dept as Department] ?? dept}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {members.map(m => (
                            <span key={m.user_id} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                              <BellOff className="h-3 w-3 text-gray-400" />{m.full_name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* Language */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-base">🌐</span>
          <h2 className="font-semibold text-gray-900">{lang === 'th' ? 'ภาษา' : 'Language'}</h2>
        </div>
        <p className="text-xs text-gray-400 mb-5">
          {lang === 'th' ? 'เลือกภาษาที่ใช้แสดงผลในแอป' : 'Choose the display language for the app.'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {([['en', 'English', 'EN'] , ['th', 'ภาษาไทย', 'TH']] as const).map(([code, label, badge]) => (
            <button
              key={code}
              onClick={() => setLang(code)}
              className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                lang === code
                  ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                lang === code ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-500'
              }`}>{badge}</span>
              <span className={`text-sm font-medium ${lang === code ? 'text-[var(--brand-primary)]' : 'text-gray-700'}`}>
                {label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Editable Lists — super_admin only ── */}
      {profile?.role === 'super_admin' && (() => {
        const TABS = [
          { key: 'dept', label: lang === 'th' ? 'แผนก' : 'Departments',  count: deptList.length },
          { key: 'cat',  label: lang === 'th' ? 'หมวดหมู่' : 'Categories', count: catList.length },
          { key: 'loc',  label: lang === 'th' ? 'สถานที่' : 'Locations',   count: locList.length },
        ] as const
        type TabKey = 'dept' | 'cat' | 'loc'

        const tabProps: Record<TabKey, object> = {
          dept: {
            items: deptList, newValue: newDept, onNewChange: setNewDept,
            onAdd: () => addItem('custom_departments', newDept, deptList, setDeptList, setNewDept),
            onRemove: (i: number) => removeItem('custom_departments', i, deptList, setDeptList),
            onBulkRemove: (indices: number[]) => handleBulkRemove('dept', 'custom_departments', indices, deptList, setDeptList),
            editingItem: editingItem?.key === 'dept' ? editingItem : null,
            onStartEdit: (i: number, v: string) => startEdit('dept', i, v),
            onEditChange: (v: string) => setEditingItem(e => e ? { ...e, value: v } : null),
            onConfirmEdit: () => confirmEdit(deptList, setDeptList, 'custom_departments'),
            onCancelEdit: () => setEditingItem(null),
            placeholder: lang === 'th' ? 'เพิ่มแผนกใหม่...' : 'Add department...',
          },
          cat: {
            items: catList, newValue: newCat, onNewChange: setNewCat,
            onAdd: () => addItem('custom_categories', newCat, catList, setCatList, setNewCat),
            onRemove: (i: number) => removeItem('custom_categories', i, catList, setCatList),
            onBulkRemove: (indices: number[]) => handleBulkRemove('cat', 'custom_categories', indices, catList, setCatList),
            editingItem: editingItem?.key === 'cat' ? editingItem : null,
            onStartEdit: (i: number, v: string) => startEdit('cat', i, v),
            onEditChange: (v: string) => setEditingItem(e => e ? { ...e, value: v } : null),
            onConfirmEdit: () => confirmEdit(catList, setCatList, 'custom_categories'),
            onCancelEdit: () => setEditingItem(null),
            placeholder: lang === 'th' ? 'เพิ่มหมวดหมู่ใหม่...' : 'Add category...',
          },
          loc: {
            items: locList, newValue: newLoc, onNewChange: setNewLoc,
            onAdd: () => addItem('custom_locations', newLoc, locList, setLocList, setNewLoc),
            onRemove: (i: number) => removeItem('custom_locations', i, locList, setLocList),
            onBulkRemove: (indices: number[]) => handleBulkRemove('loc', 'custom_locations', indices, locList, setLocList),
            editingItem: editingItem?.key === 'loc' ? editingItem : null,
            onStartEdit: (i: number, v: string) => startEdit('loc', i, v),
            onEditChange: (v: string) => setEditingItem(e => e ? { ...e, value: v } : null),
            onConfirmEdit: () => confirmEdit(locList, setLocList, 'custom_locations'),
            onCancelEdit: () => setEditingItem(null),
            placeholder: lang === 'th' ? 'เพิ่มสถานที่ใหม่...' : 'Add location...',
          },
        }

        return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {/* Tab bar */}
            <div className="flex border-b border-gray-200">
              {TABS.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveListTab(tab.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-medium transition-colors border-b-2 ${
                    activeListTab === tab.key
                      ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {tab.label}
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                    activeListTab === tab.key ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]' : 'bg-gray-100 text-gray-500'
                  }`}>{tab.count}</span>
                </button>
              ))}
            </div>

            {/* Active tab content */}
            <div className="p-4">
              <EditableListCard
                key={activeListTab}
                {...(tabProps[activeListTab] as EditableListCardProps)}
                lang={lang}
                maxVisible={3}
              />
            </div>
          </div>
        )
      })()}

      {/* Bulk delete confirmation dialog — outside IIFE so it's always mounted */}
      <Dialog open={!!bulkConfirm} onOpenChange={(open) => { if (!open) setBulkConfirm(null) }}>
        <DialogContent className="max-w-sm mx-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              {lang === 'th' ? 'ยืนยันการลบ' : 'Confirm Removal'}
            </DialogTitle>
            <DialogDescription className="text-left space-y-2 pt-1">
              {bulkConfirm?.checking ? (
                <span className="flex items-center gap-2 text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" />{lang === 'th' ? 'กำลังตรวจสอบเคสที่ได้รับผลกระทบ…' : 'Checking for affected cases…'}
                </span>
              ) : (
                <>
                  <p>{lang === 'th' ? <>คุณกำลังจะลบ <strong>{bulkConfirm?.items.length} รายการ</strong>:</> : <>You are about to remove <strong>{bulkConfirm?.items.length} item{(bulkConfirm?.items.length ?? 0) > 1 ? 's' : ''}</strong>:</>}</p>
                  <ul className="text-sm text-gray-600 list-disc pl-4 max-h-32 overflow-y-auto">
                    {bulkConfirm?.items.map(item => <li key={item}>{item}</li>)}
                  </ul>
                  {(bulkConfirm?.affectedCases ?? 0) > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-2">
                      <p className="text-amber-800 text-sm font-medium">
                        {lang === 'th'
                          ? `⚠️ มี ${bulkConfirm?.affectedCases} เคสที่เปิดอยู่ใช้ค่านี้`
                          : `⚠️ ${bulkConfirm?.affectedCases} open case${(bulkConfirm?.affectedCases ?? 0) > 1 ? 's' : ''} use${(bulkConfirm?.affectedCases ?? 0) === 1 ? 's' : ''} this value.`}
                      </p>
                      <p className="text-amber-700 text-xs mt-1">
                        {lang === 'th'
                          ? 'ระบบจะส่งการแจ้งเตือนไปยัง Super Admin ทุกคนเพื่ออัปเดตเคสที่ได้รับผลกระทบ'
                          : 'A notification will be sent to all Super Admins to update the affected cases.'}
                      </p>
                    </div>
                  )}
                  {(bulkConfirm?.affectedCases ?? 0) === 0 && (
                    <p className="text-gray-500 text-sm">{lang === 'th' ? 'ไม่มีเคสที่เปิดอยู่ได้รับผลกระทบ' : 'No open cases are affected.'}</p>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setBulkConfirm(null)}>{lang === 'th' ? 'ยกเลิก' : 'Cancel'}</Button>
            <Button variant="destructive" onClick={confirmBulkDelete} disabled={bulkConfirm?.checking}>
              {bulkConfirm?.checking ? <Loader2 className="h-4 w-4 animate-spin" /> : (lang === 'th' ? 'ลบ' : 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Companies — founder only ── */}
      {profile?.email === 'poti@nanirand.com' && <CompaniesSection />}

      {/* ── Preventive Maintenance — Top Management, PMS add-on only ── */}
      {profile?.role === 'super_admin' && companyHasAddon(activeCompany, 'pms') && (
        <CollapsibleCard icon={Wrench} title={lang === 'th' ? 'การบำรุงรักษาเชิงป้องกัน' : 'Preventive Maintenance'}>
          <PMSettings />
          <div className="border-t border-gray-100 my-6" />
          <PMEquipmentTypes />
        </CollapsibleCard>
      )}

      {/* ── Routine Roster (incl. Room Setup) — Top Management, Routine Roster add-on only ── */}
      {(profile?.role === 'super_admin' || profile?.role === 'manager') && companyHasAddon(activeCompany, 'routine_roster') && (
        <CollapsibleCard icon={ClipboardList} title={lang === 'th' ? 'ตารางงานประจำ' : 'Routine Roster'}>
          <RRSettings />
          <div className="border-t border-gray-100 my-6" />
          <RoomSetupSettings />
          <div className="border-t border-gray-100 my-6" />
          <RoomRecipesSettings />
          <div className="border-t border-gray-100 my-6" />
          <RoomMonitorAccessSettings />
          <div className="border-t border-gray-100 my-6" />
          <SpecialApprovalSettings />
          <div className="border-t border-gray-100 my-6" />
          <RoomNotifySettings />
          <div className="border-t border-gray-100 my-6" />
          <RrFoAccessSettings />
        </CollapsibleCard>
      )}

      {/* ── Performance Scoring — Top Management only ── */}
      {profile?.role === 'super_admin' && (
        <CollapsibleCard icon={SlidersHorizontal} title={t.settings.scoringTitle}>
          <PerfScoringSettings />
        </CollapsibleCard>
      )}

      {/* ── Multi-Department Manager — super_admin only ── */}
      {profile?.role === 'super_admin' && (
        <CollapsibleCard icon={Users} title={lang === 'th' ? 'ผู้จัดการหลายแผนก' : 'Multi-Department Managers'}>
          <MultiDeptManagersSection companyId={activeCompany?.id ?? null} />
        </CollapsibleCard>
      )}

      {/* Theme settings — super admin only, and only if the package includes it */}
      {profile?.role === 'super_admin' && companyHasFeature(activeCompany, 'custom_theme') && (
      <CollapsibleCard icon={Palette} title={t.settings.theme}>
        {/* Presets */}
        <div className="mb-5">
          <p className="text-xs text-gray-500 mb-2 font-medium">{t.settings.presets}</p>
          <div className="grid grid-cols-3 gap-2">
            {PRESET_COLORS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => profile?.role === 'super_admin' && applyPreset(preset)}
                disabled={profile?.role !== 'super_admin'}
                className="flex flex-col items-center gap-1.5 p-2 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <div className="flex gap-1">
                  <div className="w-4 h-4 rounded-sm" style={{ background: preset.primary }} />
                  <div className="w-4 h-4 rounded-sm" style={{ background: preset.accent }} />
                  <div className="w-4 h-4 rounded-sm" style={{ background: preset.sidebar }} />
                  <div className="w-4 h-4 rounded-sm border border-gray-200" style={{ background: preset.background }} title="Background" />
                </div>
                <span className="text-xs text-gray-700 text-center truncate max-w-full">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Custom colors */}
        <div className="space-y-4">
          <p className="text-xs text-gray-500 font-medium">{lang === 'th' ? 'สีที่กำหนดเอง' : 'Custom Colors'}</p>
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
      </CollapsibleCard>
      )}
      {/* ── Support ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-6 pt-6 pb-3">
          <LifeBuoy className="h-4 w-4 text-gray-400" />
          <h2 className="font-semibold text-gray-900">{lang === 'th' ? 'ฝ่ายสนับสนุน' : 'Support'}</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {/* Packages & Expansions — first; navigates to its own page; hidden for staff */}
          {profile?.role !== 'staff' && (
            <button onClick={() => navigate('/packages')} className="w-full flex items-center gap-3 px-6 py-3.5 hover:bg-gray-50 transition-colors text-left">
              <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)]/10 flex items-center justify-center flex-shrink-0">
                <Sparkles className="h-4 w-4 text-[var(--brand-primary)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{lang === 'th' ? 'แพ็กเกจและส่วนเสริม' : 'Packages & Expansions'}</p>
                <p className="text-xs text-gray-400">{lang === 'th' ? 'แผน อัปเกรด และส่วนเสริม' : 'Your plan, upgrades & add-ons'}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-gray-300 flex-shrink-0" />
            </button>
          )}
          {[
            { key: 'help' as const, icon: HelpCircle, label: lang === 'th' ? 'ช่วยเหลือ' : 'Help', sub: lang === 'th' ? 'ต้องการความช่วยเหลือ' : 'Get assistance from our team' },
            { key: 'feedback' as const, icon: MessageSquare, label: lang === 'th' ? 'ข้อเสนอแนะ' : 'Feedback', sub: lang === 'th' ? 'แบ่งปันความคิดเห็นของคุณ' : 'Share your thoughts with us' },
            { key: 'compatibility' as const, icon: Smartphone, label: lang === 'th' ? 'ความเข้ากันได้' : 'Compatibility', sub: lang === 'th' ? 'อุปกรณ์ที่รองรับ' : 'Supported devices & browsers' },
            { key: 'legal' as const, icon: Scale, label: lang === 'th' ? 'ทรัพย์สินทางปัญญา' : 'Intellectual Property', sub: lang === 'th' ? 'สิทธิ์การใช้งานและลิขสิทธิ์' : 'Right of use & ownership' },
          ].map(({ key, icon: Icon, label, sub }) => (
            <button
              key={key}
              onClick={() => setSupportDialog(key)}
              className="w-full flex items-center gap-3 px-6 py-3.5 hover:bg-gray-50 transition-colors text-left"
            >
              <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                <Icon className="h-4 w-4 text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{label}</p>
                <p className="text-xs text-gray-400">{sub}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-gray-300 flex-shrink-0" />
            </button>
          ))}
        </div>
      </div>

      {/* Support dialogs */}
      <Dialog open={!!supportDialog} onOpenChange={(open) => { if (!open) setSupportDialog(null) }}>
        <DialogContent className="max-w-sm mx-4">
          {supportDialog === 'help' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <HelpCircle className="h-5 w-5 text-[var(--brand-primary)]" />
                  {lang === 'th' ? 'ช่วยเหลือ' : 'Help'}
                </DialogTitle>
                <DialogDescription className="text-left pt-1">
                  {lang === 'th'
                    ? 'เราพร้อมช่วยเหลือคุณ โปรดแจ้งให้เราทราบว่าเราสามารถช่วยอะไรได้บ้าง แล้วทีมงานของเราจะติดต่อกลับโดยเร็วที่สุด'
                    : "We're here to help. Let us know what you need a hand with and our team will get back to you as soon as we can."}
                </DialogDescription>
              </DialogHeader>
              <div className="bg-gray-50 rounded-lg px-3 py-2.5 flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-gray-400 flex-shrink-0" />
                <span className="text-gray-700 font-medium">{supportEmail}</span>
              </div>
              <DialogFooter>
                <a href={`mailto:${supportEmail}?subject=${encodeURIComponent('Kaizen — Help Request')}`} className="w-full">
                  <Button className="w-full"><Mail className="h-4 w-4" />{lang === 'th' ? 'ส่งอีเมล' : 'Send Email'}</Button>
                </a>
              </DialogFooter>
            </>
          )}

          {supportDialog === 'feedback' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-[var(--brand-primary)]" />
                  {lang === 'th' ? 'ข้อเสนอแนะ' : 'Feedback'}
                </DialogTitle>
                <DialogDescription className="text-left pt-1">
                  {lang === 'th'
                    ? 'เราอ่านและพิจารณาทุกอีเมล ความคิดเห็นของคุณช่วยให้ Kaizen System ดีขึ้น'
                    : 'We read and consider every message. Your feedback helps make Kaizen System better.'}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <a href={`mailto:${supportEmail}?subject=${encodeURIComponent('Kaizen — Feedback')}`} className="w-full">
                  <Button className="w-full"><Mail className="h-4 w-4" />{lang === 'th' ? 'ส่งอีเมล' : 'Send Email'}</Button>
                </a>
              </DialogFooter>
            </>
          )}

          {supportDialog === 'compatibility' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Smartphone className="h-5 w-5 text-[var(--brand-primary)]" />
                  {lang === 'th' ? 'ความเข้ากันได้' : 'Compatibility'}
                </DialogTitle>
                <DialogDescription className="text-left pt-1 space-y-2">
                  <span className="block">
                    {lang === 'th'
                      ? 'Kaizen System เป็นเว็บแอป (PWA) ที่ทำงานได้ทั้งบนมือถือและคอมพิวเตอร์ เพื่อประสบการณ์ที่ดีที่สุด ให้เปิดในเบราว์เซอร์แล้วเพิ่มลงในหน้าจอหลัก แอปจะทำงานแบบเต็มหน้าจอเหมือนแอปทั่วไป'
                      : 'Kaizen System is a Progressive Web App (PWA) that runs smoothly on both mobile devices and desktops. For the best experience, open it in your browser and add it to your home screen — it will then run full-screen like a native app, with offline support and push notifications.'}
                  </span>
                  <span className="block text-gray-400">
                    {lang === 'th'
                      ? 'แนะนำ: iPhone (iOS 16.4 ขึ้นไป, Safari) หรือ Android (10 ขึ้นไป, Chrome)'
                      : 'Recommended: iPhone on iOS 16.4+ (Safari) or Android 10+ (Chrome).'}
                  </span>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" className="w-full" onClick={() => setSupportDialog(null)}>{lang === 'th' ? 'ปิด' : 'Close'}</Button>
              </DialogFooter>
            </>
          )}

          {supportDialog === 'legal' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Scale className="h-5 w-5 text-[var(--brand-primary)]" />
                  {lang === 'th' ? 'ทรัพย์สินทางปัญญาและสิทธิการใช้งาน' : 'Intellectual Property & Right of Use'}
                </DialogTitle>
              </DialogHeader>
              <div className="text-xs text-gray-500 space-y-3 leading-relaxed text-left max-h-[55vh] overflow-y-auto">
                <p>
                  {lang === 'th'
                    ? 'สิทธิในทรัพย์สินทางปัญญาทั้งหมดที่เกี่ยวข้องกับแอปพลิเคชันนี้ รวมถึงแต่ไม่จำกัดเพียงซอฟต์แวร์ ซอร์สโค้ด การออกแบบระบบ ส่วนติดต่อผู้ใช้ ตรรกะการทำงาน โครงสร้างฐานข้อมูล เอกสาร ชื่อ โลโก้ และวัสดุที่เกี่ยวข้อง ยังคงเป็นกรรมสิทธิ์โดยเฉพาะของ '
                    : 'All intellectual property rights relating to this application, including but not limited to its software, source code, system design, user interface, workflow logic, database structure, documentation, name, logo, and related materials, shall remain the exclusive property of '}
                  <span className="font-semibold text-gray-700">NNR-Solutions Co., Ltd.</span>
                </p>
                <p>
                  {lang === 'th'
                    ? 'ผู้ใช้ที่ได้รับอนุญาตได้รับสิทธิในการเข้าถึงและใช้งานแอปพลิเคชันอย่างจำกัด ไม่ผูกขาด ไม่สามารถโอนสิทธิ์ และเพิกถอนได้ เพื่อการมอบหมายงานซ่อมบำรุง การติดตาม การรายงาน และวัตถุประสงค์ในการดำเนินงานที่เกี่ยวข้องเท่านั้น สิทธิการใช้งานนี้ไม่ได้โอนกรรมสิทธิ์ใด ๆ ในแอปพลิเคชันให้แก่ผู้ใช้ องค์กร ผู้รับเหมา ช่างเทคนิค หรือบุคคลภายนอก'
                    : 'Authorised users are granted a limited, non-exclusive, non-transferable, and revocable right to access and use the application solely for maintenance job assignment, monitoring, reporting, and related operational purposes. This right of use does not transfer any ownership rights in the application to any user, organisation, contractor, technician, or third party.'}
                </p>
                <p>
                  {lang === 'th'
                    ? 'ผู้ใช้ต้องไม่คัดลอก แก้ไข ทำซ้ำ เผยแพร่ จำหน่าย ให้สิทธิช่วง ทำวิศวกรรมย้อนกลับ ถอดรหัส หรือสร้างงานดัดแปลงจากแอปพลิเคชัน ไม่ว่าทั้งหมดหรือบางส่วน โดยไม่ได้รับอนุญาตเป็นลายลักษณ์อักษรล่วงหน้าจาก '
                    : 'Users shall not copy, modify, reproduce, distribute, sell, sublicense, reverse-engineer, decompile, or create derivative works from the application, in whole or in part, without prior written permission from '}
                  <span className="font-semibold text-gray-700">NNR-Solutions Co., Ltd.</span>
                </p>
                <div className="flex justify-center pt-3 pb-1">
                  <div className="bg-white rounded-lg p-3 flex items-center justify-center">
                    <img
                      src="/nnr-solutions-logo.png"
                      alt="NNR-Solutions Co., Ltd."
                      className="h-[104px] w-auto object-contain"
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" className="w-full" onClick={() => setSupportDialog(null)}>{lang === 'th' ? 'ปิด' : 'Close'}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Copyright footer */}
      <p className="text-center text-[11px] text-gray-400 leading-relaxed px-4 pb-2">
        Kaizen System V.1.2 by NNR-Solutions {new Date().getFullYear()} ©
      </p>

    </div>
  )
}

// ── MultiDeptManagersSection ─────────────────────────────────────────────────
// label→slug map for converting custom_departments label strings back to Department slugs
const LABEL_TO_DEPT_VALUE = Object.fromEntries(DEPARTMENTS.map((d) => [d.label, d.value])) as Record<string, string>

function MultiDeptManagersSection({ companyId }: { companyId: string | null }) {
  const [managers, setManagers] = React.useState<KaizenProfile[]>([])
  const [saving, setSaving] = React.useState<string | null>(null)
  // SP-BUG-01: this section rendered "No managers found in this company." the
  // instant it mounted, before the fetch below had a chance to resolve — a
  // company that genuinely has managers still flashed (or, on a slow
  // connection, sat on) the empty-state message.
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState(false)
  // Full company department list (built-in + custom). value is the DB-stored identifier.
  // SP-003: exclude top_management — managers must not be assignable to it as an extra dept
  const [allDepts, setAllDepts] = React.useState<{ value: string; label: string }[]>(
    DEPARTMENTS.filter(d => d.value !== 'top_management')
  )

  React.useEffect(() => {
    if (!companyId) return
    let cancelled = false
    Promise.all([
      supabase.from('kaizen_profiles').select('*').eq('company_id', companyId).eq('role', 'manager').is('deleted_at', null).order('full_name'),
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'custom_departments').maybeSingle(),
    ]).then(([mgrsRes, deptsRes]) => {
      if (cancelled) return
      if (mgrsRes.error) { console.error('[MultiDeptManagers:managers]', mgrsRes.error.message); setLoadError(true); setLoading(false); return }
      setManagers((mgrsRes.data ?? []) as KaizenProfile[])
      if (deptsRes.data?.value) {
        const labels = deptsRes.data.value as string[]
        // SP-003: filter out top_management from the assignable extra-depts list
        setAllDepts(labels.map((label) => ({ value: LABEL_TO_DEPT_VALUE[label] ?? label, label }))
          .filter(d => d.value !== 'top_management'))
      } else {
        setAllDepts(DEPARTMENTS.filter(d => d.value !== 'top_management'))
      }
      setLoading(false)
    }).catch(err => { console.error('[MultiDeptManagers]', err); if (!cancelled) { setLoadError(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [companyId])

  async function toggle(mgr: KaizenProfile, deptValue: string) {
    if (deptValue === mgr.department) return
    setSaving(mgr.id)
    const extras = (mgr.managed_departments ?? []) as string[]
    const next = extras.includes(deptValue)
      ? extras.filter((d) => d !== deptValue)
      : [...extras, deptValue]
    const { error } = await supabase.from('kaizen_profiles').update({ managed_departments: next }).eq('id', mgr.id)
    if (error) {
      toast.error('Failed to save')
    } else {
      setManagers((prev) => prev.map((m) => (m.id === mgr.id ? { ...m, managed_departments: next as Department[] } : m)))
    }
    setSaving(null)
  }

  if (loading) {
    return <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
  }
  if (loadError) {
    return <LoadError compact message="Failed to load managers — please refresh." />
  }
  if (managers.length === 0) {
    return <p className="text-sm text-gray-400 py-2">No managers found in this company.</p>
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Assign extra departments to a manager so they can approve cases, PM tasks, and view staff across those departments in addition to their primary one.
      </p>
      {managers.map((mgr) => {
        const effective = (mgr.managed_departments ?? []) as string[]
        return (
          <div key={mgr.id} className="border border-gray-100 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-gray-400 shrink-0" />
              <span className="font-medium text-sm">{mgr.full_name}</span>
              <span className="text-xs text-gray-400 ml-1">
                ({DEPARTMENT_LABELS[mgr.department] ?? mgr.department})
              </span>
              {saving === mgr.id && <Loader2 className="w-3 h-3 animate-spin ml-auto text-gray-400" />}
            </div>
            <div className="flex flex-wrap gap-2">
              {allDepts.map(({ value, label }) => {
                const isPrimary = value === mgr.department
                const isChecked = isPrimary || effective.includes(value)
                return (
                  <button
                    key={value}
                    disabled={isPrimary || saving === mgr.id}
                    onClick={() => toggle(mgr, value)}
                    className={[
                      'text-xs px-2 py-1 rounded-full border transition-colors',
                      isPrimary
                        ? 'bg-blue-100 border-blue-300 text-blue-700 cursor-default'
                        : isChecked
                        ? 'bg-green-100 border-green-300 text-green-700 hover:bg-green-200'
                        : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100',
                    ].join(' ')}
                  >
                    {isPrimary ? '★ ' : isChecked ? '✓ ' : ''}{label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── CompaniesSection ─────────────────────────────────────────────────────────
import React from 'react'

type AdminProfile = { id: string; full_name: string; email: string | null; company_id: string | null; job_title: string | null }
type AdminLink    = { super_admin_id: string; company_id: string }

function CompaniesSection() {
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const [companies, setCompanies]   = React.useState<KaizenCompany[]>([])
  const [admins, setAdmins]         = React.useState<AdminProfile[]>([])
  const [links, setLinks]           = React.useState<AdminLink[]>([])
  const [loading, setLoading]       = React.useState(true)
  const [expanded, setExpanded]     = React.useState<string | null>(null)

  React.useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: cos }, { data: sas }, { data: ls }] = await Promise.all([
      supabase.from('kaizen_companies').select('*').order('name'),
      supabase.from('kaizen_profiles').select('id, full_name, email, company_id, job_title').eq('role', 'super_admin').order('full_name'),
      supabase.from('kaizen_super_admin_companies').select('super_admin_id, company_id'),
    ])
    setCompanies((cos ?? []) as KaizenCompany[])
    setAdmins((sas ?? []) as AdminProfile[])
    setLinks((ls ?? []) as AdminLink[])
    setLoading(false)
  }

  async function toggleLink(adminId: string, companyId: string, isLinked: boolean) {
    if (isLinked) {
      // Removing a cross-company grant is always safe — the member keeps their
      // home company. (Their home company is not part of `links`.)
      const { error } = await supabase.from('kaizen_super_admin_companies')
        .delete().eq('super_admin_id', adminId).eq('company_id', companyId)
      if (error) { toast.error(error.message); return }
      toast.success(lang === 'th' ? 'ลบสิทธิ์การเข้าถึงแล้ว' : 'Access removed.')
    } else {
      const { error } = await supabase.from('kaizen_super_admin_companies')
        .insert({ super_admin_id: adminId, company_id: companyId })
      if (error) { toast.error(error.message); return }
      // Also update the admin's company_id if they don't have one
      await supabase.from('kaizen_profiles').update({ company_id: companyId })
        .eq('id', adminId).is('company_id', null)
      toast.success(lang === 'th' ? 'เชื่อมโยงผู้ดูแลแล้ว' : 'Admin linked.')
    }
    await fetchAll()
  }

  return (
    <>
      <CollapsibleCard icon={Building2} title={lang === 'th' ? 'บริษัท' : 'Companies'} badge={companies.length} bodyClassName="border-t border-gray-100">
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {companies.map(co => {
              const isExpanded = expanded === co.id
              // Who has access to this company: its Owner + cross-company guests granted access
              const ownerList = admins.filter(a => a.company_id === co.id && a.job_title === 'Owner')
              const guestList = admins.filter(a => a.company_id !== co.id && links.some(l => l.super_admin_id === a.id && l.company_id === co.id))
              const accessList = [...ownerList, ...guestList]
              // The company's Owner may remove granted guests. An Owner runs the
              // company whether homed here or granted access to it.
              const iAmOwner = profile?.job_title === 'Owner' && (
                profile?.company_id === co.id ||
                links.some(l => l.super_admin_id === profile?.id && l.company_id === co.id)
              )
              const companyName = (id: string | null) => companies.find(c => c.id === id)?.name ?? (lang === 'th' ? 'บริษัทอื่น' : 'another company')
              return (
                <div key={co.id}>
                  {/* Company row */}
                  <button
                    onClick={() => setExpanded(isExpanded ? null : co.id)}
                    className="w-full flex items-center gap-3 px-6 py-4 hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="w-9 h-9 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center flex-shrink-0">
                      <Building2 className="h-4 w-4 text-[var(--brand-primary)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{co.name}</p>
                      <p className="text-xs text-gray-400">
                        /{co.slug} · {lang === 'th' ? `${accessList.length} คนเข้าถึงได้` : `${accessList.length} with access`}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium mr-2 ${
                      co.is_active ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400'
                    }`}>
                      {co.is_active ? (lang === 'th' ? 'ใช้งานอยู่' : 'Active') : (lang === 'th' ? 'ปิดใช้งาน' : 'Inactive')}
                    </span>
                    {isExpanded
                      ? <ChevronDown className="h-4 w-4 text-gray-300 flex-shrink-0" />
                      : <ChevronRight className="h-4 w-4 text-gray-300 flex-shrink-0" />}
                  </button>

                  {/* Expanded: admin access panel */}
                  {isExpanded && (
                    <div className="px-6 pb-5 bg-gray-50/60">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 pt-3">
                        {lang === 'th' ? 'สิทธิ์การเข้าถึงของ Super Admin' : 'Super Admin Access'}
                      </p>
                      <div className="space-y-2">
                        {accessList.map(admin => {
                          const isMe    = admin.id === profile?.id
                          const isOwner = admin.company_id === co.id && admin.job_title === 'Owner'
                          return (
                            <div
                              key={admin.id}
                              className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 bg-white transition-colors"
                            >
                              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                                isOwner ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-400'
                              }`}>
                                {admin.full_name.charAt(0).toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">
                                  {admin.full_name}
                                  {isMe && <span className="ml-1.5 text-[10px] text-[var(--brand-primary)] font-semibold">{lang === 'th' ? 'คุณ' : 'You'}</span>}
                                </p>
                                <p className="text-xs text-gray-400 truncate">{admin.email}</p>
                                {!isOwner && (
                                  <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1">
                                    <Building2 className="h-3 w-3" />{lang === 'th' ? `จาก ${companyName(admin.company_id)}` : `from ${companyName(admin.company_id)}`}
                                  </p>
                                )}
                              </div>
                              {isOwner ? (
                                <span className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-200 text-amber-600 bg-amber-50 flex-shrink-0">
                                  {lang === 'th' ? 'เจ้าของ' : 'Owner'}
                                </span>
                              ) : (iAmOwner && !isMe) ? (
                                <button
                                  onClick={() => toggleLink(admin.id, co.id, true)}
                                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition-all flex-shrink-0"
                                >
                                  <UserX className="h-3 w-3" />{lang === 'th' ? 'ลบ' : 'Remove'}
                                </button>
                              ) : (
                                <span className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 bg-gray-50 flex-shrink-0">
                                  {lang === 'th' ? 'ผู้รับเชิญ' : 'Guest'}
                                </span>
                              )}
                            </div>
                          )
                        })}
                        {accessList.length === 0 && (
                          <p className="text-xs text-gray-400 py-2">{lang === 'th' ? 'ยังไม่มีการกำหนดเจ้าของ เจ้าของจะถูกจัดการใน System Console' : 'No owner assigned yet. Owners are managed in the System Console.'}</p>
                        )}
                        {iAmOwner && guestList.length === 0 && ownerList.length > 0 && (
                          <p className="text-[11px] text-gray-400 pt-1">
                            {lang === 'th' ? 'ยังไม่มีผู้ใช้จากบริษัทอื่นได้รับสิทธิ์เข้าถึงบริษัทนี้' : 'No cross-company users have been granted access to this company.'}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CollapsibleCard>
    </>
  )
}

// ── EditableListCard ─────────────────────────────────────────────────────────

interface EditableListCardProps {
  icon?: React.ReactNode
  title?: string
  subtitle?: string
  items: string[]
  newValue: string
  onNewChange: (v: string) => void
  onAdd: () => void
  onRemove: (i: number) => void
  onBulkRemove: (indices: number[]) => void
  editingItem: { index: number; value: string } | null
  onStartEdit: (i: number, v: string) => void
  onEditChange: (v: string) => void
  onConfirmEdit: () => void
  onCancelEdit: () => void
  placeholder: string
  lang: string
  maxVisible?: number
}

function EditableListCard({
  icon, title, subtitle, items, newValue, onNewChange, onAdd, onRemove, onBulkRemove,
  editingItem, onStartEdit, onEditChange, onConfirmEdit, onCancelEdit, placeholder, maxVisible, lang,
}: EditableListCardProps) {
  const [selected, setSelected] = React.useState<Set<number>>(new Set())
  const [showAll, setShowAll] = React.useState(false)
  const visibleItems = maxVisible && !showAll ? items.slice(0, maxVisible) : items
  const hasMore = maxVisible && items.length > maxVisible

  // Reset selection + showAll if items list changes
  React.useEffect(() => { setSelected(new Set()); setShowAll(false) }, [items.length])

  // SP-002b: when the list collapses ("Show less"), drop any selection that is now
  // hidden — otherwise a no-longer-visible item can still be silently bulk-deleted.
  React.useEffect(() => {
    if (maxVisible && !showAll) {
      setSelected(prev => {
        const next = new Set([...prev].filter(i => i < maxVisible))
        return next.size === prev.size ? prev : next
      })
    }
  }, [showAll, maxVisible])

  function toggleSelect(i: number) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  function toggleAll() {
    // SP-002: only select visible items — hidden items must not be silently bulk-deleted
    const visible = maxVisible && !showAll ? items.slice(0, maxVisible) : items
    setSelected(prev =>
      visible.every((_, i) => prev.has(i))
        ? new Set()
        : new Set(visible.map((_, i) => i))
    )
  }

  function handleBulkRemoveClick() {
    onBulkRemove([...selected])
    setSelected(new Set())
  }

  return (
    <div>
      {/* Header — only shown when NOT inside a tabbed layout */}
      {title && (
        <>
          <div className="flex items-center gap-2 mb-1">
            {icon}
            <h2 className="font-semibold text-gray-900">{title}</h2>
            <span className="ml-auto text-xs text-gray-400">{items.length}</span>
          </div>
          <p className="text-xs text-gray-400 mb-3">{subtitle}</p>
        </>
      )}

      {/* Select all row */}
      {items.length > 0 && (
        <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
          <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-500 select-none">
            <input
              type="checkbox"
              checked={(maxVisible && !showAll ? items.slice(0, maxVisible) : items).every((_, i) => selected.has(i)) && items.length > 0}
              onChange={toggleAll}
              className="h-3.5 w-3.5 rounded border-gray-300 accent-[var(--brand-primary)]"
            />
            {lang === 'th' ? 'เลือกทั้งหมด' : 'Select all'}
          </label>
          {selected.size > 0 && (
            <button
              onClick={handleBulkRemoveClick}
              className="flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {lang === 'th' ? `ลบ ${selected.size} รายการที่เลือก` : `Remove ${selected.size} selected`}
            </button>
          )}
        </div>
      )}

      {/* Item list */}
      <div className="space-y-1 mb-3">
        {visibleItems.map((item, i) => (
          <div key={i} className={`flex items-center gap-2 group rounded-lg px-1 ${selected.has(i) ? 'bg-red-50' : ''}`}>
            {/* Checkbox */}
            <input
              type="checkbox"
              checked={selected.has(i)}
              onChange={() => toggleSelect(i)}
              className="h-3.5 w-3.5 flex-shrink-0 rounded border-gray-300 accent-[var(--brand-primary)]"
            />

            {editingItem?.index === i ? (
              <>
                <Input
                  value={editingItem.value}
                  onChange={(e) => onEditChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onConfirmEdit(); if (e.key === 'Escape') onCancelEdit() }}
                  className="flex-1 h-8 text-sm"
                  autoFocus
                />
                <button onClick={onConfirmEdit} className="text-green-600 hover:text-green-700 p-1 flex-shrink-0">
                  <Check className="h-4 w-4" />
                </button>
                <button onClick={onCancelEdit} className="text-gray-400 hover:text-gray-600 p-1 flex-shrink-0">
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <>
                <span className="flex-1 text-sm text-gray-700 py-1 px-1 truncate">{item}</span>
                <button onClick={() => onStartEdit(i, item)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-600 p-1 flex-shrink-0 transition-opacity">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => onRemove(i)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1 flex-shrink-0 transition-opacity">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Show all / Show less */}
      {hasMore && (
        <button
          onClick={() => setShowAll(v => !v)}
          className="w-full text-xs text-[var(--brand-primary)] hover:underline py-1.5 text-center"
        >
          {showAll ? (lang === 'th' ? 'แสดงน้อยลง ↑' : 'Show less ↑') : (lang === 'th' ? `แสดงทั้งหมด ${items.length} ↓` : `Show all ${items.length} ↓`)}
        </button>
      )}

      {/* Add new */}
      <div className="flex gap-2 mt-2">
        <Input
          value={newValue}
          onChange={(e) => onNewChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd() }}
          placeholder={placeholder}
          className="flex-1 h-9"
        />
        <Button size="sm" onClick={onAdd} disabled={!newValue.trim()} className="h-9 px-3 flex-shrink-0">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

// ── PerfScoringSettings ──────────────────────────────────────────────────────
// Top Management adjusts the relative weight of each performance indicator, and
// optionally folds in PMS / Routine Roster reliability. Persists per company in
// kaizen_settings under key 'perf_config' (mirrors the custom_* save pattern).

type WeightRow<K extends string> = { key: K; label: string }

function PerfScoringSettings() {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t } = useLanguage()
  const companyId = activeCompany?.id ?? profile?.company_id ?? null

  const [config, setConfig] = React.useState<PerfConfig>(DEFAULT_PERF_CONFIG)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  const hasPms = companyHasAddon(activeCompany, 'pms')
  const hasRr  = companyHasAddon(activeCompany, 'routine_roster')

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadPerfConfig(companyId).then(cfg => { if (!cancelled) { setConfig(cfg); setLoading(false) } })
    return () => { cancelled = true }
  }, [companyId])

  const staffRows: WeightRow<StaffWeightKey>[] = [
    { key: 'resolution', label: t.perf.resolutionRate },
    { key: 'ontime',     label: t.perf.onTime },
    { key: 'speed',      label: t.perf.speed },
    { key: 'quality',    label: t.perf.quality },
    { key: 'engagement', label: t.perf.engagement },
    ...(config.includePms && hasPms ? [{ key: 'pms' as StaffWeightKey, label: t.perf.pmsScore }] : []),
    ...(config.includeRr && hasRr ? [{ key: 'rr' as StaffWeightKey, label: t.perf.rrScore }] : []),
  ]
  const managerRows: WeightRow<ManagerWeightKey>[] = [
    { key: 'approval',   label: t.perf.approval },
    { key: 'teamres',    label: t.perf.teamRes },
    { key: 'teamsla',    label: t.perf.teamSla },
    { key: 'leadership', label: t.perf.leadership },
    { key: 'oversight',  label: t.perf.oversight },
    ...(config.includePms && hasPms ? [{ key: 'pms' as ManagerWeightKey, label: t.perf.pmsScore }] : []),
    ...(config.includeRr && hasRr ? [{ key: 'rr' as ManagerWeightKey, label: t.perf.rrScore }] : []),
  ]

  function share(weights: number[], w: number): string {
    const sum = weights.reduce((s, x) => s + x, 0)
    return sum > 0 ? `${Math.round((w / sum) * 100)}%` : '0%'
  }

  function setStaffWeight(key: StaffWeightKey, value: number) {
    setConfig(c => ({ ...c, staff: { ...c.staff, [key]: value } }))
  }
  function setManagerWeight(key: ManagerWeightKey, value: number) {
    setConfig(c => ({ ...c, manager: { ...c.manager, [key]: value } }))
  }

  async function persist(cfg: PerfConfig) {
    if (!companyId) return
    setSaving(true)
    const { error } = await supabase
      .from('kaizen_settings')
      .upsert({ key: 'perf_config', value: cfg, company_id: companyId, updated_by: profile?.id ?? null }, { onConflict: 'key,company_id' })
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success(t.settings.scoringSaved)
  }

  function resetDefaults() {
    const d: PerfConfig = { ...DEFAULT_PERF_CONFIG, staff: { ...DEFAULT_PERF_CONFIG.staff }, manager: { ...DEFAULT_PERF_CONFIG.manager } }
    setConfig(d)
    persist(d)
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-gray-300" /></div>
  }

  const staffWeights = staffRows.map(r => config.staff[r.key])
  const managerWeights = managerRows.map(r => config.manager[r.key])

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-400">{t.settings.scoringSubtitle}</p>

      {/* Add-on toggles */}
      {(hasPms || hasRr) && (
        <div className="space-y-2">
          {hasPms && (
            <ScoringToggle
              label={t.settings.scoringIncludePms}
              checked={config.includePms}
              onChange={(v) => setConfig(c => ({ ...c, includePms: v }))}
            />
          )}
          {hasRr && (
            <ScoringToggle
              label={t.settings.scoringIncludeRr}
              checked={config.includeRr}
              onChange={(v) => setConfig(c => ({ ...c, includeRr: v }))}
            />
          )}
        </div>
      )}

      {/* Staff group */}
      <div>
        <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">{t.settings.scoringStaffGroup}</h3>
        <div className="space-y-2">
          {staffRows.map(row => (
            <WeightInputRow
              key={row.key}
              label={row.label}
              value={config.staff[row.key]}
              shareLabel={share(staffWeights, config.staff[row.key])}
              onChange={(v) => setStaffWeight(row.key, v)}
            />
          ))}
        </div>
      </div>

      {/* Manager group */}
      <div>
        <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">{t.settings.scoringManagerGroup}</h3>
        <div className="space-y-2">
          {managerRows.map(row => (
            <WeightInputRow
              key={row.key}
              label={row.label}
              value={config.manager[row.key]}
              shareLabel={share(managerWeights, config.manager[row.key])}
              onChange={(v) => setManagerWeight(row.key, v)}
            />
          ))}
        </div>
      </div>

      <p className="text-[11px] text-gray-400">{t.settings.scoringWeightHint}</p>

      <div className="flex items-center gap-2">
        <Button onClick={() => persist(config)} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t.settings.scoringSave}
        </Button>
        <Button variant="outline" onClick={resetDefaults} disabled={saving}>
          {t.settings.scoringReset}
        </Button>
      </div>
    </div>
  )
}

function WeightInputRow({ label, value, shareLabel, onChange }: {
  label: string; value: number; shareLabel: string; onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex-1 text-sm text-gray-700 truncate">{label}</span>
      <span className="text-xs font-medium text-[var(--brand-primary)] w-12 text-right tabular-nums">= {shareLabel}</span>
      <Input
        type="number"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)))
          onChange(n)
        }}
        className="h-8 w-20 text-sm text-right"
      />
    </div>
  )
}

function ScoringToggle({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-gray-700">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none ${
          checked ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'
        }`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`} />
      </button>
    </div>
  )
}
