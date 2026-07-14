import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Loader2, Check, X, ChefHat, ChevronDown, Truck, ListChecks, CalendarDays, ArrowRight, ToggleLeft, ToggleRight } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { DEPARTMENTS, deptLabel, type Department } from '@/types'
import type { RrItem } from '@/components/RRSettings'
import type { RoomCategory } from '@/components/RoomSetupSettings'
import { DEFAULT_UNIT, unitOne, type UnitNoun } from '@/lib/roomUnit'
import { recipeSeedOff } from '@/lib/roomRecipe'
import { toast } from 'sonner'

// ── shared types (reused by the Daily Room Order seeding in later steps) ─────────

export type LineType = 'delivery' | 'checklist'

export interface RecipeLine {
  id: string
  slot: string                 // "Welcome fruit", "Turndown", "Minibar"
  item: string                 // catalog label, e.g. "F3 — 3 pieces"
  fulfill_department: Department // the FINAL deliverer (single-stage: the only dept)
  // Two-stage handoff: when set, this dept PREPARES the item and hands it to
  // fulfill_department to DELIVER (e.g. Kitchen prepares → Restaurant delivers).
  // null/absent = single-stage (fulfill_department both prepares and delivers).
  prepare_department?: Department | null
  serving_at: string           // "12:00" or ""
  line_type: LineType
  by_weekday?: Record<string, string> | null  // mon..sun item overrides (turndown-of-the-day)
  // When true the line is seeded OFF (unticked) on the order, so the requester opts in.
  // Absent → falls back to the receipt heuristic (receipts default off, everything else on).
  default_off?: boolean
}
/** Recipes keyed by RoomCategory.id. */
export type RoomRecipes = Record<string, RecipeLine[]>

const DEPT_OPTIONS = DEPARTMENTS.filter((d) => d.value !== 'top_management')
const DEFAULT_PREP_BUFFER_MIN = 30
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const WEEKDAY_LABELS: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' }
const WEEKDAY_LABELS_TH: Record<string, string> = { mon: 'จ.', tue: 'อ.', wed: 'พ.', thu: 'พฤ.', fri: 'ศ.', sat: 'ส.', sun: 'อา.' }

function newId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `line_${Math.floor(performance.now() * 1000)}`)
}
/** Catalog label for an item, matching the Template editor's format. */
function itemLabel(it: RrItem): string {
  return it.code ? `${it.code} — ${it.description}` : it.description
}

// ── main component ──────────────────────────────────────────────────────────────

