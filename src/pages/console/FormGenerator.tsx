import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  FileText, Loader2, Plus, Trash2, ArrowLeft, Printer, X, Check, Building2, Search, Languages, Eye, ChevronLeft, ChevronRight,
} from 'lucide-react'
import { composeAddress, type ThaiAddress } from './BillingAddressFields'
import { bangkokDate } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────
export type FormType = 'quotation' | 'invoice' | 'tax_invoice_receipt' | 'receipt'
export type DocLang = 'en' | 'th'

interface LineItem { description: string; qty: number; unit_price: number }
// Structured (bilingual) buyer address snapshotted on the form so the document
// can be printed in either language regardless of later edits.
interface ClientBilling extends ThaiAddress { office_type?: string; branch_code?: string }
interface GeneratedForm {
  id: string; form_type: FormType; doc_number: string; company_id: string | null
  client_name: string | null; client_address: string | null; client_tax_id: string | null
  client_billing?: ClientBilling | null
  client_contact: string | null; client_phone: string | null; client_email: string | null
  issue_date: string; due_date: string | null; line_items: LineItem[]; currency: string
  non_vat_amount: number; subtotal: number; vat_rate: number; vat_amount: number; total: number
  discount_code: string | null; discount_percent: number; discount_amount: number
  notes: string | null; status: string; created_at: string
}
interface CatalogProduct { id: string; kind: string; name: string; price: number; currency: string }
interface CatalogPromo { id: string; code: string; discount_percent: number; valid_from: string | null; valid_to: string | null }
interface FormCompany {
  id: string; name: string; address: string | null; tax_id: string | null
  contact_person: string | null; contact_phone: string | null; contact_email: string | null
  office_type?: string | null; branch_code?: string | null; billing_address?: ThaiAddress | null
}
interface Issuer {
  company_name: string | null; office_type: string; branch_name: string | null; branch_code?: string | null
  address: string | null; billing_address?: ThaiAddress | null; tax_id: string | null; logo_url?: string | null
  signatory_name?: string | null; signatory_title?: string | null
  phone?: string | null; email?: string | null; website?: string | null
}
type Call = <T,>(a: string, p?: Record<string, unknown>) => Promise<T>

// Document-number prefixes — must match the edge function's FORM_PREFIX. Used
// only to PREDICT the number shown in the preview; the server assigns the
// authoritative number when the document is confirmed.
const DOC_PREFIX: Record<FormType, string> = { quotation: 'QUO', invoice: 'INV', tax_invoice_receipt: 'TAX', receipt: 'REC' }

// ── Config ───────────────────────────────────────────────────────────────────
const FORM_TYPES: { key: FormType; label: string; thai: string }[] = [
  { key: 'quotation', label: 'Quotation', thai: 'ใบเสนอราคา' },
  { key: 'invoice', label: 'Invoice', thai: 'ใบแจ้งหนี้' },
  { key: 'tax_invoice_receipt', label: 'Tax Invoice / Receipt', thai: 'ใบกำกับภาษี/ใบเสร็จรับเงิน' },
  { key: 'receipt', label: 'Receipt', thai: 'ใบเสร็จรับเงิน' },
]
const STATUSES: Record<FormType, string[]> = {
  quotation: ['draft', 'sent', 'accepted', 'expired', 'followup', 'cancelled'],
  invoice: ['draft', 'sent', 'paid', 'overdue', 'followup', 'cancelled'],
  tax_invoice_receipt: ['draft', 'issued', 'paid', 'followup', 'cancelled'],
  receipt: ['issued', 'followup', 'cancelled'],
}
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted', expired: 'Expired', followup: 'Follow-up',
  cancelled: 'Cancelled', paid: 'Paid', overdue: 'Overdue', issued: 'Issued',
}
function typeLabel(t: FormType) { return FORM_TYPES.find(f => f.key === t)?.label ?? t }
function typeThai(t: FormType) { return FORM_TYPES.find(f => f.key === t)?.thai ?? '' }

