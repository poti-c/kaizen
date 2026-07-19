import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw, X } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PhotoUpload } from '@/components/PhotoUpload'
import { generateCaseNumber, CATEGORIES, LOCATIONS, formatDueBy, toDateTimeLocal, fromDateTimeLocal, bangkokDate, photoStoragePathFromUrl } from '@/lib/utils'
import { CATEGORY_LABELS_EN, categoryLabel, deptLabel } from '@/types'
import type { CasePriority, Department } from '@/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useDepartments } from '@/hooks/useDepartments'

// Quick deadline presets for urgent cases. `at()` returns a fresh ISO timestamp.
const DUE_PRESETS: { key: string; en: string; th: string; at: () => string }[] = [
  { key: '30m', en: 'In 30 min', th: 'ใน 30 นาที', at: () => new Date(Date.now() + 30 * 60_000).toISOString() },
  { key: '1h', en: 'In 1 hour', th: 'ใน 1 ชม.', at: () => new Date(Date.now() + 60 * 60_000).toISOString() },
  { key: '2h', en: 'In 2 hours', th: 'ใน 2 ชม.', at: () => new Date(Date.now() + 120 * 60_000).toISOString() },
  { key: '4h', en: 'In 4 hours', th: 'ใน 4 ชม.', at: () => new Date(Date.now() + 240 * 60_000).toISOString() },
  { key: 'eod', en: 'End of today', th: 'สิ้นวันนี้', at: () => new Date(`${bangkokDate()}T23:59:00+07:00`).toISOString() },
]

// Android can kill and reload the backgrounded tab while the native camera app is in
// the foreground (especially in an installed PWA), wiping all in-memory React state —
// the #1 cause of "my typed text disappeared / I can't add a case from my phone"
// reports. Persisting the draft to sessionStorage lets a forced reload recover it.
//
// CC-BUG-04: this used to be one fixed global key, no user or company component.
// sessionStorage survives a logout within the same tab, so on a shared device a
// second person signing in after the first would be shown — and prompted to
// "restore" — the first person's unsent case text and photo URLs.
function draftKey(profileId: string | undefined, companyId: string | undefined) {
  return `kaizen_create_case_draft:${profileId ?? 'anon'}:${companyId ?? 'none'}`
}

// CC-BUG-04 follow-up: the fixed global key this replaced. Nothing migrated a
// draft already sitting under it at the moment the scoped key shipped, so a
// user with an in-progress draft (e.g. a backgrounded PWA tab) at deploy time
// would look under the new scoped key, find nothing, and see a blank form —
// while their real, unsent draft sat orphaned under this key forever, never
// read or cleared again. Checked as a one-time migration fallback below.
const LEGACY_DRAFT_KEY = 'kaizen_create_case_draft'

// Cap on case_number collision retries in handleSubmit below.
const MAX_CASE_NUMBER_ATTEMPTS = 5

interface CaseDraft {
  caseNumber: string
  title: string
  description: string
  priority: CasePriority
  department: Department
  dueDate: string
  category: string
  categoryOther: string
  location: string
  locationOther: string
  isRecurring: boolean
  photoUrls: string[]
}

function loadDraft(key: string): CaseDraft | null {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as CaseDraft) : null
  } catch {
    return null
  }
}

function clearDraft(key: string) {
  try { sessionStorage.removeItem(key) } catch { /* storage unavailable */ }
}

