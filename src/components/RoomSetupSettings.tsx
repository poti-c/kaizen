import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Loader2, Check, BedDouble, DoorOpen, Layers, Tag, Pencil } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'
import { DEFAULT_UNIT, unitOne, unitMany, capFirst, type UnitNoun } from '@/lib/roomUnit'

// ── shared types (reused by the Daily Room Order + recipes in later steps) ──────

export type Bed = 'king' | 'twin' | 'other'

export interface RoomCategory {
  id: string
  name: string
  name_th?: string
  order: number
}
export interface RoomType {
  code: string
  category: string // RoomCategory.id
  bed: Bed
}
export interface Room {
  no: string
  type: string // RoomType.code
}
export interface RoomConfig {
  unit?: UnitNoun
  categories: RoomCategory[]
  types: RoomType[]
  rooms: Room[]
}

const EMPTY: RoomConfig = { unit: DEFAULT_UNIT, categories: [], types: [], rooms: [] }
const BED_LABELS: Record<Bed, string> = { king: 'King', twin: 'Twin', other: 'Other' }
const BED_LABELS_TH: Record<Bed, string> = { king: 'เตียงคิง', twin: 'เตียงแฝด', other: 'อื่น ๆ' }
const bedLabel = (b: Bed, lang: string) => (lang === 'th' ? BED_LABELS_TH[b] : BED_LABELS[b])

/** Building letter prefix of a room number (A101 → "A"). */
function buildingOf(no: string): string {
  const m = no.trim().match(/^([A-Za-z]+)/)
  return m ? m[1].toUpperCase() : '—'
}
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'cat'
}
/** Naive English plural (good enough for Room/Hut/Villa/Resort/Suite/Cabin…). */
function pluralize(s: string): string {
  const t = s.trim()
  if (!t) return ''
  return /s$/i.test(t) ? t : `${t}s`
}

// ── main component ──────────────────────────────────────────────────────────────