export function RoomRecipesSettings() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const companyId = activeCompany?.id ?? null

  const [categories, setCategories] = useState<RoomCategory[]>([])
  const [unit, setUnit] = useState<UnitNoun>(DEFAULT_UNIT)
  const [items, setItems] = useState<RrItem[]>([])
  const [recipes, setRecipes] = useState<RoomRecipes>({})
  const [prepBuffer, setPrepBuffer] = useState(DEFAULT_PREP_BUFFER_MIN)
  const [savingBuffer, setSavingBuffer] = useState(false)
  const [loading, setLoading] = useState(true)
  const [canEdit, setCanEdit] = useState(false)
  const [editing, setEditing] = useState<RoomCategory | null>(null)

  const load = useCallback(async () => {
    if (!companyId || !profile) return
    setLoading(true)
    const [cfgRes, itemsRes, recipesRes, bufRes] = await Promise.all([
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_room_config').maybeSingle(),
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_items').maybeSingle(),
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_room_recipes').maybeSingle(),
      supabase.from('kaizen_settings').select('value').eq('company_id', companyId).eq('key', 'rr_prep_buffer_min').maybeSingle(),
    ])
    const cfg = cfgRes.data?.value as { categories?: RoomCategory[]; unit?: UnitNoun } | undefined
    setCategories((cfg?.categories ?? []).slice().sort((a, b) => a.order - b.order))
    if (cfg?.unit) setUnit(cfg.unit)
    setItems(Array.isArray(itemsRes.data?.value) ? (itemsRes.data!.value as RrItem[]) : [])
    setRecipes((recipesRes.data?.value as RoomRecipes) ?? {})
    const buf = bufRes.data?.value as number | undefined
    setPrepBuffer(typeof buf === 'number' && buf >= 0 ? buf : DEFAULT_PREP_BUFFER_MIN)
    setCanEdit(profile.role === 'super_admin' || profile.role === 'manager')
    setLoading(false)
  }, [companyId, profile])
  useEffect(() => { load() }, [load])

  async function savePrepBuffer(val: number) {
    if (!companyId) return
    const clamped = Math.max(0, Math.min(240, Math.round(val) || 0))
    setPrepBuffer(clamped)
    setSavingBuffer(true)
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_prep_buffer_min', value: clamped }, { onConflict: 'company_id,key' })
    setSavingBuffer(false)
    if (error) { toast.error(error.message); return }
    toast.success(lang === 'th' ? 'บันทึกแล้ว' : 'Saved')
  }

  async function saveCategory(catId: string, lines: RecipeLine[]): Promise<boolean> {
    if (!companyId) return false
    const next = { ...recipes, [catId]: lines }
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_room_recipes', value: next }, { onConflict: 'company_id,key' })
    if (error) { toast.error(error.message); return false }
    setRecipes(next)
    return true
  }

  if (loading) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  if (!canEdit) return (
    <p className="text-sm text-gray-400 py-6 text-center">
      {lang === 'th' ? 'คุณไม่มีสิทธิ์แก้ไขชุดเริ่มต้นของห้อง' : "You don't have permission to edit room recipes."}
    </p>
  )

  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ChefHat className="h-4 w-4 text-gray-400" />
          <h3 className="font-semibold text-gray-900">{lang === 'th' ? 'ชุดเริ่มต้นตามหมวดห้อง' : 'Category default setups'}</h3>
        </div>
        <p className="text-xs text-gray-500">
          {lang === 'th'
            ? `กำหนดรายการมาตรฐานของแต่ละหมวด${unitOne(unit, lang)} แต่ละรายการส่งไปยังแผนกผู้ดำเนินการของตนเอง`
            : `The standing lines each ${unitOne(unit, lang).toLowerCase()} gets by default — each routed to its own fulfilling department. Used to seed the daily order.`}
        </p>
      </div>

      {/* Handoff prep buffer — drives the "prep by" hint on a preparer's board */}
      <div className="flex items-center gap-2 flex-wrap rounded-lg border border-gray-200 bg-gray-50/60 p-3">
        <label className="text-[12px] text-gray-600 flex items-center gap-2">
          {lang === 'th' ? 'เผื่อเวลาเตรียม (ส่งต่อระหว่างแผนก)' : 'Handoff prep buffer'}
          <input type="number" min={0} max={240} value={prepBuffer}
            onChange={(e) => setPrepBuffer(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
            onBlur={(e) => { const v = Math.max(0, Math.min(240, Number(e.target.value) || 0)); savePrepBuffer(v) }}
            className="w-16 h-8 rounded-md border border-gray-200 px-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40" />
          <span className="text-[12px] text-gray-400">{lang === 'th' ? 'นาทีก่อนเวลาส่ง' : 'min before serving'}</span>
          {savingBuffer && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
        </label>
        <p className="basis-full text-[11px] text-gray-400">
          {lang === 'th'
            ? 'สำหรับรายการที่แผนกหนึ่งเตรียมแล้วส่งต่ออีกแผนกจัดส่ง บอร์ดของผู้เตรียมจะแสดง “เตรียมให้เสร็จภายใน” = เวลาส่ง ลบด้วยค่านี้'
            : 'For items one dept prepares and another delivers, the preparer’s board shows a “prep by” time = serving time minus this buffer.'}
        </p>
      </div>

      {categories.length === 0 ? (
        <div className="text-center py-8 rounded-xl border border-dashed border-gray-200 text-sm text-gray-400">
          {lang === 'th' ? 'ยังไม่มีหมวดห้อง — เพิ่มในการตั้งค่าห้องด้านบนก่อน' : 'No room categories yet — add them in Room Setup above first.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {categories.map((cat) => {
            const n = recipes[cat.id]?.length ?? 0
            return (
              <button key={cat.id} onClick={() => setEditing(cat)}
                className="flex flex-col items-start gap-1.5 rounded-xl border border-gray-200 bg-white p-4 hover:border-[var(--brand-primary)] hover:shadow-sm transition-all text-left group">
                <span className="text-sm font-semibold text-gray-800 group-hover:text-[var(--brand-primary)] transition-colors leading-tight">
                  {cat.name}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-[11px] font-medium text-gray-500">
                  {n} {lang === 'th' ? 'รายการ' : n === 1 ? 'line' : 'lines'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {editing && (
        <RecipeModal
          category={editing}
          lines={recipes[editing.id] ?? []}
          items={items}
          lang={lang}
          onClose={() => setEditing(null)}
          onSave={saveCategory}
        />
      )}
    </section>
  )
}

// ── per-category recipe modal ────────────────────────────────────────────────────

function RecipeModal({ category, lines, items, lang, onClose, onSave }: {
  category: RoomCategory
  lines: RecipeLine[]
  items: RrItem[]
  lang: 'en' | 'th'
  onClose: () => void
  onSave: (catId: string, lines: RecipeLine[]) => Promise<boolean>
}) {
  const [local, setLocal] = useState<RecipeLine[]>(lines)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null) // line id with weekday panel open

  function patch(id: string, fields: Partial<RecipeLine>) {
    setLocal((prev) => prev.map((l) => l.id === id ? { ...l, ...fields } : l))
  }
  function addLine() {
    const id = newId()
    setLocal((prev) => [...prev, {
      id, slot: '', item: '', fulfill_department: DEPT_OPTIONS[0]?.value ?? 'restaurant',
      serving_at: '', line_type: 'delivery', by_weekday: null,
    }])
    setTimeout(() => document.getElementById('recipe-list-bottom')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
  }
  function remove(id: string) {
    setLocal((prev) => prev.filter((l) => l.id !== id))
    if (expanded === id) setExpanded(null)
  }
  function toggleWeekday(id: string) {
    const line = local.find((l) => l.id === id)
    if (!line) return
    if (line.by_weekday) { patch(id, { by_weekday: null }); if (expanded === id) setExpanded(null) }
    else { patch(id, { by_weekday: {} }); setExpanded(id) }
  }
  function toggleHandoff(id: string) {
    const line = local.find((l) => l.id === id)
    if (!line) return
    if (line.prepare_department) {
      // Off: collapse back to a single dept = the preparer (who actually makes the item).
      patch(id, { fulfill_department: line.prepare_department, prepare_department: null })
    } else {
      // On: the current dept becomes the PREPARER; pick a different dept to DELIVER
      // (default Restaurant, else the first dept that isn't the preparer). Item catalog
      // stays keyed to the preparer, so the chosen item remains valid.
      const deliverer = DEPT_OPTIONS.find((d) => d.value !== line.fulfill_department && d.value === 'restaurant')?.value
        ?? DEPT_OPTIONS.find((d) => d.value !== line.fulfill_department)?.value
        ?? line.fulfill_department
      patch(id, { prepare_department: line.fulfill_department, fulfill_department: deliverer })
    }
  }

  async function save() {
    setBusy(true)
    const clean = local
      .filter((l) => l.slot.trim() || l.item.trim())
      .map((l) => ({
        ...l, slot: l.slot.trim(), item: l.item.trim(),
        // A handoff only counts when the preparer differs from the deliverer.
        prepare_department: l.prepare_department && l.prepare_department !== l.fulfill_department ? l.prepare_department : null,
        by_weekday: l.by_weekday && Object.values(l.by_weekday).some((v) => v?.trim()) ? l.by_weekday : null,
      }))
    const ok = await onSave(category.id, clean)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col">

        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-gray-900">{category.name} · {lang === 'th' ? 'ชุดเริ่มต้น' : 'default setup'}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{local.length} {lang === 'th' ? 'รายการ' : 'lines'}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {local.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              {lang === 'th' ? 'ยังไม่มีรายการ กดด้านล่างเพื่อเพิ่ม' : 'No default lines yet. Add one below.'}
            </p>
          )}
          {local.map((line) => {
            const handoff = !!line.prepare_department
            // The item is made by the PREPARER, so it comes from the preparer's catalog
            // (the deliverer doesn't own the item). Single-stage = fulfill_department.
            const catalogDept = line.prepare_department ?? line.fulfill_department
            const deptItems = items.filter((it) => it.department === catalogDept)
            return (
              <div key={line.id} className="rounded-lg border border-gray-150 bg-gray-50/50 p-2.5 space-y-2">
                {/* Row 1: slot + remove */}
                <div className="flex items-center gap-2">
                  <input value={line.slot} onChange={(e) => patch(line.id, { slot: e.target.value })}
                    placeholder={lang === 'th' ? 'หัวข้อ เช่น ผลไม้ต้อนรับ' : 'Slot e.g. Welcome fruit'}
                    className="flex-1 h-8 rounded-md border border-gray-200 px-2 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white" />
                  <button onClick={() => remove(line.id)} className="h-8 w-8 flex items-center justify-center rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* Row 2: department(s) + item. Single-stage = one dept; handoff = prepare → deliver. */}
                {handoff ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] font-medium text-gray-400 flex items-center gap-1 mb-0.5"><ChefHat className="h-3 w-3" />{lang === 'th' ? 'เตรียมโดย' : 'Prepared by'}</label>
                        <select value={line.prepare_department ?? ''} onChange={(e) => patch(line.id, { prepare_department: e.target.value as Department, item: '' })} className={cell}>
                          {DEPT_OPTIONS.map((d) => <option key={d.value} value={d.value}>{deptLabel(d.value, lang)}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] font-medium text-gray-400 flex items-center gap-1 mb-0.5"><Truck className="h-3 w-3" />{lang === 'th' ? 'ส่งโดย' : 'Delivered by'}</label>
                        <select value={line.fulfill_department} onChange={(e) => patch(line.id, { fulfill_department: e.target.value as Department })} className={cell}>
                          {DEPT_OPTIONS.map((d) => <option key={d.value} value={d.value}>{deptLabel(d.value, lang)}</option>)}
                        </select>
                      </div>
                    </div>
                    <ItemField value={line.item} options={deptItems} lang={lang} onChange={(v) => patch(line.id, { item: v })} />
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <select value={line.fulfill_department} onChange={(e) => patch(line.id, { fulfill_department: e.target.value as Department, item: '' })}
                      className={cell}>
                      {DEPT_OPTIONS.map((d) => <option key={d.value} value={d.value}>{deptLabel(d.value, lang)}</option>)}
                    </select>
                    <ItemField value={line.item} options={deptItems} lang={lang} onChange={(v) => patch(line.id, { item: v })} />
                  </div>
                )}

                {/* Row 3: serving time + delivery/checklist + weekday toggle */}
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-[11px] text-gray-400">{lang === 'th' ? 'เวลาส่ง' : 'Serve by'}</label>
                  <input type="time" value={line.serving_at} onChange={(e) => patch(line.id, { serving_at: e.target.value })}
                    className="h-8 rounded-md border border-gray-200 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white" />

                  <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs ml-auto">
                    <button onClick={() => patch(line.id, { line_type: 'delivery' })}
                      className={`flex items-center gap-1 px-2 h-8 ${line.line_type === 'delivery' ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-500'}`}>
                      <Truck className="h-3.5 w-3.5" />{lang === 'th' ? 'ส่ง' : 'Delivery'}
                    </button>
                    <button onClick={() => patch(line.id, { line_type: 'checklist' })}
                      className={`flex items-center gap-1 px-2 h-8 ${line.line_type === 'checklist' ? 'bg-[var(--brand-primary)] text-white' : 'bg-white text-gray-500'}`}>
                      <ListChecks className="h-3.5 w-3.5" />{lang === 'th' ? 'เช็คลิสต์' : 'Checklist'}
                    </button>
                  </div>

                  <button onClick={() => toggleHandoff(line.id)}
                    title={lang === 'th' ? 'เตรียมโดยแผนกหนึ่ง แล้วส่งต่ออีกแผนกเพื่อจัดส่ง' : 'One dept prepares, another delivers'}
                    className={`h-8 px-2 flex items-center gap-1 rounded-md border text-xs ${handoff ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[var(--brand-primary)]/5' : 'border-gray-200 text-gray-400 hover:text-gray-600'}`}>
                    <ArrowRight className="h-3.5 w-3.5" />
                    {lang === 'th' ? 'ส่งต่อ' : 'Hand off'}
                  </button>

                  <button onClick={() => toggleWeekday(line.id)}
                    title={lang === 'th' ? 'เปลี่ยนตามวัน' : 'Varies by weekday'}
                    className={`h-8 px-2 flex items-center gap-1 rounded-md border text-xs ${line.by_weekday ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[var(--brand-primary)]/5' : 'border-gray-200 text-gray-400 hover:text-gray-600'}`}>
                    <CalendarDays className="h-3.5 w-3.5" />
                    {line.by_weekday ? (lang === 'th' ? 'รายวัน' : 'By day') : (lang === 'th' ? 'รายวัน?' : 'By day?')}
                    {line.by_weekday && <ChevronDown className={`h-3 w-3 transition-transform ${expanded === line.id ? 'rotate-180' : ''}`} onClick={(e) => { e.stopPropagation(); setExpanded(expanded === line.id ? null : line.id) }} />}
                  </button>

                  {(() => {
                    const seedOff = recipeSeedOff(line)
                    return (
                      <button onClick={() => patch(line.id, { default_off: !seedOff })}
                        title={lang === 'th' ? 'ติ๊กไว้ล่วงหน้าในใบสั่งหรือไม่' : 'Whether this line is pre-ticked on a new order'}
                        className={`h-8 px-2 flex items-center gap-1 rounded-md border text-xs ${seedOff ? 'border-gray-200 text-gray-400 hover:text-gray-600' : 'border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[var(--brand-primary)]/5'}`}>
                        {seedOff ? <ToggleLeft className="h-3.5 w-3.5" /> : <ToggleRight className="h-3.5 w-3.5" />}
                        {seedOff ? (lang === 'th' ? 'ปิดเริ่มต้น' : 'Off by default') : (lang === 'th' ? 'เปิดเริ่มต้น' : 'On by default')}
                      </button>
                    )
                  })()}
                </div>

                {/* Weekday override panel */}
                {line.by_weekday && expanded === line.id && (
                  <div className="rounded-md border border-gray-200 bg-white p-2 space-y-1.5">
                    <p className="text-[11px] text-gray-400">
                      {lang === 'th' ? 'ระบุของแต่ละวัน (เว้นว่าง = ใช้ค่าเริ่มต้นด้านบน)' : 'Set per-day item (blank = use the default above)'}
                    </p>
                    {WEEKDAYS.map((d) => (
                      <div key={d} className="flex items-center gap-2">
                        <span className="w-9 text-[11px] font-medium text-gray-500 flex-shrink-0">{(lang === 'th' ? WEEKDAY_LABELS_TH : WEEKDAY_LABELS)[d]}</span>
                        <ItemField value={line.by_weekday?.[d] ?? ''} options={deptItems} lang={lang} compact
                          onChange={(v) => patch(line.id, { by_weekday: { ...(line.by_weekday ?? {}), [d]: v } })} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          <div id="recipe-list-bottom" />

          <button onClick={addLine}
            className="w-full flex items-center justify-center gap-1.5 h-9 rounded-lg border border-dashed border-gray-200 text-sm text-gray-400 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors mt-1">
            <Plus className="h-4 w-4" />{lang === 'th' ? 'เพิ่มรายการ' : 'Add line'}
          </button>
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200 flex-shrink-0">
          <button onClick={save} disabled={busy}
            className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'บันทึก' : 'Save'}
          </button>
          <button onClick={onClose} className="px-3 h-9 rounded-lg text-gray-500 hover:bg-gray-100 text-sm">{lang === 'th' ? 'ยกเลิก' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}

/** Item value: a select of the dept's catalog, with a free-text fallback when needed. */
export function ItemField({ value, options, lang, compact, onChange }: {
  value: string
  options: RrItem[]
  lang: 'en' | 'th'
  compact?: boolean
  onChange: (v: string) => void
}) {
  const labels = options.map(itemLabel)
  const inCatalog = value === '' || labels.includes(value)
  const [custom, setCustom] = useState(!inCatalog)
  // UXRG-1: re-derive free-text vs catalog mode when the CATALOG itself changes
  // (e.g. a special request's department is swapped, which also clears the value).
  // Keyed on the option signature only — so a manual "+ custom…" toggle (which does
  // not change the catalog) is preserved rather than immediately reset.
  const optionSig = labels.join('')
  useEffect(() => {
    setCustom(value !== '' && labels.length > 0 && !labels.includes(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionSig])

  const cls = `${compact ? 'h-7 text-xs' : 'h-8 text-sm'} flex-1 min-w-0 rounded-md border border-gray-200 px-2 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white`

  if (options.length === 0 || custom) {
    return (
      <div className="flex-1 min-w-0 flex items-center gap-1">
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={lang === 'th' ? 'รายการ' : 'item'} className={cls} />
        {options.length > 0 && (
          <button onClick={() => { setCustom(false); onChange('') }} title={lang === 'th' ? 'เลือกจากแคตตาล็อก' : 'Pick from catalog'}
            className="text-[10px] text-gray-400 hover:text-[var(--brand-primary)] flex-shrink-0 px-1">{lang === 'th' ? 'รายการ' : 'list'}</button>
        )}
      </div>
    )
  }
  return (
    <select value={value} onChange={(e) => { if (e.target.value === '__custom__') { setCustom(true); onChange('') } else onChange(e.target.value) }} className={cls}>
      <option value="">{lang === 'th' ? '— เลือก —' : '— select —'}</option>
      {options.map((it, i) => <option key={i} value={itemLabel(it)}>{it.code ? `${it.code}  ${it.description}` : it.description}</option>)}
      <option value="__custom__">{lang === 'th' ? '+ กำหนดเอง' : '+ custom…'}</option>
    </select>
  )
}

const cell = 'w-full h-8 rounded-md border border-gray-200 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white'
