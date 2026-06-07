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
import { generateCaseNumber, CATEGORIES, LOCATIONS, companyHasAddon } from '@/lib/utils'
import { DEPARTMENTS, PRIORITY_LABELS } from '@/types'
import type { CasePriority, Department } from '@/types'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const CATEGORY_LABELS_EN: Record<string, string> = {
  maintenance: 'Maintenance', cleanliness: 'Cleanliness', safety: 'Safety',
  guest_complaint: 'Guest Complaint', equipment: 'Equipment', other: 'Other',
}

export function CreateCasePage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { t } = useLanguage()

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
    supabase.from('kaizen_settings').select('key, value')
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
    if (!title.trim() || !description.trim()) {
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
        await supabase.from('kaizen_case_photos').insert(
          photoUrls.map((url) => ({
            case_id: newCase.id,
            photo_url: url,
            photo_type: 'problem',
            uploaded_by: profile.id,
          }))
        )
      }

      await supabase.from('kaizen_case_timeline').insert({
        case_id: newCase.id,
        action: 'case_created',
        description: `Case created by ${profile.full_name}`,
        performed_by: profile.id,
      })

      const { data: managers } = await supabase
        .from('kaizen_profiles')
        .select('id')
        .eq('department', department)
        .eq('role', 'manager')
        .eq('is_active', true)

      if (managers && managers.length > 0) {
        await supabase.from('kaizen_notifications').insert(
          managers.map((m: { id: string }) => ({
            user_id: m.id,
            case_id: newCase.id,
            title: 'New Case Reported',
            message: `${profile.full_name} reported: "${title.trim()}" (${caseNumber})`,
            notification_type: 'new_case',
          }))
        )
      }

      const { data: admins } = await supabase
        .from('kaizen_profiles')
        .select('id')
        .eq('role', 'super_admin')
        .eq('is_active', true)

      if (admins && admins.length > 0) {
        await supabase.from('kaizen_notifications').insert(
          admins.map((a: { id: string }) => ({
            user_id: a.id,
            case_id: newCase.id,
            title: 'New Case Reported',
            message: `${profile.full_name} (${DEPARTMENTS.find(d => d.value === department)?.label}) reported: "${title.trim()}" (${caseNumber})`,
            notification_type: 'new_case',
          }))
        )
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
                  {(companyHasAddon(activeCompany, 'pms') && !customCategories.some(c => c.slug === 'preventive_maintenance')
                    ? [...customCategories, { slug: 'preventive_maintenance', label: 'Preventive Maintenance' }]
                    : customCategories
                  ).map(({ slug, label }) => (
                    <SelectItem key={slug} value={slug}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Location <span className="text-red-500">*</span></Label>
              <Select value={location} onValueChange={(v) => { setLocation(v); if (v !== 'Others') setLocationOther('') }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select location" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {customLocations.map((l) => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Category Other text input */}
          {category === 'other' && (
            <div className="space-y-1.5">
              <Label>Specify Category <span className="text-red-500">*</span></Label>
              <Input
                placeholder="Please describe the category..."
                value={categoryOther}
                onChange={(e) => setCategoryOther(e.target.value)}
              />
            </div>
          )}

          {/* Location Other text input */}
          {location === 'Others' && (
            <div className="space-y-1.5">
              <Label>Specify Location <span className="text-red-500">*</span></Label>
              <Input
                placeholder="Please describe the location..."
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
                  {PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t.createCase.dueDate} <span className="text-gray-400 text-xs font-normal">{t.createCase.optional}</span></Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} min={new Date().toISOString().split('T')[0]} />
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