export function RoomSetupSettings() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const companyId = activeCompany?.id ?? null

  const [cfg, setCfg] = useState<RoomConfig>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [canEdit, setCanEdit] = useState(false)
  const [editingUnit, setEditingUnit] = useState(false)

  const load = useCallback(async () => {
    if (!companyId || !profile) return
    setLoading(true)
    const cfgRes = await supabase.from('kaizen_settings').select('value')
      .eq('company_id', companyId).eq('key', 'rr_room_config').maybeSingle()
    const v = cfgRes.data?.value as RoomConfig | undefined
    setCfg(v && Array.isArray(v.categories) ? { unit: v.unit ?? DEFAULT_UNIT, categories: v.categories ?? [], types: v.types ?? [], rooms: v.rooms ?? [] } : EMPTY)
    setCanEdit(profile.role === 'super_admin' || profile.role === 'manager')
    setDirty(false)
    setLoading(false)
  }, [companyId, profile])
  useEffect(() => { load() }, [load])

  const mut = (fn: (c: RoomConfig) => RoomConfig) => { setCfg((c) => fn(c)); setDirty(true) }

  async function save() {
    if (!companyId) return
    setBusy(true)
    const u = cfg.unit ?? DEFAULT_UNIT
    const clean: RoomConfig = {
      unit: {
        one: capFirst(u.one.trim()) || DEFAULT_UNIT.one, many: capFirst(u.many.trim()) || DEFAULT_UNIT.many,
        one_th: u.one_th.trim() || (capFirst(u.one.trim()) || DEFAULT_UNIT.one), many_th: u.many_th.trim() || (capFirst(u.many.trim()) || DEFAULT_UNIT.many),
      },
      categories: cfg.categories.filter((c) => c.name.trim()).map((c, i) => ({ ...c, name: c.name.trim(), order: i + 1 })),
      types: cfg.types.filter((t) => t.code.trim()).map((t) => ({ ...t, code: t.code.trim().toUpperCase() })),
      rooms: cfg.rooms.filter((r) => r.no.trim()).map((r) => ({ ...r, no: r.no.trim().toUpperCase() })),
    }
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_room_config', value: clean }, { onConflict: 'company_id,key' })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    setCfg(clean); setDirty(false)
    toast.success(lang === 'th' ? 'บันทึกแล้ว' : 'Saved')
  }

  const catName = (id: string) => cfg.categories.find((c) => c.id === id)?.name || id
  const typeInfo = (code: string) => cfg.types.find((t) => t.code === code)

  // Rooms grouped by building, buildings sorted alphabetically, rooms numeric within.
  const buildings = Array.from(new Set(cfg.rooms.map((r) => buildingOf(r.no)))).sort()

  if (loading) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  if (!canEdit) return (
    <p className="text-sm text-gray-400 py-6 text-center">
      {lang === 'th' ? 'คุณไม่มีสิทธิ์แก้ไขการตั้งค่าห้อง' : "You don't have permission to edit room setup."}
    </p>
  )

  const sortedCats = cfg.categories.slice().sort((a, b) => a.order - b.order)
  const u = cfg.unit ?? DEFAULT_UNIT
  const one = unitOne(u, lang)   // e.g. "Room" / "Resort" / "ห้อง"
  const many = unitMany(u, lang) // e.g. "Rooms" / "Resorts"
  const setUnit = (patch: Partial<UnitNoun>) => mut((c) => ({ ...c, unit: { ...(c.unit ?? DEFAULT_UNIT), ...patch } }))

  return (
    <section className="space-y-7">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <DoorOpen className="h-4 w-4 text-gray-400" />
          <h3 className="font-semibold text-gray-900">{lang === 'th' ? `การตั้งค่า${one}` : `${one} Setup`}</h3>
          <button onClick={() => setEditingUnit((v) => !v)}
            title={lang === 'th' ? 'เปลี่ยนคำเรียก' : 'Rename'}
            className="p-1 rounded text-gray-300 hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/5 transition-colors">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="text-xs text-gray-500">
          {lang === 'th'
            ? `กำหนดหมวด ประเภท และรายการ${one}ทั้งหมด ใช้เป็นฐานสำหรับใบสั่งงานราย${one}`
            : `Define ${one.toLowerCase()} categories, ${one.toLowerCase()} types, and your ${one.toLowerCase()} inventory. This is the base for the per-${one.toLowerCase()} order form.`}
        </p>

        {/* Inline rename — pen toggles this */}
        {editingUnit && (
          <div className="mt-2.5 rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-2">
            <p className="text-[11px] text-gray-500">
              {lang === 'th' ? 'เปลี่ยนคำที่ใช้เรียก “ห้อง” (เช่น กระท่อม, รีสอร์ท) — ป้ายกำกับด้านล่างจะเปลี่ยนตาม' : 'Rename “Room” (e.g. Hut, Villa, Resort) — every label below updates to match.'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-[11px] text-gray-400">{lang === 'th' ? 'ชื่อ (อังกฤษ)' : 'Name (English)'}</span>
                <input autoFocus value={u.one}
                  onChange={(e) => { const v = e.target.value; setUnit({ one: v, many: pluralize(v) }) }}
                  placeholder="Room" className={cell} />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-gray-400">{lang === 'th' ? 'ชื่อ (ไทย)' : 'Name (Thai)'}</span>
                <input value={u.one_th}
                  onChange={(e) => { const v = e.target.value; setUnit({ one_th: v, many_th: v }) }}
                  placeholder="ห้อง" className={cell} />
              </label>
            </div>
            <button onClick={async () => { await save(); setEditingUnit(false) }} disabled={busy}
              className="flex items-center gap-1.5 text-xs font-medium text-white bg-[var(--brand-primary)] px-2.5 h-7 rounded-md disabled:opacity-50">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{lang === 'th' ? 'บันทึก' : 'Save name'}
            </button>
          </div>
        )}
      </div>

      {/* ── Categories ── */}
      <div>
        <SectionHead icon={Layers} title={lang === 'th' ? `หมวด${one}` : `${one} categories`}
          hint={lang === 'th' ? 'เรียงจากถูกสุดไปแพงสุด' : 'Ordered cheapest → most expensive'} />
        <div className="space-y-1.5">
          {sortedCats.map((cat) => {
            const idx = cfg.categories.findIndex((c) => c.id === cat.id)
            return (
              <div key={cat.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center rounded-lg border border-gray-100 bg-gray-50/40 px-3 py-2">
                <input value={cat.name} onChange={(e) => mut((c) => ({ ...c, categories: c.categories.map((x, i) => i === idx ? { ...x, name: e.target.value } : x) }))}
                  placeholder={lang === 'th' ? 'ชื่อหมวด' : 'Category name'} className={cell} />
                <input value={cat.name_th ?? ''} onChange={(e) => mut((c) => ({ ...c, categories: c.categories.map((x, i) => i === idx ? { ...x, name_th: e.target.value } : x) }))}
                  placeholder={lang === 'th' ? 'ชื่อ (ไทย)' : 'Thai name (optional)'} className={cell} />
                <button onClick={() => mut((c) => ({ ...c, categories: c.categories.filter((_, i) => i !== idx) }))}
                  className={delBtn} title={lang === 'th' ? 'ลบ' : 'Remove'}><Trash2 className="h-4 w-4" /></button>
              </div>
            )
          })}
          <button onClick={() => mut((c) => ({ ...c, categories: [...c.categories, { id: `cat_${slugify('new ' + (c.categories.length + 1))}`, name: '', name_th: '', order: c.categories.length + 1 }] }))}
            className={addBtn}><Plus className="h-4 w-4" />{lang === 'th' ? 'เพิ่มหมวด' : 'Add category'}</button>
        </div>
      </div>

      {/* ── Room types ── */}
      <div>
        <SectionHead icon={Tag} title={lang === 'th' ? `ประเภท${one}` : `${one} types`}
          hint={lang === 'th' ? 'รหัส → หมวด + เตียง' : 'Code → category + bed'} />
        <div className="space-y-1.5">
          {cfg.types.map((t, idx) => (
            <div key={idx} className="grid grid-cols-[72px_1fr_92px_auto] gap-2 items-center rounded-lg border border-gray-100 bg-gray-50/40 px-3 py-2">
              <input value={t.code} onChange={(e) => mut((c) => ({ ...c, types: c.types.map((x, i) => i === idx ? { ...x, code: e.target.value.toUpperCase() } : x) }))}
                placeholder="CODE" className={cell + ' font-mono uppercase'} />
              <select value={t.category} onChange={(e) => mut((c) => ({ ...c, types: c.types.map((x, i) => i === idx ? { ...x, category: e.target.value } : x) }))} className={cell}>
                {sortedCats.map((cat) => <option key={cat.id} value={cat.id}>{cat.name || cat.id}</option>)}
              </select>
              <select value={t.bed} onChange={(e) => mut((c) => ({ ...c, types: c.types.map((x, i) => i === idx ? { ...x, bed: e.target.value as Bed } : x) }))} className={cell}>
                {(['king', 'twin', 'other'] as Bed[]).map((b) => <option key={b} value={b}>{bedLabel(b, lang)}</option>)}
              </select>
              <button onClick={() => mut((c) => ({ ...c, types: c.types.filter((_, i) => i !== idx) }))}
                className={delBtn} title={lang === 'th' ? 'ลบ' : 'Remove'}><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <button onClick={() => mut((c) => ({ ...c, types: [...c.types, { code: '', category: sortedCats[0]?.id ?? '', bed: 'king' }] }))}
            className={addBtn}><Plus className="h-4 w-4" />{lang === 'th' ? 'เพิ่มประเภท' : 'Add type'}</button>
        </div>
      </div>

      {/* ── Rooms, grouped by building ── */}
      <div>
        <SectionHead icon={BedDouble} title={lang === 'th' ? `รายการ${one}` : many}
          hint={`${cfg.rooms.length} ${lang === 'th' ? one : many.toLowerCase()}`} />
        <div className="space-y-4">
          {buildings.map((b) => {
            const rows = cfg.rooms.map((r, i) => ({ r, i })).filter(({ r }) => buildingOf(r.no) === b)
              .sort((x, y) => x.r.no.localeCompare(y.r.no, undefined, { numeric: true }))
            return (
              <div key={b}>
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
                  {lang === 'th' ? 'อาคาร' : 'Building'} {b} <span className="text-gray-300 font-normal">· {rows.length}</span>
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {rows.map(({ r, i }) => {
                    const ti = typeInfo(r.type)
                    return (
                      <div key={i} className="flex items-center gap-1.5 rounded-lg border border-gray-100 bg-gray-50/40 px-2 py-1.5">
                        <input value={r.no} onChange={(e) => mut((c) => ({ ...c, rooms: c.rooms.map((x, j) => j === i ? { ...x, no: e.target.value.toUpperCase() } : x) }))}
                          className="w-14 h-8 rounded-md border border-gray-200 px-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white" />
                        <select value={r.type} onChange={(e) => mut((c) => ({ ...c, rooms: c.rooms.map((x, j) => j === i ? { ...x, type: e.target.value } : x) }))}
                          className="flex-1 min-w-0 h-8 rounded-md border border-gray-200 px-1 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white"
                          title={ti ? `${catName(ti.category)} · ${bedLabel(ti.bed, lang)}` : undefined}>
                          {cfg.types.map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
                        </select>
                        <button onClick={() => mut((c) => ({ ...c, rooms: c.rooms.filter((_, j) => j !== i) }))}
                          className="h-7 w-7 flex items-center justify-center rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <button onClick={() => mut((c) => ({ ...c, rooms: [...c.rooms, { no: '', type: c.types[0]?.code ?? '' }] }))}
            className={addBtn}><Plus className="h-4 w-4" />{lang === 'th' ? `เพิ่ม${one}` : `Add ${one.toLowerCase()}`}</button>
        </div>
      </div>

      {/* Save bar */}
      <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
        <button onClick={save} disabled={busy || !dirty}
          className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {lang === 'th' ? 'บันทึก' : 'Save'}
        </button>
        {dirty && <span className="text-[11px] text-amber-600">{lang === 'th' ? 'มีการเปลี่ยนแปลงที่ยังไม่บันทึก' : 'Unsaved changes'}</span>}
      </div>
    </section>
  )
}

function SectionHead({ icon: Icon, title, hint }: { icon: typeof Layers; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="h-3.5 w-3.5 text-gray-400" />
      <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
      {hint && <span className="text-[11px] text-gray-400">· {hint}</span>}
    </div>
  )
}

const cell = 'w-full h-8 rounded-md border border-gray-200 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white'
const delBtn = 'h-8 w-8 flex items-center justify-center rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0'
const addBtn = 'w-full flex items-center justify-center gap-1.5 h-9 rounded-lg border border-dashed border-gray-200 text-sm text-gray-400 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors mt-1'