export function CreateCasePage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()

  // Computed once at mount, matching the lazy draft/caseNumber initializers
  // below — CreateCasePage is only reachable behind a route guard that
  // already requires `profile` to be resolved, so this is stable by the time
  // the page renders.
  const [dKey] = useState(() => draftKey(profile?.id, activeCompany?.id))
  const [draft] = useState(() => {
    const found = loadDraft(dKey)
    if (found) return found
    // One-time migration: adopt and clear a pre-scoping draft if one exists.
    const legacy = loadDraft(LEGACY_DRAFT_KEY)
    if (legacy) { clearDraft(LEGACY_DRAFT_KEY); return legacy }
    return null
  })

  // CC-BUG-02: was `const [caseNumber]` — read-only. See the retry loop in
  // handleSubmit for why it needs a setter.
  const [caseNumber, setCaseNumber] = useState(() => draft?.caseNumber ?? generateCaseNumber())
  const [title, setTitle] = useState(draft?.title ?? '')
  const [description, setDescription] = useState(draft?.description ?? '')
  const [priority, setPriority] = useState<CasePriority>(draft?.priority ?? 'medium')
  const [department, setDepartment] = useState<Department>(draft?.department ?? (profile?.department || 'front_office'))
  const [dueDate, setDueDate] = useState(draft?.dueDate ?? '')
  const [category, setCategory] = useState<string>(draft?.category ?? '')
  const [categoryOther, setCategoryOther] = useState<string>(draft?.categoryOther ?? '')
  const [location, setLocation] = useState<string>(draft?.location ?? '')
  const [locationOther, setLocationOther] = useState<string>(draft?.locationOther ?? '')
  const [isRecurring, setIsRecurring] = useState(draft?.isRecurring ?? false)
  const [photoUrls, setPhotoUrls] = useState<string[]>(draft?.photoUrls ?? [])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (draft && (draft.title || draft.description || draft.photoUrls.length > 0)) {
      toast.info(lang === 'th' ? 'กู้คืนแบบร่างที่ยังไม่ได้บันทึกไว้ให้แล้ว' : 'Restored your unsaved draft')
    }
    // Only meant to run once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const hasContent = title || description || category || location || photoUrls.length > 0
    // CC-BUG-04: this used to just return here, leaving whatever draft was
    // already in sessionStorage untouched. Clearing every field then leaves a
    // now-stale draft sitting there — the NEXT visit to this page restores
    // text the user had deliberately deleted, not a blank form.
    if (!hasContent) { clearDraft(dKey); return }
    const d: CaseDraft = {
      caseNumber, title, description, priority, department, dueDate,
      category, categoryOther, location, locationOther, isRecurring, photoUrls,
    }
    try { sessionStorage.setItem(dKey, JSON.stringify(d)) } catch { /* storage full/unavailable */ }
  }, [caseNumber, title, description, priority, department, dueDate, category, categoryOther, location, locationOther, isRecurring, photoUrls])

  // Load company's custom categories + locations from settings
  const [customCategories, setCustomCategories] = useState<{ slug: string; label: string }[]>(
    CATEGORIES.map(c => ({ slug: c, label: CATEGORY_LABELS_EN[c] ?? c }))
  )
  const [customLocations, setCustomLocations] = useState<string[]>([...LOCATIONS] as string[])
  const { allOptions: deptOptions } = useDepartments()

  useEffect(() => {
    if (profile?.department && profile.role !== 'super_admin') setDepartment(profile.department as Department)
  }, [profile?.department, profile?.role])

  useEffect(() => {
    if (!activeCompany?.id) return
    supabase.from('kaizen_settings').select('key, value')
      .eq('company_id', activeCompany.id) // this tenant's taxonomy only
      .in('key', ['custom_categories', 'custom_locations'])
      .then(({ data }) => {
        if (!data) return
        data.forEach((row: { key: string; value: unknown }) => {
          if (!Array.isArray(row.value) || row.value.length === 0) return
          if (row.key === 'custom_categories') {
            // The stored list is the company's COMPLETE, curated category set — use it as-is.
            // Re-merging the built-in CATEGORIES (the old behaviour) duplicated every default
            // (→ "SafetySafety" in the trigger) and resurrected categories the admin had
            // deliberately removed in Settings (e.g. "Maintenance").
            setCustomCategories((row.value as string[]).map(label => ({
              slug: label.toLowerCase().replace(/ /g, '_'),
              label,
            })))
          }
          if (row.key === 'custom_locations') {
            // The stored list is the company's COMPLETE, curated location set — use it as-is.
            // Re-prepending the built-in LOCATIONS (the old behaviour) resurrected locations
            // the admin had deliberately removed in Settings and discarded their ordering.
            setCustomLocations(row.value as string[])
          }
        })
      })
  }, [activeCompany?.id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (loading) return
    // All four carry a red "*" in the UI, but Radix Selects don't block native submit,
    // so enforce them here — otherwise a case could be saved with a null/blank category
    // or location, or an "Other"/"Others" choice with no specify-text.
    if (!title.trim() || !description.trim() || !category || !location) {
      toast.error(t.createCase.fillRequired)
      return
    }
    if (category === 'other' && !categoryOther.trim()) {
      toast.error(t.createCase.fillRequired)
      return
    }
    if (location === 'Others' && !locationOther.trim()) {
      toast.error(t.createCase.fillRequired)
      return
    }

    setLoading(true)

    try {
      // CC-BUG-02: case_number is `KZN-YYYYMM-<1000..9999>` — only 9000 values
      // PER MONTH, shared across every tenant, on a plain UNIQUE column. A
      // collision is a realistic 23505 with any real volume of cases, not a
      // theoretical edge case. The number used to be fixed for the lifetime of
      // the component (and persisted into the sessionStorage draft), so a
      // collision was unrecoverable: every retry, and even a full page reload,
      // resubmitted the exact same colliding number and failed again — while
      // the generic catch below deleted the reporter's already-uploaded photos
      // on that very first, retryable failure.
      let usedCaseNumber = caseNumber
      let newCase: { id: string } | null = null
      for (let attempt = 0; attempt < MAX_CASE_NUMBER_ATTEMPTS; attempt++) {
        const { data, error } = await supabase
          .from('kaizen_cases')
          .insert({
            case_number: usedCaseNumber,
            title: title.trim(),
            description: description.trim(),
            department,
            created_by: profile.id,
            priority,
            status: 'open',
            company_id: activeCompany?.id ?? null,
            due_date: dueDate || null,
            category: category || null,
            category_other: category === 'other' ? categoryOther.trim() || null : null,
            location: location || null,
            location_other: location === 'Others' ? locationOther.trim() || null : null,
            is_recurring: isRecurring,
          })
          .select()
          .single()
        if (!error) { newCase = data; break }
        const isCaseNumberCollision = error.code === '23505' && /case_number/i.test(error.message)
        if (!isCaseNumberCollision || attempt === MAX_CASE_NUMBER_ATTEMPTS - 1) throw error
        usedCaseNumber = generateCaseNumber()
      }
      if (!newCase) throw new Error('Failed to create case after retrying a colliding case number.')
      // Persist the number that actually got used — into React state (so the
      // success toast/JSX below see it) and, via the existing draft-save effect
      // (which depends on `caseNumber`), into sessionStorage, so a reload can't
      // resurrect the collision.
      if (usedCaseNumber !== caseNumber) setCaseNumber(usedCaseNumber)

      if (photoUrls.length > 0) {
        const { error: photoErr } = await supabase.from('kaizen_case_photos').insert(
          photoUrls.map((url) => ({
            case_id: newCase.id,
            photo_url: url,
            photo_type: 'problem',
            uploaded_by: profile.id,
          }))
        )
        // The case row already committed — don't fail the whole submit, but make the
        // lost evidence visible instead of silently dropping the reporter's photos.
        if (photoErr) {
          console.error('case photo insert failed', photoErr)
          // CC-002: the photos were uploaded to storage BEFORE submit, but their DB rows
          // didn't commit — remove the now-orphaned objects so they don't leak. The catch
          // block's cleanup only runs when the CASE insert throws, which this swallowed
          // error never reaches. The user is told to re-add (which re-uploads), so the
          // dangling objects would otherwise never be referenced.
          const orphanPaths = photoUrls.map(photoStoragePathFromUrl)
          supabase.storage.from('kaizen-photos').remove(orphanPaths).catch((rmErr) =>
            console.error('photo cleanup after failed photo-row insert failed', rmErr))
          toast.error(lang === 'th'
            ? 'สร้างเคสแล้ว แต่แนบรูปภาพไม่สำเร็จ — กรุณาเพิ่มรูปอีกครั้งในหน้าเคส'
            : 'Case created, but attaching photos failed — please re-add them on the case page.')
        }
      }

      const { error: timelineErr } = await supabase.from('kaizen_case_timeline').insert({
        case_id: newCase.id,
        action: 'case_created',
        performed_by: profile.id,
      })
      if (timelineErr) console.error('case timeline insert failed', timelineErr)

      // CC-BUG-01: managed_departments is a Postgres TEXT[] column, not jsonb
      // (20260616000005_profiles_managed_departments.sql). PostgREST's `cs`
      // operator on a real array column needs the PG array-literal form
      // {"value"}; the old CC-003 fix sent JSON.stringify([department]) —
      // ["value"] — which Postgres rejects as a malformed array literal. Every
      // OTHER call site in the repo (rrNotify.ts, RoutineRosterPage.tsx) already
      // uses the correct {"..."} form; this one silently errored on every
      // submit, and because only `{ data }` was destructured the failure never
      // surfaced — a manager who covers this department solely via
      // managed_departments never got the 'New Case Reported' notification.
      const escDept = department.replace(/"/g, '\\"')
      const [{ data: managersByDept, error: mgrDeptErr }, { data: managersByManaged, error: mgrManagedErr }] = await Promise.all([
        supabase
          .from('kaizen_profiles')
          .select('id')
          .eq('company_id', activeCompany?.id ?? '')
          .eq('role', 'manager')
          .eq('is_active', true)
          .neq('id', profile.id)
          .eq('department', department),
        supabase
          .from('kaizen_profiles')
          .select('id')
          .eq('company_id', activeCompany?.id ?? '')
          .eq('role', 'manager')
          .eq('is_active', true)
          .neq('id', profile.id)
          .filter('managed_departments', 'cs', `{"${escDept}"}`),
      ])
      if (mgrDeptErr) console.error('manager-by-department lookup failed', mgrDeptErr)
      if (mgrManagedErr) console.error('manager-by-managed-departments lookup failed', mgrManagedErr)
      const managerIdsSeen = new Set<string>()
      const managers = [...(managersByDept ?? []), ...(managersByManaged ?? [])].filter(
        (m: { id: string }) => { if (managerIdsSeen.has(m.id)) return false; managerIdsSeen.add(m.id); return true }
      )

      if (managers && managers.length > 0) {
        const { error: mgrNotifErr } = await supabase.from('kaizen_notifications').insert(
          managers.map((m: { id: string }) => ({
            user_id: m.id,
            case_id: newCase.id,
            title: 'New Case Reported',
            message: `${profile.full_name} reported: "${title.trim()}" (${usedCaseNumber})`,
            notification_type: 'new_case',
            title_key: 'case_new',
            body_params: { reporter: profile.full_name, title: title.trim(), caseNo: usedCaseNumber },
          }))
        )
        if (mgrNotifErr) console.error('manager notification insert failed', mgrNotifErr)
      }

      const { data: admins } = await supabase
        .from('kaizen_profiles')
        .select('id')
        .eq('company_id', activeCompany?.id ?? '') // this tenant only
        .eq('role', 'super_admin')
        .eq('is_active', true)
        .neq('id', profile.id)

      if (admins && admins.length > 0) {
        const { error: adminNotifErr } = await supabase.from('kaizen_notifications').insert(
          admins.map((a: { id: string }) => ({
            user_id: a.id,
            case_id: newCase.id,
            title: 'New Case Reported',
            message: `${profile.full_name} (${deptLabel(department, lang)}) reported: "${title.trim()}" (${usedCaseNumber})`,
            notification_type: 'new_case',
            title_key: 'case_new',
            body_params: { reporter: profile.full_name, title: title.trim(), caseNo: usedCaseNumber },
          }))
        )
        if (adminNotifErr) console.error('admin notification insert failed', adminNotifErr)
      }

      clearDraft(dKey)
      toast.success(t.createCase.created(usedCaseNumber))
      navigate(`/cases/${newCase.id}`)
    } catch (err) {
      if (photoUrls.length > 0) {
        const paths = photoUrls.map(photoStoragePathFromUrl)
        supabase.storage.from('kaizen-photos').remove(paths).catch((rmErr) =>
          console.error('photo cleanup after failed insert failed', rmErr)
        )
      }
      toast.error(t.createCase.failed)
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // CC-PHOTO-LEAK-CANCEL: PhotoUpload uploads to storage immediately but the DB
  // rows are only written on submit. If the reporter cancels/goes back, remove the
  // now-orphaned objects (mirrors the submit-failure cleanup) so they don't leak.
  function cancelAndLeave() {
    if (photoUrls.length > 0) {
      const paths = photoUrls.map(photoStoragePathFromUrl)
      supabase.storage.from('kaizen-photos').remove(paths).catch((rmErr) =>
        console.error('photo cleanup on cancel failed', rmErr))
    }
    clearDraft(dKey)
    navigate(-1)
  }

  const priorities: CasePriority[] = ['low', 'medium', 'high', 'critical']
  const priorityStyles: Record<CasePriority, { base: string; active: string }> = {
    low:      { base: 'border-gray-200 text-gray-500 hover:border-green-300',   active: 'border-green-400 bg-green-50 text-green-700' },
    medium:   { base: 'border-gray-200 text-gray-500 hover:border-blue-300',    active: 'border-blue-300 bg-blue-50 text-blue-600' },
    high:     { base: 'border-gray-200 text-gray-500 hover:border-orange-300',  active: 'border-orange-400 bg-orange-50 text-orange-700' },
    critical: { base: 'border-gray-200 text-gray-500 hover:border-red-300',     active: 'border-red-400 bg-red-50 text-red-700' },
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon-sm" onClick={cancelAndLeave}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.createCase.title}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{t.createCase.subtitle}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
          <h2 className="font-semibold text-gray-900 border-b border-gray-100 pb-3">{t.createCase.caseDetails}</h2>

          {profile?.role === 'super_admin' && (
            <div className="space-y-1.5">
              <Label>{t.createCase.department} <span className="text-red-500">*</span></Label>
              <Select value={department} onValueChange={(v) => setDepartment(v as Department)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {deptOptions.filter((d) => d.value !== 'top_management').map((d) => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{t.createCase.problemTitle} <span className="text-red-500">*</span></Label>
            <Input
              placeholder={t.createCase.problemPlaceholder}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t.createCase.description} <span className="text-red-500">*</span></Label>
            <Textarea
              placeholder={t.createCase.descPlaceholder}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[120px]"
              required
            />
          </div>

          {/* Category + Location */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t.createCase.category} <span className="text-red-500">*</span></Label>
              <Select value={category} onValueChange={(v) => { setCategory(v); if (v !== 'other') setCategoryOther('') }}>
                <SelectTrigger>
                  <SelectValue placeholder={t.createCase.selectCategory} />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    let list = customCategories
                    // 'preventive_maintenance' is deliberately NOT offered here.
                    // It is reserved for the PMS add-on: kaizen_pm_sync stamps it
                    // on the cases it auto-creates, and CaseDetailPage keys the
                    // PM-case treatment off it. Letting staff pick it by hand
                    // produced cases that look auto-generated but are not, and it
                    // competed with the company's own maintenance category.
                    // Always offer the free-text catch-all, even if a company removed
                    // 'Other' from its custom list — otherwise the Specify field below
                    // (gated on slug 'other') becomes unreachable.
                    if (!list.some(c => c.slug === 'other')) list = [...list, { slug: 'other', label: 'Other' }]
                    return list
                  })().map(({ slug, label }) => (
                    // Built-in categories localize via the dict; company-custom ones keep their stored label.
                    <SelectItem key={slug} value={slug}>{slug in CATEGORY_LABELS_EN ? categoryLabel(slug, lang) : label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{lang === 'th' ? 'สถานที่' : 'Location'} <span className="text-red-500">*</span></Label>
              <Select value={location} onValueChange={(v) => { setLocation(v); if (v !== 'Others') setLocationOther('') }}>
                <SelectTrigger>
                  <SelectValue placeholder={lang === 'th' ? 'เลือกสถานที่' : 'Select location'} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {/* Always offer 'Others' so the Specify Location field (gated on
                      the literal 'Others') stays reachable even if a company's
                      custom_locations list omits it. */}
                  {(customLocations.some(l => l === 'Others') ? customLocations : [...customLocations, 'Others']).map((l) => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Category Other text input */}
          {category === 'other' && (
            <div className="space-y-1.5">
              <Label>{lang === 'th' ? 'ระบุหมวดหมู่' : 'Specify Category'} <span className="text-red-500">*</span></Label>
              <Input
                placeholder={lang === 'th' ? 'กรุณาระบุหมวดหมู่...' : 'Please describe the category...'}
                value={categoryOther}
                onChange={(e) => setCategoryOther(e.target.value)}
              />
            </div>
          )}

          {/* Location Other text input */}
          {location === 'Others' && (
            <div className="space-y-1.5">
              <Label>{lang === 'th' ? 'ระบุสถานที่' : 'Specify Location'} <span className="text-red-500">*</span></Label>
              <Input
                placeholder={lang === 'th' ? 'กรุณาระบุสถานที่...' : 'Please describe the location...'}
                value={locationOther}
                onChange={(e) => setLocationOther(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{t.createCase.priority}</Label>
            <div className="grid grid-cols-4 gap-2">
              {priorities.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`py-2 px-3 rounded-lg text-xs font-medium border transition-all capitalize ${
                    priority === p ? priorityStyles[p].active : priorityStyles[p].base
                  }`}
                >
                  {t.priority[p]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t.createCase.dueDate} <span className="text-gray-400 text-xs font-normal">{t.createCase.optional}</span></Label>
            {/* Quick presets for urgent cases (due within minutes/hours) + a precise date+time picker. */}
            <div className="flex flex-wrap gap-1.5">
              {DUE_PRESETS.map((p) => (
                <button key={p.key} type="button" onClick={() => setDueDate(p.at())}
                  className="px-2.5 h-8 rounded-lg border bg-white text-gray-600 border-gray-300 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] text-xs font-medium transition-colors">
                  {lang === 'th' ? p.th : p.en}
                </button>
              ))}
              {dueDate && (
                <button type="button" onClick={() => setDueDate('')}
                  className="px-2.5 h-8 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-600">
                  {lang === 'th' ? 'ล้าง' : 'Clear'}
                </button>
              )}
            </div>
            <Input type="datetime-local" value={toDateTimeLocal(dueDate)}
              onChange={(e) => setDueDate(fromDateTimeLocal(e.target.value))}
              min={toDateTimeLocal(new Date().toISOString())} />
            {dueDate && (
              <p className="text-xs text-gray-500">{lang === 'th' ? 'ครบกำหนด' : 'Due by'} {formatDueBy(dueDate, lang)}</p>
            )}
          </div>

          {/* Recurring toggle */}
          <div
            className={cn(
              'flex items-center gap-3 p-3 rounded-lg border cursor-pointer select-none transition-all',
              isRecurring
                ? 'border-orange-300 bg-orange-50'
                : 'border-gray-200 bg-gray-50 hover:border-gray-300'
            )}
            onClick={() => setIsRecurring(v => !v)}
          >
            <div className={cn(
              'w-9 h-5 rounded-full flex items-center transition-all relative flex-shrink-0',
              isRecurring ? 'bg-orange-500' : 'bg-gray-300'
            )}>
              <div className={cn(
                'w-4 h-4 bg-white rounded-full shadow absolute transition-all',
                isRecurring ? 'left-4' : 'left-0.5'
              )} />
            </div>
            <RefreshCw className={cn('h-4 w-4 flex-shrink-0', isRecurring ? 'text-orange-500' : 'text-gray-400')} />
            <div>
              <p className={cn('text-sm font-medium', isRecurring ? 'text-orange-800' : 'text-gray-700')}>{t.createCase.recurring}</p>
              <p className="text-xs text-gray-500">{t.createCase.recurringHint}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-3">
          <h2 className="font-semibold text-gray-900 border-b border-gray-100 pb-3">{t.createCase.photoEvidence}</h2>
          <p className="text-sm text-gray-500">{t.createCase.photoSubtitle}</p>
          {photoUrls.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {photoUrls.map((url, i) => (
                <div key={url} className="relative aspect-square rounded-lg overflow-hidden bg-gray-100">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => {
                      // CC-BUG-03: this only ever dropped the URL from React
                      // state. PhotoUpload writes to storage immediately on
                      // capture, and this page cleans up orphans on cancel and
                      // on submit failure — but BOTH of those cleanup paths
                      // walk `photoUrls`, so once a URL is removed from state
                      // here, neither path can ever find it again. Every photo
                      // a reporter took and then discarded leaked in storage
                      // permanently. Delete the object itself before removing
                      // it from state.
                      const path = photoStoragePathFromUrl(url)
                      supabase.storage.from('kaizen-photos').remove([path]).catch((rmErr) =>
                        console.error('photo cleanup on remove failed', rmErr))
                      setPhotoUrls((prev) => prev.filter((_, idx2) => idx2 !== i))
                    }}
                    className="absolute top-1 right-1 bg-red-600 text-white rounded-full p-0.5 shadow-sm"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <PhotoUpload
            onUpload={(urls) => setPhotoUrls((prev) => [...prev, ...urls])}
            maxFiles={Math.max(0, 5 - photoUrls.length)}
            label={t.createCase.addPhotos}
            caseNumber={caseNumber}
            department={department}
            companyId={activeCompany?.id}
          />
        </div>

        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={cancelAndLeave} className="flex-1">
            {t.createCase.cancel}
          </Button>
          <Button type="submit" className="flex-1" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t.createCase.submit}
          </Button>
        </div>
      </form>
    </div>
  )
}