function statusCls(s: string) {
  switch (s) {
    case 'paid': case 'accepted': return 'bg-green-500/15 text-green-400 border-green-500/30'
    case 'overdue': case 'expired': case 'cancelled': return 'bg-red-500/15 text-red-400 border-red-500/30'
    case 'followup': return 'bg-amber-500/15 text-amber-400 border-amber-500/30'
    case 'sent': case 'issued': return 'bg-sky-500/15 text-sky-400 border-sky-500/30'
    default: return 'bg-slate-800 text-slate-300 border-slate-700'
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const inputCls = 'w-full h-9 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50'
const selectCls = 'h-9 rounded-lg bg-slate-800 border border-slate-700 px-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50'

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d.length <= 10 ? d + 'T00:00:00+07:00' : d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' })
}
function money(n: number) {
  if (!Number.isFinite(n)) n = 0
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// English number-to-words for the amount-in-words line
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
function below1000(n: number): string {
  let s = ''
  if (n >= 100) { s += ONES[Math.floor(n / 100)] + ' hundred'; n %= 100; if (n) s += ' ' }
  if (n >= 20) { s += TENS[Math.floor(n / 10)]; if (n % 10) s += '-' + ONES[n % 10] }
  else if (n > 0) s += ONES[n]
  return s
}
function intToWords(n: number): string {
  if (n === 0) return 'zero'
  const units = [['quadrillion', 1e15], ['trillion', 1e12], ['billion', 1e9], ['million', 1e6], ['thousand', 1e3]] as const
  let s = ''
  for (const [name, val] of units) {
    if (n >= val) { s += below1000(Math.floor(n / val)) + ' ' + name + ' '; n %= val }
  }
  if (n > 0) s += below1000(n)
  return s.trim()
}
function bahtText(amount: number): string {
  const n = Math.round(amount * 100) / 100
  const baht = Math.floor(n)
  const satang = Math.round((n - baht) * 100)
  let s = intToWords(baht) + ' baht'
  if (satang > 0) s += ' and ' + intToWords(satang) + ' satang'
  return s
}

// Thai amount-in-words (อ่านจำนวนเงินเป็นตัวอักษร)
const TH_NUM = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า']
const TH_POS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน']
function thaiReadGroup(n: number): string {
  const str = String(n)
  const len = str.length
  let s = ''
  for (let i = 0; i < len; i++) {
    const d = +str[i]
    const pos = len - 1 - i
    if (d === 0) continue
    if (pos === 1 && d === 1) s += 'สิบ'
    else if (pos === 1 && d === 2) s += 'ยี่สิบ'
    else if (pos === 0 && d === 1 && len > 1) s += 'เอ็ด'
    else s += TH_NUM[d] + TH_POS[pos]
  }
  return s
}
function thaiReadNumber(n: number): string {
  if (n === 0) return 'ศูนย์'
  const million = Math.floor(n / 1000000)
  const rest = n % 1000000
  let s = ''
  if (million > 0) s += thaiReadNumber(million) + 'ล้าน'
  if (rest > 0) s += thaiReadGroup(rest)
  return s
}
function bahtTextTh(amount: number): string {
  const n = Math.round(amount * 100) / 100
  const baht = Math.floor(n)
  const satang = Math.round((n - baht) * 100)
  let s = baht > 0 ? thaiReadNumber(baht) + 'บาท' : 'ศูนย์บาท'
  s += satang > 0 ? thaiReadNumber(satang) + 'สตางค์' : 'ถ้วน'
  return s
}

// Bilingual document labels — the generated document can be rendered EN or TH.
const DOC_T = {
  en: {
    original: 'Original', docNo: 'Document No.', date: 'Date', dueDate: 'Due Date', paymentDate: 'Payment Date',
    headOffice: 'Head Office', branch: (c?: string | null) => `Branch${c ? ` #${c}` : ''}`, taxId: 'Tax ID',
    client: 'Bill To', attn: 'Attn:', tel: 'Tel', no: '#', description: 'Description', qty: 'Qty', unitPrice: 'Unit Price', amount: 'Amount',
    subtotal: 'Subtotal (excl. VAT)', discount: 'Discount', nonVat: 'Non-VAT / exempt', vat: 'VAT', grandTotal: 'Grand Total',
    validity: 'Validity:', notes: 'Notes:', authSig: 'Authorised Signature / Date', clientLabel: 'Client',
    thankyou: 'Thank you for your business. We look forward to serving you.',
    validityText: (days: number, until: string) => `This quotation is valid for ${days} day${days === 1 ? '' : 's'} from the issue date — until ${until}.`,
  },
  th: {
    original: 'ต้นฉบับ', docNo: 'เลขที่เอกสาร', date: 'วันที่', dueDate: 'ครบกำหนด', paymentDate: 'วันที่ชำระเงิน',
    headOffice: 'สำนักงานใหญ่', branch: (c?: string | null) => `สาขาที่ ${c || '—'}`, taxId: 'เลขประจำตัวผู้เสียภาษี',
    client: 'ลูกค้า', attn: 'เรียน', tel: 'โทร', no: 'ลำดับ', description: 'รายการ', qty: 'จำนวน', unitPrice: 'ราคาต่อหน่วย', amount: 'จำนวนเงิน',
    subtotal: 'ยอดรวม (ก่อน VAT)', discount: 'ส่วนลด', nonVat: 'รายการยกเว้น VAT', vat: 'ภาษีมูลค่าเพิ่ม', grandTotal: 'ยอดรวมทั้งสิ้น',
    validity: 'ระยะเวลายืนราคา:', notes: 'หมายเหตุ:', authSig: 'ลายมือชื่อผู้มีอำนาจ / วันที่', clientLabel: 'ลูกค้า',
    thankyou: 'ขอบคุณที่ใช้บริการ เราหวังเป็นอย่างยิ่งที่จะได้ให้บริการท่าน',
    validityText: (days: number, until: string) => `ใบเสนอราคานี้มีอายุ ${days} วันนับจากวันที่ออก — ถึงวันที่ ${until}`,
  },
} as const

function fmtDateLang(d: string | null, lang: DocLang) {
  if (!d) return '—'
  const date = new Date(d.length <= 10 ? d + 'T00:00:00+07:00' : d)
  return date.toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' })
}

// ── Main view ────────────────────────────────────────────────────────────────
interface FormDraft { formType: FormType; companyId?: string; items?: LineItem[]; invoiceId?: string }
export function FormGeneratorView({ call, onBack, initialPreviewId, onPreviewConsumed, initialDraft, onDraftConsumed }: { call: Call; onBack: () => void; initialPreviewId?: string | null; onPreviewConsumed?: () => void; initialDraft?: FormDraft | null; onDraftConsumed?: () => void }) {
  const [loading, setLoading] = useState(true)
  const [forms, setForms] = useState<GeneratedForm[]>([])
  const [companies, setCompanies] = useState<FormCompany[]>([])
  const [issuer, setIssuer] = useState<Issuer | null>(null)
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [promos, setPromos] = useState<CatalogPromo[]>([])
  const [tab, setTab] = useState<FormType>('quotation')
  const [preview, setPreview] = useState<GeneratedForm | null>(null)
  // When set, the open preview is an unconfirmed draft not yet recorded.
  const [draftPayload, setDraftPayload] = useState<Record<string, unknown> | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmSignal, setConfirmSignal] = useState(0)
  const [filterType, setFilterType] = useState<'all' | FormType>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [draft, setDraft] = useState<FormDraft | null>(initialDraft ?? null)
  const [linkInvoiceId, setLinkInvoiceId] = useState<string | null>(initialDraft?.invoiceId ?? null)
  useEffect(() => { if (initialDraft) { setDraft(initialDraft); setTab(initialDraft.formType); setLinkInvoiceId(initialDraft.invoiceId ?? null) } }, [initialDraft])

  // Persist the document only when the admin confirms the preview — nothing is
  // recorded in History until then. Linking to a receipt request (if any)
  // happens once the record exists.
  async function confirmDraft() {
    if (!draftPayload) return
    setConfirming(true)
    try {
      const { form } = await call<{ form: GeneratedForm }>('create_form', draftPayload)
      if (linkInvoiceId) { try { await call('link_receipt_form', { invoice_id: linkInvoiceId, form_id: form.id }) } catch (e) { console.error(e) } }
      setLinkInvoiceId(null); setDraftPayload(null); setPreview(null); setConfirmSignal(s => s + 1); load()
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed to record the document.') }
    finally { setConfirming(false) }
  }
  // Close the preview without recording — returns to the editor with data intact.
  // Also release any pending receipt link, otherwise the NEXT unrelated document that
  // gets confirmed would be silently linked to this stale invoice id.
  function discardDraft() { setDraftPayload(null); setPreview(null); setLinkInvoiceId(null) }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await call<{ forms: GeneratedForm[]; companies: FormCompany[]; issuer: Issuer | null; products: CatalogProduct[]; promos: CatalogPromo[] }>('list_forms')
      setForms(d.forms); setCompanies(d.companies); setIssuer(d.issuer)
      setProducts(d.products ?? []); setPromos(d.promos ?? [])
    } catch (e) { console.error('Forms load failed:', e) } finally { setLoading(false) }
  }, [call])
  useEffect(() => { load() }, [load])

  // Deep-link: open a specific form's preview when navigated from the Calendar.
  useEffect(() => {
    if (!initialPreviewId || !forms.length) return
    const target = forms.find(f => f.id === initialPreviewId)
    if (target) { setDraftPayload(null); setFilterType(target.form_type); setPreview(target); onPreviewConsumed?.() }
  }, [initialPreviewId, forms, onPreviewConsumed])

  const filtered = filterType === 'all' ? forms : forms.filter(f => f.form_type === filterType)
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageClamped = Math.min(page, totalPages)
  const paged = filtered.slice((pageClamped - 1) * pageSize, pageClamped * pageSize)
  useEffect(() => { setPage(1) }, [filterType, pageSize])

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white mb-4">
        <ArrowLeft className="h-3.5 w-3.5" />Back
      </button>
      <div className="flex items-center gap-2 mb-1">
        <FileText className="h-5 w-5 text-amber-400" />
        <h2 className="text-lg font-bold text-white">Form Generator</h2>
      </div>
      <p className="text-xs text-slate-400 mb-5">Create quotations, invoices and receipts for your customers · issued by {issuer?.company_name || 'NNR-Solutions'}</p>

      {!issuer?.company_name && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs rounded-lg px-3 py-2 mb-4">
          Tip: set your company name, address and Tax ID in <span className="font-semibold">Settings → Company Details</span> — they appear as the issuer on every document.
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800 mb-5 overflow-x-auto">
        {FORM_TYPES.map(ft => (
          <button key={ft.key} onClick={() => setTab(ft.key)}
            className={`px-3 py-2.5 text-xs font-medium border-b-2 whitespace-nowrap transition-colors ${tab === ft.key ? 'border-amber-500 text-amber-400' : 'border-transparent text-slate-400 hover:text-slate-300'}`}>
            {ft.label}
          </button>
        ))}
      </div>

      <FormEditor
        key={tab}
        formType={tab}
        companies={companies}
        products={products}
        promos={promos}
        existingForms={forms}
        resetSignal={confirmSignal}
        initialCompanyId={draft && draft.formType === tab ? draft.companyId : undefined}
        initialItems={draft && draft.formType === tab ? draft.items : undefined}
        onPrefilled={() => { setDraft(null); onDraftConsumed?.() }}
        onView={(previewForm, payload) => { setPreview(previewForm); setDraftPayload(payload) }}
        call={call}
      />

      {/* History */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mt-6">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <FileText className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-white">History</h3>
          <span className="text-[11px] text-slate-400">{filtered.length}</span>
          <select value={filterType} onChange={e => setFilterType(e.target.value as 'all' | FormType)} className={selectCls + ' ml-auto h-7 text-xs'}>
            <option value="all">All types</option>
            {FORM_TYPES.map(ft => <option key={ft.key} value={ft.key}>{ft.label}</option>)}
          </select>
        </div>
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-slate-300" /></div>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-300">No forms generated yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-800">
                  <th className="text-left font-semibold px-4 py-2">Date</th>
                  <th className="text-left font-semibold px-3 py-2">Doc No.</th>
                  <th className="text-left font-semibold px-3 py-2">Type</th>
                  <th className="text-left font-semibold px-3 py-2">Client</th>
                  <th className="text-right font-semibold px-3 py-2">Amount</th>
                  <th className="text-left font-semibold px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {paged.map(f => (
                  <tr key={f.id} className="hover:bg-slate-800">
                    <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">{fmtDate(f.issue_date)}</td>
                    <td className="px-3 py-2.5 font-mono text-amber-400 whitespace-nowrap">{f.doc_number}</td>
                    <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{typeLabel(f.form_type)}</td>
                    <td className="px-3 py-2.5 text-white max-w-[180px] truncate">{f.client_name || '—'}</td>
                    <td className="px-3 py-2.5 text-right text-slate-200 whitespace-nowrap">{f.currency} {money(f.total)}</td>
                    <td className="px-3 py-2.5">
                      <StatusPicker form={f} call={call} onChanged={load} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => setPreview(f)} title="View / Print" className="p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-800"><Printer className="h-4 w-4" /></button>
                        <DeleteFormBtn form={f} call={call} onDeleted={load} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > 10 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-4 py-3 border-t border-slate-800">
            <p className="text-xs text-slate-400">
              Showing {(pageClamped - 1) * pageSize + 1}–{Math.min(pageClamped * pageSize, filtered.length)} of {filtered.length}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={pageClamped === 1}
                className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-slate-700 text-xs text-slate-300 disabled:opacity-40 hover:border-slate-600"><ChevronLeft className="h-3.5 w-3.5" />Prev</button>
              <span className="text-xs text-slate-400">Page {pageClamped} of {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={pageClamped >= totalPages}
                className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-slate-700 text-xs text-slate-300 disabled:opacity-40 hover:border-slate-600">Next {pageSize}<ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>Display</span>
              {[10, 20, 30].map(opt => (
                <button key={opt} onClick={() => setPageSize(opt)}
                  className={`h-7 w-8 rounded-md border text-xs font-medium transition-colors ${pageSize === opt ? 'bg-amber-500 text-slate-950 border-amber-500' : 'bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-600'}`}>{opt}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {preview && <PrintPreview form={preview} issuer={issuer}
        unconfirmed={!!draftPayload} confirming={confirming} onConfirm={confirmDraft}
        onClose={() => { if (draftPayload) discardDraft(); else setPreview(null) }} />}
    </div>
  )
}

// ── Status dropdown in history ───────────────────────────────────────────────
function StatusPicker({ form, call, onChanged }: { form: GeneratedForm; call: Call; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const opts = STATUSES[form.form_type]
  async function change(status: string) {
    if (status === form.status) return
    setBusy(true)
    try { await call('update_form_status', { form_id: form.id, status }); onChanged() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false) }
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <select value={form.status} disabled={busy} onChange={e => change(e.target.value)}
        className={`text-[11px] rounded-md border px-1.5 py-1 focus:outline-none ${statusCls(form.status)} bg-transparent`}>
        {opts.map(s => <option key={s} value={s} className="bg-slate-800 text-slate-200">{STATUS_LABEL[s] ?? s}</option>)}
      </select>
      {busy && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
    </span>
  )
}

function DeleteFormBtn({ form, call, onDeleted }: { form: GeneratedForm; call: Call; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  async function del() {
    setBusy(true)
    try { await call('delete_form', { form_id: form.id }); onDeleted() }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false); setConfirming(false) }
  }
  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1">
        <button onClick={del} disabled={busy} className="text-[11px] px-1.5 py-1 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25">{busy ? '…' : 'Delete'}</button>
        <button onClick={() => setConfirming(false)} className="text-[11px] px-1.5 py-1 rounded text-slate-400 hover:bg-slate-800">Cancel</button>
      </span>
    )
  }
  return <button onClick={() => setConfirming(true)} title="Delete" className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
}

// ── Editor ───────────────────────────────────────────────────────────────────
function FormEditor({ formType, companies, products, promos, existingForms, resetSignal, onView, call, initialCompanyId, initialItems, onPrefilled }: {
  formType: FormType; companies: FormCompany[]; products: CatalogProduct[]; promos: CatalogPromo[]
  existingForms: GeneratedForm[]; resetSignal?: number
  onView: (previewForm: GeneratedForm, payload: Record<string, unknown>) => void; call: Call
  initialCompanyId?: string; initialItems?: LineItem[]; onPrefilled?: () => void
}) {
  // Asia/Bangkok day, not UTC — the issue date drives the document number prefix, so a
  // UTC default would mis-date/mis-number documents created during 00:00–07:00 Bangkok.
  const today = bangkokDate()
  const [companyId, setCompanyId] = useState<string>('')
  const [client, setClient] = useState({ name: '', address: '', tax_id: '', contact: '', phone: '', email: '' })
  const [clientBilling, setClientBilling] = useState<ClientBilling | null>(null)
  const [issueDate, setIssueDate] = useState(today)
  const [dueDate, setDueDate] = useState('')
  const [currency, setCurrency] = useState('THB')
  const [vatRate, setVatRate] = useState('7')
  const [items, setItems] = useState<LineItem[]>([{ description: '', qty: 1, unit_price: 0 }])
  const [promoId, setPromoId] = useState('')
  const [discountMode, setDiscountMode] = useState<'promo' | 'percent' | 'value'>('promo')
  const [discountPctInput, setDiscountPctInput] = useState('')
  const [discountValInput, setDiscountValInput] = useState('')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState(STATUSES[formType][0])
  const [error, setError] = useState('')

  // Promo codes valid on the issue date
  const validPromos = useMemo(() => promos.filter(p =>
    (!p.valid_from || p.valid_from <= issueDate) && (!p.valid_to || p.valid_to >= issueDate)
  ), [promos, issueDate])
  const promo = validPromos.find(p => p.id === promoId) || null

  function addProduct(id: string) {
    const p = products.find(x => x.id === id)
    if (!p) return
    setItems(its => {
      // Drop blank rows (the starter row defaults qty:1, so ignore qty here)
      // so the product fills in cleanly instead of leaving an empty line behind.
      const base = its.filter(it => it.description.trim() || it.unit_price)
      return [...base, { description: p.name, qty: 1, unit_price: p.price }]
    })
  }

  function pickCompany(id: string) {
    setCompanyId(id)
    const c = companies.find(x => x.id === id)
    if (c) {
      // Snapshot the structured bilingual address so the document can switch
      // languages; the editor textarea shows the English one-liner.
      const billing = c.billing_address ?? null
      setClientBilling(billing ? { ...billing, office_type: c.office_type ?? 'head_office', branch_code: c.branch_code ?? '' } : null)
      setClient({
        name: c.name, address: composeAddress(billing, 'en') || c.address || '', tax_id: c.tax_id ?? '',
        contact: c.contact_person ?? '', phone: c.contact_phone ?? '', email: c.contact_email ?? '',
      })
    } else {
      setClientBilling(null)
      setClient({ name: '', address: '', tax_id: '', contact: '', phone: '', email: '' })
    }
  }
  function setItem(i: number, patch: Partial<LineItem>) {
    setItems(items.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }

  // Prefill once when opened from "Issue" on a receipt request.
  // Wait for `companies` to load before running pickCompany — if companies is still []
  // the lookup returns nothing, client fields are cleared and the draft is silently lost.
  const prefilled = useRef(false)
  useEffect(() => {
    if (prefilled.current || (!initialCompanyId && !initialItems)) return
    if (initialCompanyId && !companies.length) return
    prefilled.current = true
    if (initialCompanyId) pickCompany(initialCompanyId)
    if (initialItems && initialItems.length) setItems(initialItems)
    // The line amount already equals what the client paid, so no VAT or
    // discount is applied on top — the receipt total must match the payment.
    setVatRate('0')
    setDiscountMode('promo'); setPromoId(''); setDiscountPctInput(''); setDiscountValInput('')
    onPrefilled?.()
  }, [initialCompanyId, initialItems, companies])  // eslint-disable-line react-hooks/exhaustive-deps

  const subtotal = useMemo(() => items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0), [items])
  // Discount by promo code, a manual percentage, or a fixed value (capped at subtotal).
  const discount = useMemo(() => {
    if (discountMode === 'promo') return subtotal * (promo?.discount_percent || 0) / 100
    if (discountMode === 'percent') return subtotal * Math.min(100, Math.max(0, Number(discountPctInput) || 0)) / 100
    return Math.min(Math.max(0, Number(discountValInput) || 0), subtotal)
  }, [discountMode, promo, discountPctInput, discountValInput, subtotal])
  const net = subtotal - discount
  const vat = useMemo(() => net * (Number(vatRate) || 0) / 100, [net, vatRate])
  const total = net + vat

  // After a document is confirmed & recorded, clear the line items (keep the
  // client selected for convenience).
  useEffect(() => {
    if (resetSignal) {
      setItems([{ description: '', qty: 1, unit_price: 0 }])
      setNotes('')
      setIssueDate(bangkokDate())
      setDueDate('')
      setVatRate('7')
      setDiscountMode('promo')
      setPromoId('')
      setDiscountPctInput('')
      setDiscountValInput('')
      setStatus(STATUSES[formType][0])
    }
  }, [resetSignal, formType])

  // Build a preview (nothing is saved yet) and hand it to the parent. The form
  // is only recorded once the admin confirms the preview.
  function openPreview() {
    setError('')
    if (!issueDate) { setError('Issue date is required.'); return }
    // Require a description or a price (not qty alone) — otherwise the default starter
    // row (qty:1) or a stray qty prints a blank-description 0.00 line. Matches the
    // item-count badge predicate so the editor count and the document agree.
    const valid = items.filter(it => it.description.trim() || it.unit_price)
    if (valid.length === 0) { setError('Add at least one line item.'); return }
    if (!client.name.trim()) { setError('Select a company or enter a client name.'); return }
    const vatNum = Number(vatRate) || 0
    // Resolve the discount fields for the chosen method. A fixed value is sent
    // as discount_amount (server uses it directly); promo/percent send a percent.
    const discCode = discountMode === 'promo' ? promo?.code : undefined
    const discPct = discountMode === 'promo' ? (promo?.discount_percent || 0)
      : discountMode === 'percent' ? Math.min(100, Math.max(0, Number(discountPctInput) || 0)) : 0
    const discAmount = discountMode === 'value' ? Math.min(Math.max(0, Number(discountValInput) || 0), subtotal) : undefined
    const payload: Record<string, unknown> = {
      form_type: formType,
      company_id: companyId || undefined,
      client_name: client.name, client_address: client.address, client_tax_id: client.tax_id,
      client_billing: clientBilling ?? undefined,
      client_contact: client.contact, client_phone: client.phone, client_email: client.email,
      issue_date: issueDate, due_date: dueDate || undefined,
      line_items: valid, currency, vat_rate: vatNum,
      discount_code: discCode, discount_percent: discPct, discount_amount: discAmount,
      notes: notes.trim() || undefined, status,
    }
    // The authoritative document number is assigned by the server when confirmed.
    // Show '---' here so the admin doesn't sign/print a preview with a wrong number.
    const previewForm: GeneratedForm = {
      id: 'preview', form_type: formType, doc_number: `${DOC_PREFIX[formType]}---`,
      company_id: companyId || null,
      client_name: client.name, client_address: client.address || null, client_tax_id: client.tax_id || null,
      client_billing: clientBilling ?? null,
      client_contact: client.contact || null, client_phone: client.phone || null, client_email: client.email || null,
      issue_date: issueDate, due_date: dueDate || null,
      line_items: valid, currency,
      non_vat_amount: 0, subtotal, vat_rate: vatNum, vat_amount: vat, total,
      discount_code: discCode || null, discount_percent: discPct, discount_amount: discount,
      notes: notes.trim() || null, status, created_at: issueDate,
    }
    onView(previewForm, payload)
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-white">New {typeLabel(formType)}</span>
        <span className="text-[11px] text-slate-400">{typeThai(formType)}</span>
      </div>

      {/* Client */}
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Customer Company">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <select value={companyId} onChange={e => pickCompany(e.target.value)} className={inputCls + ' pl-8 appearance-none'}>
              <option value="">— Select a company —</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </Field>
        <Field label="Client Name *"><input value={client.name} onChange={e => setClient({ ...client, name: e.target.value })} className={inputCls} placeholder="Company / person billed" /></Field>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Tax ID"><input value={client.tax_id} onChange={e => setClient({ ...client, tax_id: e.target.value })} className={inputCls} placeholder="13-digit tax ID" /></Field>
        <Field label="Contact Person"><input value={client.contact} onChange={e => setClient({ ...client, contact: e.target.value })} className={inputCls} /></Field>
        <Field label="Phone"><input value={client.phone} onChange={e => setClient({ ...client, phone: e.target.value })} className={inputCls} /></Field>
        <Field label="Email"><input value={client.email} onChange={e => setClient({ ...client, email: e.target.value })} className={inputCls} /></Field>
      </div>
      <Field label="Address"><textarea value={client.address} onChange={e => setClient({ ...client, address: e.target.value })} rows={2} className={inputCls + ' h-auto py-2 resize-none'} /></Field>

      {/* Dates — receipts/tax-receipts are issued on payment, so the Issue Date
          is the operative date; only bills (Invoice/Quotation) carry a due date. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Issue Date *"><input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} className={inputCls} /></Field>
        {(formType === 'invoice' || formType === 'quotation') && (
          <Field label="Due / Valid Until"><input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputCls} /></Field>
        )}
        <Field label="Currency"><input value={currency} onChange={e => setCurrency(e.target.value.toUpperCase().slice(0, 4))} className={inputCls} /></Field>
        <Field label="VAT %"><input value={vatRate} onChange={e => setVatRate(e.target.value.replace(/[^0-9.]/g, ''))} className={inputCls} inputMode="decimal" /></Field>
      </div>

      {/* Line items */}
      <div>
        <div className="flex items-center justify-between mb-1.5 gap-2">
          <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
            Items
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-slate-800 border border-slate-700 text-[10px] font-semibold text-slate-300">
              {items.filter(it => it.description.trim() || it.unit_price).length}
            </span>
          </label>
          <div className="flex items-center gap-2">
            {products.length > 0 && (
              <select value="" onChange={e => { if (e.target.value) { addProduct(e.target.value); e.target.value = '' } }} className={selectCls + ' h-7 text-[11px] text-amber-400 border-dashed'}>
                <option value="">+ Add from products…</option>
                {products.map(p => <option key={p.id} value={p.id} className="text-slate-200">{p.name} — {p.currency} {money(p.price)}</option>)}
              </select>
            )}
            <button onClick={() => setItems([...items, { description: '', qty: 1, unit_price: 0 }])} className="flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300"><Plus className="h-3.5 w-3.5" />Add item</button>
          </div>
        </div>
        <div className="space-y-2">
          {/* Shared grid so headers and rows line up exactly:
              No. · Description · Price / Unit · Quantity · Total · (delete) */}
          <div className="grid grid-cols-[2rem_1fr_7rem_4rem_7rem_2.25rem] gap-2 items-center text-[10px] font-medium uppercase tracking-wide text-slate-500">
            <div className="text-center">No.</div>
            <div>Description</div>
            <div className="text-right">Price / Unit</div>
            <div className="text-right">Qty</div>
            <div className="text-right">Total ({currency})</div>
            <div />
          </div>
          {items.map((it, i) => (
            <div key={i} className="grid grid-cols-[2rem_1fr_7rem_4rem_7rem_2.25rem] gap-2 items-center">
              <div className="text-center text-sm text-slate-500">{i + 1}</div>
              <input value={it.description} onChange={e => setItem(i, { description: e.target.value })} className={inputCls} placeholder="Description" />
              <input value={it.unit_price || ''} onChange={e => setItem(i, { unit_price: Number(e.target.value.replace(/[^0-9.]/g, '')) || 0 })} className={inputCls + ' text-right'} placeholder="Price" inputMode="decimal" />
              <input value={it.qty || ''} onChange={e => setItem(i, { qty: Number(e.target.value.replace(/[^0-9.]/g, '')) || 0 })} className={inputCls + ' text-right'} placeholder="Qty" inputMode="decimal" />
              <div className="text-right text-sm text-slate-300 px-1 truncate">{money((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</div>
              <button onClick={() => setItems(items.length > 1 ? items.filter((_, idx) => idx !== i) : items)} className="h-9 w-9 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10"><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </div>

      {/* Discount + Totals */}
      <div className="border-t border-slate-800 pt-3 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-400">Discount</label>
          <div className="flex gap-1">
            {([['promo', 'Promo Code'], ['percent', 'Percentage'], ['value', 'Value']] as const).map(([m, label]) => (
              <button key={m} type="button" onClick={() => setDiscountMode(m)}
                className={`h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors ${discountMode === m ? 'bg-amber-500/15 border-amber-500/60 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'}`}>{label}</button>
            ))}
          </div>
          {discountMode === 'promo' && (
            validPromos.length > 0 ? (
              <select value={promoId} onChange={e => setPromoId(e.target.value)} className={selectCls + ' w-full sm:w-56'}>
                <option value="">— None —</option>
                {validPromos.map(p => <option key={p.id} value={p.id}>{p.code} ({p.discount_percent}% off)</option>)}
              </select>
            ) : <div className="text-[11px] text-slate-300 h-9 flex items-center">No active promo codes for this date.</div>
          )}
          {discountMode === 'percent' && (
            <div className="relative w-full sm:w-40">
              <input value={discountPctInput} onChange={e => setDiscountPctInput(e.target.value.replace(/[^0-9.]/g, ''))} className={inputCls + ' pr-7 text-right'} placeholder="0" inputMode="decimal" />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">%</span>
            </div>
          )}
          {discountMode === 'value' && (
            <div className="relative w-full sm:w-44">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">{currency}</span>
              <input value={discountValInput} onChange={e => setDiscountValInput(e.target.value.replace(/[^0-9.]/g, ''))} className={inputCls + ' pl-12 text-right'} placeholder="0.00" inputMode="decimal" />
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 text-sm">
          <div className="flex gap-8 text-slate-400"><span>Subtotal (excl. VAT)</span><span className="w-32 text-right text-slate-200">{currency} {money(subtotal)}</span></div>
          {discount > 0 && <div className="flex gap-8 text-emerald-400"><span>Discount{discountMode === 'promo' && promo ? ` ${promo.code} (${promo.discount_percent}%)` : discountMode === 'percent' ? ` (${Number(discountPctInput) || 0}%)` : ''}</span><span className="w-32 text-right">− {currency} {money(discount)}</span></div>}
          <div className="flex gap-8 text-slate-400"><span>VAT {vatRate || 0}%</span><span className="w-32 text-right text-slate-200">{currency} {money(vat)}</span></div>
          <div className="flex gap-8 font-semibold text-white"><span>Grand Total</span><span className="w-32 text-right text-amber-400">{currency} {money(total)}</span></div>
        </div>
      </div>

      <Field label="Notes (optional)"><input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} placeholder="Payment terms, remarks…" /></Field>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Initial status</span>
          <select value={status} onChange={e => setStatus(e.target.value)} className={selectCls}>
            {STATUSES[formType].map(s => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
          </select>
        </div>
        {error && <span className="text-xs text-red-400">{error}</span>}
        <button onClick={openPreview} className="ml-auto flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-semibold px-4 py-2 rounded-lg">
          <Eye className="h-4 w-4" />View {typeLabel(formType)}
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label className="text-xs font-medium text-slate-400">{label}</label>{children}</div>
}

// ── Printable document ───────────────────────────────────────────────────────
function PrintPreview({ form, issuer, onClose, unconfirmed, confirming, onConfirm }: { form: GeneratedForm; issuer: Issuer | null; onClose: () => void; unconfirmed?: boolean; confirming?: boolean; onConfirm?: () => void }) {
  // Document language — defaults to English; switch to Thai on client request.
  const [lang, setLang] = useState<DocLang>('en')
  const t = DOC_T[lang]
  const issuerName = issuer?.company_name || 'NNR-Solutions Co., Ltd.'
  const issuerLine2 = issuer?.office_type === 'branch'
    ? (issuer?.branch_code ? t.branch(issuer.branch_code) : (issuer?.branch_name || t.branch('')))
    : t.headOffice
  const issuerAddr = composeAddress(issuer?.billing_address, lang) || issuer?.address || ''
  const showVat = form.form_type !== 'receipt' || form.vat_rate > 0
  const signatoryName = issuer?.signatory_name || 'Dr. Poti Chaopaisarn'
  const signatoryTitle = issuer?.signatory_title || 'Managing Director'
  const docTitle = lang === 'th' ? typeThai(form.form_type) : typeLabel(form.form_type)
  const docSubtitle = lang === 'th' ? typeLabel(form.form_type) : typeThai(form.form_type)
  // Buyer branch line + address, rendered from the structured snapshot when present.
  const cb = form.client_billing
  const clientBranchLine = cb ? (cb.office_type === 'branch' ? t.branch(cb.branch_code) : t.headOffice) : ''
  const clientAddr = lang === 'th'
    ? (composeAddress(cb, 'th') || form.client_address || '')
    : (form.client_address || composeAddress(cb, 'en') || '')
  // Amount-in-words is hardcoded to baht/สตางค์, so only render it for THB documents —
  // otherwise a USD/EUR invoice would print a legally-wrong "… baht" line.
  const isThb = (form.currency || 'THB').toUpperCase() === 'THB'
  const words = lang === 'th' ? bahtTextTh(form.total) : bahtText(form.total)
  // Validity window for quotations (issue → due date).
  const validityDays = form.form_type === 'quotation' && form.due_date
    ? Math.max(0, Math.round((new Date(form.due_date + 'T00:00:00+07:00').getTime() - new Date(form.issue_date + 'T00:00:00+07:00').getTime()) / 86400000))
    : null
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm print:bg-white print:static print:overflow-visible">
      <style>{`@media print {
        body * { visibility: hidden !important; }
        .print-doc, .print-doc * { visibility: visible !important; }
        .print-doc { position: absolute !important; left: 0; top: 0; width: 100%; box-shadow: none !important; margin: 0 !important; }
        .no-print { display: none !important; }
      }`}</style>

      {/* toolbar */}
      <div className="no-print sticky top-0 flex items-center justify-between gap-2 px-4 py-3 bg-white border-b border-slate-200">
        <div className="flex items-center gap-2 text-slate-900 text-sm font-semibold min-w-0">
          <FileText className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="truncate">{typeLabel(form.form_type)} · {form.doc_number}{unconfirmed ? ' (preview)' : ''}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Document language — English by default, Thai on request */}
          <div className="flex items-center rounded-lg border border-slate-300 overflow-hidden" title="Document language">
            <Languages className="h-4 w-4 text-slate-400 ml-2" />
            {(['en', 'th'] as const).map((l) => (
              <button key={l} onClick={() => setLang(l)}
                className={`px-2.5 py-1.5 text-xs font-semibold transition-colors ${lang === l ? 'bg-amber-500 text-slate-950' : 'text-slate-600 hover:bg-slate-100'}`}>
                {l === 'en' ? 'EN' : 'ไทย'}
              </button>
            ))}
          </div>
          {unconfirmed && onConfirm && (
            <button onClick={onConfirm} disabled={confirming} title="Record this document in History"
              className="flex items-center gap-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold px-3 py-1.5 rounded-lg">
              {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Confirm
            </button>
          )}
          <button onClick={() => window.print()} className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-semibold px-3 py-1.5 rounded-lg"><Printer className="h-4 w-4" />Print / Save PDF</button>
          <button onClick={onClose} title={unconfirmed ? 'Discard — back to editing' : 'Close'} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>
      </div>

      {/* A4 document */}
      <div className="flex justify-center py-6 print:py-0">
        <div className="print-doc bg-white text-slate-900 w-[210mm] min-h-[297mm] p-[14mm] shadow-2xl flex flex-col" style={{ fontSize: '12px' }}>
          {/* header */}
          <div className="flex justify-between items-start">
            <div className="max-w-[55%]">
              <div className="flex items-center gap-2 mb-2">
                {issuer?.logo_url
                  ? <img src={issuer.logo_url} alt={issuerName} className="h-20 w-auto max-w-[280px] object-contain" />
                  : (
                    <>
                      <Building2 className="h-6 w-6 text-[#7a5c3e]" />
                      <span className="text-lg font-bold text-[#4a3424] tracking-tight">{issuerName}</span>
                    </>
                  )}
              </div>
              <p className="text-[11px] text-slate-700">{issuerLine2}</p>
              {issuerAddr && <p className="text-[11px] text-slate-700 whitespace-pre-line">{issuerAddr}</p>}
              {issuer?.tax_id && <p className="text-[11px] text-slate-700">{t.taxId} {issuer.tax_id}</p>}
            </div>
            <div className="text-right">
              <h1 className="text-3xl font-bold text-[#4a3424]">{docTitle}</h1>
              <p className="text-[11px] text-slate-500">{docSubtitle} · {t.original}</p>
              <div className="mt-3 text-[11px] grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 justify-end">
                <span className="text-[#7a5c3e] text-right">{t.docNo}</span><span className="text-right font-medium">{form.doc_number}</span>
                <span className="text-[#7a5c3e] text-right">{t.date}</span><span className="text-right">{fmtDateLang(form.issue_date, lang)}</span>
                {form.due_date && (<><span className="text-[#7a5c3e] text-right">{showVat ? t.dueDate : t.paymentDate}</span><span className="text-right">{fmtDateLang(form.due_date, lang)}</span></>)}
              </div>
            </div>
          </div>

          {/* client */}
          <div className="mt-6 border-t border-slate-200 pt-3">
            <p className="text-[#7a5c3e] text-[11px] font-semibold mb-0.5">{t.client}</p>
            <p className="font-semibold">{form.client_name}{clientBranchLine && <span className="font-normal text-slate-600"> · {clientBranchLine}</span>}</p>
            {clientAddr && <p className="text-[11px] text-slate-700 whitespace-pre-line">{clientAddr}</p>}
            <div className="flex gap-4 text-[11px] text-slate-700 mt-0.5">
              {form.client_tax_id && <span>{t.taxId} {form.client_tax_id}</span>}
              {form.client_contact && <span>{t.attn} {form.client_contact}</span>}
              {form.client_phone && <span>{t.tel} {form.client_phone}</span>}
            </div>
          </div>

          {/* items */}
          <table className="w-full mt-5 text-[11px]">
            <thead>
              <tr className="border-y border-slate-300 text-slate-600">
                <th className="text-left py-1.5 w-8">{t.no}</th>
                <th className="text-left py-1.5">{t.description}</th>
                <th className="text-right py-1.5 w-16">{t.qty}</th>
                <th className="text-right py-1.5 w-28">{t.unitPrice}</th>
                <th className="text-right py-1.5 w-28">{t.amount}</th>
              </tr>
            </thead>
            <tbody>
              {form.line_items.map((it, i) => (
                <tr key={i} className="border-b border-slate-100 align-top">
                  <td className="py-1.5">{i + 1}</td>
                  <td className="py-1.5 pr-2">{it.description}</td>
                  <td className="py-1.5 text-right">{it.qty}</td>
                  <td className="py-1.5 text-right">{money(it.unit_price)}</td>
                  <td className="py-1.5 text-right">{money(it.qty * it.unit_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* totals */}
          <div className="flex justify-end mt-4">
            <div className="w-72 text-[11px] space-y-1">
              <Row label={t.subtotal} val={`${form.currency} ${money(form.subtotal)}`} />
              {form.discount_amount > 0 && <Row label={`${t.discount}${form.discount_code ? ` (${form.discount_code}, ${form.discount_percent}%)` : ''}`} val={`− ${form.currency} ${money(form.discount_amount)}`} />}
              {form.non_vat_amount > 0 && <Row label={t.nonVat} val={`${form.currency} ${money(form.non_vat_amount)}`} />}
              {showVat && form.vat_rate > 0 && <Row label={`${t.vat} ${form.vat_rate}%`} val={`${form.currency} ${money(form.vat_amount)}`} />}
              <div className="flex justify-between border-t border-slate-300 pt-1.5 font-bold text-[#4a3424] text-sm">
                <span>{t.grandTotal}</span><span>{form.currency} {money(form.total)}</span>
              </div>
            </div>
          </div>
          {isThb && <p className="text-[11px] text-slate-600 italic mt-2">( {words} )</p>}

          {/* validity & notes */}
          <div className="mt-4 border-t border-slate-200 pt-2 space-y-1">
            {validityDays !== null && (
              <p className="text-[11px] text-slate-700">
                <span className="font-semibold">{t.validity} </span>
                {t.validityText(validityDays, fmtDateLang(form.due_date, lang))}
              </p>
            )}
            {form.notes && <p className="text-[11px] text-slate-700"><span className="font-semibold">{t.notes} </span>{form.notes}</p>}
          </div>

          {/* signatures — pinned toward the bottom of the page */}
          <div className="grid grid-cols-2 gap-12 mt-auto pt-24 text-[11px]">
            <div className="text-center">
              <div className="border-t border-slate-400 pt-1.5">
                <p className="font-semibold text-slate-900">{issuerName}</p>
                <p className="text-slate-900">{signatoryName}</p>
                <p className="text-slate-600">{signatoryTitle}</p>
                <p className="text-slate-500 mt-1">{t.authSig}</p>
              </div>
            </div>
            <div className="text-center">
              <div className="border-t border-slate-400 pt-1.5">
                <p className="font-semibold text-slate-900">{form.client_name || t.clientLabel}</p>
                <p className="text-slate-600">&nbsp;</p>
                <p className="text-slate-600">&nbsp;</p>
                <p className="text-slate-500 mt-1">{t.authSig}</p>
              </div>
            </div>
          </div>

          {/* footer */}
          <div className="mt-8 text-center text-[9px] text-slate-500 leading-relaxed">
            <div className="h-0.5 rounded-full bg-[#7a5c3e] mb-2" />
            <p className="font-medium text-[#7a5c3e] text-[10px]">{t.thankyou}</p>
            <p className="mt-0.5">
              {issuerName}{issuer?.tax_id ? ` · ${t.taxId} ${issuer.tax_id}` : ''}
              {issuerAddr ? ` · ${issuerAddr.replace(/\s*\n\s*/g, ', ')}` : ''}
            </p>
            {(issuer?.phone || issuer?.email || issuer?.website) && (
              <p className="mt-0.5">
                {[
                  issuer?.phone ? `${t.tel} ${issuer.phone}` : null,
                  issuer?.email || null,
                  issuer?.website || null,
                ].filter(Boolean).join('  ·  ')}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, val }: { label: string; val: string }) {
  return <div className="flex justify-between text-slate-600"><span>{label}</span><span className="text-slate-900">{val}</span></div>
}
