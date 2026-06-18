import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Trash2, Loader2, Check, ClipboardList, ArrowRight, X, ChevronDown } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { DEPARTMENT_LABELS, DEPARTMENTS, deptLabel, type Department } from '@/types'
import { toast } from 'sonner'

export interface RrItem {
  department: Department
  code: string
  description: string
  /** Catalog grouping: standard recipe items vs ad-hoc upsell/special requests. Missing = 'default'. */
  kind?: 'default' | 'special'
}

const DEPT_OPTIONS = DEPARTMENTS.filter((d) => d.value !== 'top_management')

// ── main component ────────────────────────────────────────────────────────────

export function RRSettings() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const companyId = activeCompany?.id ?? null

  const [items, setItems] = useState<RrItem[]>([])
  const [loading, setLoading] = useState(true)
  const [canEdit, setCanEdit] = useState(false)
  const [activeDept, setActiveDept] = useState<Department | null>(null)
  const [showDeptPicker, setShowDeptPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!companyId || !profile) return
    setLoading(true)
    const itemsRes = await supabase.from('kaizen_settings').select('value')
      .eq('company_id', companyId).eq('key', 'rr_items').maybeSingle()
    if (itemsRes.error) toast.error(itemsRes.error.message)
    const loadedItems = Array.isArray(itemsRes.data?.value) ? (itemsRes.data!.value as RrItem[]) : []
    setItems(loadedItems)
    setCanEdit(profile.role === 'super_admin' || profile.role === 'manager')
    setLoading(false)
  }, [companyId, profile])

  useEffect(() => { load() }, [load])

  // Close dept picker on outside click
  useEffect(() => {
    if (!showDeptPicker) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowDeptPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDeptPicker])

  async function saveItems(newItems: RrItem[]) {
    if (!companyId) return false
    const { error } = await supabase.from('kaizen_settings')
      .upsert({ company_id: companyId, key: 'rr_items', value: newItems }, { onConflict: 'company_id,key' })
    if (error) { toast.error(error.message); return false }
    setItems(newItems)
    return true
  }

  // Grouped departments
  const grouped = items.reduce<Partial<Record<Department, RrItem[]>>>((acc, it) => {
    if (!acc[it.department]) acc[it.department] = []
    acc[it.department]!.push(it)
    return acc
  }, {})
  const activeDepts = (Object.keys(grouped) as Department[])
    .sort((a, b) => DEPARTMENT_LABELS[a].localeCompare(DEPARTMENT_LABELS[b]))

  if (loading) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  if (!canEdit) return (
    <p className="text-sm text-gray-400 py-6 text-center">
      {lang === 'th' ? 'คุณไม่มีสิทธิ์แก้ไขรายการนี้' : 'You don\'t have permission to edit RR items.'}
    </p>
  )

  return (
    <section className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ClipboardList className="h-4 w-4 text-gray-400" />
          <h3 className="font-semibold text-gray-900">
            {lang === 'th' ? 'รายการ Routine Roster' : 'Routine Roster Items'}
          </h3>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          {lang === 'th'
            ? 'กำหนดรายการตามแผนกผู้ดำเนินการ ใช้เลือกในเทมเพลต Routine Roster'
            : 'Define items per fulfilling department. Used as quick-pick options in Routine Roster templates.'}
        </p>

        {/* Department tiles */}
        {activeDepts.length === 0 ? (
          <div className="text-center py-10 rounded-xl border border-dashed border-gray-200 text-sm text-gray-400 mb-4">
            {lang === 'th' ? 'ยังไม่มีรายการ กดปุ่มด้านล่างเพื่อเริ่ม' : 'No items yet. Add your first item below.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            {activeDepts.map((dept) => (
              <button key={dept} onClick={() => setActiveDept(dept)}
                className="flex flex-col items-start gap-1.5 rounded-xl border border-gray-200 bg-white p-4 hover:border-[var(--brand-primary)] hover:shadow-sm transition-all text-left group">
                <span className="text-sm font-semibold text-gray-800 group-hover:text-[var(--brand-primary)] transition-colors leading-tight">
                  {deptLabel(dept, lang)}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-[11px] font-medium text-gray-500">
                  {grouped[dept]!.length} {lang === 'th' ? 'รายการ' : 'items'}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Add item — inline dept picker */}
        <div>
          <button onClick={() => setShowDeptPicker((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/5 px-3 h-9 rounded-lg border border-[var(--brand-primary)]/30 transition-colors">
            <Plus className="h-4 w-4" />
            {lang === 'th' ? 'เพิ่มรายการ' : 'Add item'}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showDeptPicker ? 'rotate-180' : ''}`} />
          </button>
          {showDeptPicker && (
            <div className="mt-2 rounded-xl border border-gray-200 bg-white overflow-hidden">
              <p className="px-3 py-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">
                {lang === 'th' ? 'เลือกแผนก' : 'Select department'}
              </p>
              <div className="divide-y divide-gray-50">
                {DEPT_OPTIONS.map((d) => (
                  <button key={d.value} onClick={() => { setActiveDept(d.value); setShowDeptPicker(false) }}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 text-left transition-colors">
                    <span>{deptLabel(d.value, lang)}</span>
                    {grouped[d.value] && (
                      <span className="text-[11px] text-gray-400 font-medium">{grouped[d.value]!.length} {lang === 'th' ? 'รายการ' : 'items'}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Department item modal */}
      {activeDept !== null && (
        <DeptModal
          dept={activeDept}
          allItems={items}
          lang={lang}
          onClose={() => setActiveDept(null)}
          onSave={saveItems}
        />
      )}
    </section>
  )
}

// ── department item modal ──────────────────────────────────────────────────────

function DeptModal({ dept, allItems, lang, onClose, onSave }: {
  dept: Department
  allItems: RrItem[]
  lang: 'en' | 'th'
  onClose: () => void
  onSave: (items: RrItem[]) => Promise<boolean>
}) {
  const [local, setLocal] = useState<RrItem[]>(allItems)
  const [busy, setBusy] = useState(false)
  const [transferIdx, setTransferIdx] = useState<number | null>(null)
  const transferRef = useRef<HTMLDivElement>(null)

  const otherDepts = DEPT_OPTIONS.filter((d) => d.value !== dept)

  // Close transfer picker on outside click
  useEffect(() => {
    if (transferIdx === null) return
    const handler = (e: MouseEvent) => {
      if (transferRef.current && !transferRef.current.contains(e.target as Node)) setTransferIdx(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [transferIdx])

  function addRow() {
    setLocal((prev) => [...prev, { department: dept, code: '', description: '' }])
    // Let the new row appear before scrolling
    setTimeout(() => {
      const el = document.getElementById('rr-item-list-bottom')
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }

  function patch(globalIdx: number, field: keyof RrItem, value: string) {
    setLocal((prev) => prev.map((it, i) => i === globalIdx ? { ...it, [field]: value } : it))
  }

  function remove(globalIdx: number) {
    setLocal((prev) => prev.filter((_, i) => i !== globalIdx))
  }

  function transfer(globalIdx: number, targetDept: Department) {
    setLocal((prev) => prev.map((it, i) => i === globalIdx ? { ...it, department: targetDept } : it))
    setTransferIdx(null)
    toast.success(lang === 'th'
      ? `ย้ายไป ${deptLabel(targetDept, lang)} แล้ว — กดบันทึกเพื่อยืนยัน`
      : `Moved to ${deptLabel(targetDept, lang)} — click Save to confirm`)
  }

  async function save() {
    setBusy(true)
    const clean = local.filter((it) => it.code.trim() || it.description.trim())
    const ok = await onSave(clean)
    setBusy(false)
    if (ok) onClose()
  }

  const deptRows = local.map((it, i) => ({ it, i })).filter(({ it }) => it.department === dept)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-gray-900">{deptLabel(dept, lang)}</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {deptRows.length} {lang === 'th' ? 'รายการ' : 'items'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Items — one flat list for this department */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          <div className="space-y-1.5">
            {deptRows.map(({ it, i }) => (
              <div key={i} className="flex items-center gap-1.5 rounded-lg border border-gray-100 bg-gray-50/40 px-2.5 py-2">
                <input value={it.code} onChange={(e) => patch(i, 'code', e.target.value)} placeholder="—"
                  className="w-14 h-8 rounded-md border border-gray-200 px-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white flex-shrink-0" />
                <input value={it.description} onChange={(e) => patch(i, 'description', e.target.value)}
                  placeholder={lang === 'th' ? 'คำอธิบาย' : 'Description'}
                  className="flex-1 min-w-0 h-8 rounded-md border border-gray-200 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]/40 bg-white" />

                {/* Transfer to another department */}
                <div className="relative flex-shrink-0" ref={transferIdx === i ? transferRef : undefined}>
                  <button onClick={() => setTransferIdx(transferIdx === i ? null : i)}
                    title={lang === 'th' ? 'ย้ายไปแผนกอื่น' : 'Transfer to another dept'}
                    className="h-8 w-8 flex items-center justify-center rounded-md text-gray-300 hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/5 transition-colors">
                    <ArrowRight className="h-4 w-4" />
                  </button>
                  {transferIdx === i && (
                    <div className="absolute right-0 top-9 z-20 bg-white rounded-xl border border-gray-200 shadow-lg py-1 min-w-[160px] max-w-[calc(100vw-3rem)]">
                      <p className="px-3 py-1 text-[11px] font-semibold text-gray-400 uppercase">{lang === 'th' ? 'ย้ายไป' : 'Move to'}</p>
                      {otherDepts.map((d) => (
                        <button key={d.value} onClick={() => transfer(i, d.value)}
                          className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-[var(--brand-primary)]">{deptLabel(d.value, lang)}</button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Delete */}
                <button onClick={() => remove(i)}
                  className="h-8 w-8 flex items-center justify-center rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {deptRows.length === 0 && (
              <p className="text-xs text-gray-400 py-1.5 px-1">{lang === 'th' ? 'ยังไม่มีรายการ' : 'None yet.'}</p>
            )}
            <button onClick={() => addRow()}
              className="w-full flex items-center justify-center gap-1.5 h-9 rounded-lg border border-dashed border-gray-200 text-sm text-gray-400 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors">
              <Plus className="h-4 w-4" />{lang === 'th' ? 'เพิ่มรายการ' : 'Add item'}
            </button>
          </div>
          <div id="rr-item-list-bottom" />
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200 flex-shrink-0">
          <button onClick={save} disabled={busy}
            className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {lang === 'th' ? 'บันทึก' : 'Save'}
          </button>
          <button onClick={onClose} className="px-3 h-9 rounded-lg text-gray-500 hover:bg-gray-100 text-sm">
            {lang === 'th' ? 'ยกเลิก' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}
