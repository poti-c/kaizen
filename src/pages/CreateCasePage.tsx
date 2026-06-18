import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
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
import { generateCaseNumber, CATEGORIES, LOCATIONS, companyHasAddon, formatDueBy, toDateTimeLocal, fromDateTimeLocal } from '@/lib/utils'
import { DEPARTMENTS, CATEGORY_LABELS_EN, categoryLabel, deptLabel } from '@/types'
import type { CasePriority, Department } from '@/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// Quick deadline presets for urgent cases. `at()` returns a fresh ISO timestamp.
const DUE_PRESETS: { key: string; en: string; th: string; at: () => string }[] = [
  { key: '30m', en: 'In 30 min', th: 'ใน 30 นาที', at: () => new Date(Date.now() + 30 * 60_000).toISOString() },
  { key: '1h', en: 'In 1 hour', th: 'ใน 1 ชม.', at: () => new Date(Date.now() + 60 * 60_000).toISOString() },
  { key: '2h', en: 'In 2 hours', th: 'ใน 2 ชม.', at: () => new Date(Date.now() + 120 * 60_000).toISOString() },
  { key: '4h', en: 'In 4 hours', th: 'ใน 4 ชม.', at: () => new Date(Date.now() + 240 * 60_000).toISOString() },
  { key: 'eod', en: 'End of today', th: 'สิ้นวันนี้', at: () => { const d = new Date(); d.setHours(23, 59, 0, 0); return d.toISOString() } },
]

export function CreateCasePage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t, lang } = useLanguage()

  const [caseNumber] = useState(() => generateCaseNumber())
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<CasePriority>('medium')
  const [department, setDepartment] = useState<Department>(profile?.department || 'front_office')
  const [dueDate, setDueDate] = useState('')
  const [category, setCategory] = useState<string>('')
  const [categoryOther, setCategoryOther] = useState<string>('')
  const [location, setLocation] = useState<string>('')
  const [locationOther, setLocationOther] = useState<string>('')
  const [isRecurring, setIsRecurring] = useState(false)
  const [photoUrls, setPhotoUrls] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  // Load company's custom categories + locations from settings
  const [customCategories, setCustomCategories] = useState<{ slug: string; label: string }[]>(
    CATEGORIES.map(c => ({ slug: c, label: CATEGORY_LABELS_EN[c] ?? c }))
  )
  const [customLocations, setCustomLocations] = useState<string[]>([...LOCATIONS] as string[])

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
            const cats = (row.value as string[]).map(label => ({
              slug: label.toLowerCase().replace(/ /g, '_'),
              label,
            }))
            setCustomCategories(cats)
          }
          if (row.key === 'custom_locations') {
            setCustomLocations(row.value as string[])
          }
        })
      })
  }, [activeCompany?.id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
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
      const { data: newCase, error } = await supabase
        .from('kaizen_cases')
        .insert({
          case_number: caseNumber,
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
          person_in_charge: profile.id,
          location_other: location === 'Others' ? locationOther.trim() || null : null,
          is_recurring: isRecurring,
        })
        .select()
        .single()

      if (error) throw error

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
          toast.error(lang === 'th'
            ? 'สร้างเคสแล้ว แต่แนบรูปภาพไม่สำเร็จ — กรุณาเพิ่มรูปอีกครั้งในหน้าเคส'
            : 'Case created, but attaching photos failed — please re-add them on the case page.')
        }
      }

      const { error: timelineErr } = await supabase.from('kaizen_case_timeline').insert({
        case_id: newCase.id,
        action: 'case_created',
        description: `Case created by ${profile.full_name}`,
        performed_by: profile.id,
      })
      if (timelineErr) console.error('case timeline insert failed', timelineErr)

      const { data: managers } = await supabase
        .from('kaizen_profiles')
        .select('id')
        .eq('company_id', activeCompany?.id ?? '') // this tenant only — don't notify other companies
        .eq('department', department)
        .eq('role', 'manager')
        .eq('is_active', true)

      if (managers && managers.length > 0) {
        const { error: mgrNotifErr } = await supabase.from('kaizen_notifications').insert(
          managers.map((m: { id: string }) => ({
            user_id: m.id,
            case_id: newCase.id,
            title: 'New Case Reported',
            message: `${profile.full_name} reported: "${title.trim()}" (${caseNumber})`,
            notification_type: 'new_case',
            title_key: 'case_new',
            body_params: { reporter: profile.full_name, title: title.trim(), caseNo: caseNumber },
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

      if (admins && admins.length > 0) {
        const { error: adminNotifErr } = await supabase.from('kaizen_notifications').insert(
          admins.map((a: { id: string }) => ({
            user_id: a.id,
            case_id: newCase.id,
            title: 'New Case Reported',
            message: `${profile.full_name} (${deptLabel(department, lang)}) reported: "${title.trim()}" (${caseNumber})`,
            notification_type: 'new_case',
            title_key: 'case_new',
            body_params: { reporter: profile.full_name, title: title.trim(), caseNo: caseNumber },
          }))
        )
        if (adminNotifErr) console.error('admin notification insert failed', adminNotifErr)
      }

      toast.success(t.createCase.created(caseNumber))
      navigate(`/cases/${newCase.id}`)
    } catch (err) {
      toast.error(t.createCase.failed)
      console.error(err)
    } finally {
      setLoading(false)
    }
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
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
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
                  {DEPARTMENTS.filter((d) => d.value !== 'top_management').map((d) => (
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
                    if (companyHasAddon(activeCompany, 'pms') && !list.some(c => c.slug === 'preventive_maintenance')) {
                      list = [...list, { slug: 'preventive_maintenance', label: 'Preventive Maintenance' }]
                    }
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
          <PhotoUpload
            onUpload={(urls) => setPhotoUrls((prev) => [...prev, ...urls])}
            maxFiles={5}
            label={t.createCase.addPhotos}
            caseNumber={caseNumber}
            department={department}
          />
        </div>

        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={() => navigate(-1)} className="flex-1">
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
