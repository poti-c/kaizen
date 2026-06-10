import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Crown, Check, X as XIcon, Wrench, Clock, Loader2, Mail, ArrowLeft, Lock, Calendar, Upload, QrCode } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { addonTrialDaysLeft, subscriptionInfo } from '@/lib/utils'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

const SALES_EMAIL = 'info@nnr-solutions.com'
const RANK: Record<string, number> = { trial: 0, gold: 1, premium: 2 }
const PRICE: Record<string, number> = { gold: 39000, premium: 0, pms: 10000 } // fallback only — live prices come from kaizen_products
const ICON_BY_KEY: Record<string, typeof Crown> = { trial: Sparkles, gold: Crown, premium: Crown }

interface ProdRow { key: string | null; kind: string; name: string; price: number | string | null; currency: string | null; duration_label: string | null; sort_order: number | null }

interface Txn { id: string; amount: number | null; currency: string; payment_date: string; period_end: string | null; receipt_requested: boolean; receipt_issued: boolean }
interface SubRow { id: string; amount: number | null; currency: string; status: string; created_at: string; target_label: string | null; target: string }
interface PayItem { kind: 'subscription' | 'addon'; target: string; label: string; amount: number }
interface Vendor { promptpay_id: string | null; promptpay_name: string | null; promptpay_qr: string | null; support_email: string | null }

function fileToProof(file: File, max = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Invalid image'))
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
        const ctx = c.getContext('2d'); if (!ctx) return reject(new Error('Canvas unsupported'))
        ctx.drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/jpeg', 0.8))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

const PACKAGES = [
  { key: 'trial', name: 'Starter', price_en: 'Free · 30 days', price_th: 'ฟรี · 30 วัน', icon: Sparkles },
  { key: 'gold', name: 'Gold', price_en: '฿39,000 / year', price_th: '฿39,000 / ปี', icon: Crown },
  { key: 'premium', name: 'Premium', price_en: 'Contact for pricing', price_th: 'ติดต่อสอบถามราคา', icon: Crown },
]

// Feature-by-feature comparison
const COMPARE: { label: string; values: [string | boolean, string | boolean, string | boolean] }[] = [
  { label: 'Issue reporting & cases', values: [true, true, true] },
  { label: 'Calendar', values: [true, true, true] },
  { label: 'Recurring issue detection', values: [true, true, true] },
  { label: 'Top Management accounts', values: ['1', '1', '3'] },
  { label: 'Managers', values: ['2', '5', 'Unlimited'] },
  { label: 'Staff', values: ['10', '50', 'Unlimited'] },
  { label: 'Performance analytics', values: [false, true, true] },
  { label: 'Translation (TH ⇄ EN)', values: [false, true, true] },
  { label: 'Activity log', values: [false, true, true] },
  { label: 'Custom theme', values: [false, false, true] },
  { label: 'Multi-property', values: [false, false, true] },
  { label: 'Priority support', values: [false, false, true] },
]

const ADDONS = [
  { key: 'pms' as const, name: 'Preventive Maintenance Scheduler', icon: Wrench,
    desc: 'Register assets, auto-generate scheduled maintenance, checklists, approvals and a live health dashboard.' },
]

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Thai labels for the feature-comparison list, keyed by the English label.
const COMPARE_TH: Record<string, string> = {
  'Issue reporting & cases': 'การแจ้งปัญหาและเคส',
  'Calendar': 'ปฏิทิน',
  'Recurring issue detection': 'การตรวจจับปัญหาที่เกิดซ้ำ',
  'Top Management accounts': 'บัญชีผู้บริหารระดับสูง',
  'Managers': 'ผู้จัดการ',
  'Staff': 'พนักงาน',
  'Performance analytics': 'การวิเคราะห์ประสิทธิภาพ',
  'Translation (TH ⇄ EN)': 'การแปลภาษา (ไทย ⇄ อังกฤษ)',
  'Activity log': 'บันทึกกิจกรรม',
  'Custom theme': 'ธีมที่กำหนดเอง',
  'Multi-property': 'รองรับหลายสาขา',
  'Priority support': 'การสนับสนุนแบบเร่งด่วน',
}

// Thai name/description for add-ons, keyed by add-on key.
const ADDON_TH: Record<string, { name: string; desc: string }> = {
  pms: {
    name: 'ระบบจัดตารางบำรุงรักษาเชิงป้องกัน',
    desc: 'ลงทะเบียนสินทรัพย์ สร้างตารางบำรุงรักษาอัตโนมัติ เช็กลิสต์ การอนุมัติ และแดชบอร์ดสุขภาพระบบแบบเรียลไทม์',
  },
}

export function PackagesExpansions() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<{ managers: number; staff: number } | null>(null)
  const [vendor, setVendor] = useState<Vendor | null>(null)
  const [payItem, setPayItem] = useState<PayItem | null>(null)
  const [txns, setTxns] = useState<Txn[]>([])
  const [subs, setSubs] = useState<SubRow[]>([])
  const [products, setProducts] = useState<ProdRow[]>([])
  const [receiptFor, setReceiptFor] = useState<string | null>(null)  // invoice id awaiting confirmation
  const [receiptBusy, setReceiptBusy] = useState(false)
  const [receiptDone, setReceiptDone] = useState(false)

  useEffect(() => {
    supabase.from('kaizen_console_settings').select('promptpay_id, promptpay_name, promptpay_qr, support_email').eq('id', true).maybeSingle()
      .then(({ data }) => setVendor(data as Vendor))
    supabase.from('kaizen_products').select('key, kind, name, price, currency, duration_label, sort_order').eq('is_active', true)
      .then(({ data }) => setProducts((data as ProdRow[]) ?? []))
  }, [])

  // Live subscription plans + prices from the Console's Products table (fallback to defaults).
  const packages = useMemo(() => {
    const pkgs = products.filter(p => p.kind === 'package' && p.key)
    if (!pkgs.length) return PACKAGES.map(({ price_en, price_th, ...p }) => ({ ...p, price: lang === 'th' ? price_th : price_en, amount: PRICE[p.key] ?? 0 }))
    return [...pkgs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map(p => {
      const amount = Number(p.price) || 0
      const isTrial = p.key === 'trial'
      const display = isTrial
        ? `${lang === 'th' ? 'ฟรี' : 'Free'} · ${p.duration_label || (lang === 'th' ? '30 วัน' : '30 days')}`
        : amount > 0
          ? `฿${amount.toLocaleString()} · ${p.duration_label || (lang === 'th' ? '1 ปี' : '1 year')}`
          : (lang === 'th' ? 'ติดต่อสอบถามราคา' : 'Contact for pricing')
      return { key: p.key as string, name: p.name, price: display, amount, icon: ICON_BY_KEY[p.key as string] || Crown }
    })
  }, [products, lang])

  const price = useMemo(() => {
    const m: Record<string, number> = { ...PRICE }
    packages.forEach(p => { m[p.key] = p.amount })
    const pmsProd = products.find(p => p.key === 'pms') || products.find(p => /preventive|maintenance/i.test(p.name || ''))
    if (pmsProd) m['pms'] = Number(pmsProd.price) || m['pms']
    return m
  }, [products, packages])

  const loadTxns = () => {
    const cid = activeCompany?.id
    if (!cid) return
    supabase.from('kaizen_invoices').select('id, amount, currency, payment_date, period_end, receipt_requested, receipt_issued')
      .eq('company_id', cid).order('payment_date', { ascending: false })
      .then(({ data }) => setTxns((data as Txn[]) ?? []))
    supabase.from('kaizen_payment_submissions').select('id, amount, currency, status, created_at, target_label, target')
      .eq('company_id', cid).neq('status', 'approved').order('created_at', { ascending: false })
      .then(({ data }) => setSubs((data as SubRow[]) ?? []))
  }
  useEffect(() => { loadTxns() }, [activeCompany?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Merged history: confirmed invoices + still-pending / rejected submissions, newest first.
  const history = useMemo(() => {
    const inv = txns.map(t => ({ _t: 'inv' as const, id: t.id, date: t.payment_date, amount: t.amount, period_end: t.period_end, receipt_requested: t.receipt_requested, receipt_issued: t.receipt_issued }))
    const sb = subs.map(s => ({ _t: 'sub' as const, id: s.id, date: (s.created_at || '').slice(0, 10), amount: s.amount, status: s.status, label: s.target_label || s.target }))
    return [...inv, ...sb].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }, [txns, subs])

  async function confirmReceipt() {
    const id = receiptFor
    if (!id) return
    setReceiptBusy(true)
    const { error } = await supabase.rpc('kaizen_request_receipt', { p_invoice: id })
    setReceiptBusy(false)
    if (error) { toast.error(error.message); return }
    setReceiptFor(null)
    setReceiptDone(true)
    loadTxns()
  }

  function openPay(item: PayItem) {
    if (upgradeLocked) { toast.error(lang === 'th' ? 'เฉพาะผู้บริหารระดับสูงเท่านั้นที่เข้าถึงได้' : 'Only Top Management have access.'); return }
    if (!item.amount) { requestQuote(item.label); return } // no fixed price → quote
    setPayItem(item)
  }

  const isTopMgmt = profile?.role === 'super_admin'
  const hidePrices = !isTopMgmt          // managers don't see prices
  const upgradeLocked = !isTopMgmt       // managers can't act

  const sub = subscriptionInfo(activeCompany)
  const plan = activeCompany?.plan ?? 'trial'
  const planRank = RANK[plan] ?? 0
  const planName = packages.find(p => p.key === plan)?.name ?? 'Starter'
  const maxM = activeCompany?.max_managers ?? null
  const maxS = activeCompany?.max_staff ?? null

  useEffect(() => {
    const cid = activeCompany?.id
    if (!cid) return
    ;(async () => {
      const [m, s] = await Promise.all([
        supabase.from('kaizen_profiles').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('role', 'manager').eq('is_active', true),
        supabase.from('kaizen_profiles').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('role', 'staff').eq('is_active', true),
      ])
      setUsage({ managers: m.count ?? 0, staff: s.count ?? 0 })
    })()
  }, [activeCompany?.id])

  const welcome = (() => {
    if (sub.expired) return lang === 'th'
      ? `แพ็กเกจ ${planName} ของคุณสิ้นสุดแล้ว — ต่ออายุได้ทุกเมื่อเพื่อใช้งานต่อจากเดิม`
      : `Your ${planName} plan has ended — renew any time to pick up right where you left off.`
    if (sub.daysLeft == null) return lang === 'th'
      ? `คุณกำลังใช้แพ็กเกจ ${planName} ขอบคุณที่อยู่กับเรา`
      : `You're on the ${planName} plan. We're glad to have you with us.`
    if (sub.isTrial) return lang === 'th'
      ? `ยินดีต้อนรับ! คุณมีเวลา ${sub.daysLeft} วันบนแพ็กเกจ Starter เพื่อสำรวจทุกฟีเจอร์ของ Kaizen System`
      : `Welcome aboard! You have ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} on your Starter plan to explore everything Kaizen System offers.`
    return lang === 'th'
      ? `คุณพร้อมใช้งานแพ็กเกจ ${planName} แล้ว — เหลือสิทธิ์ใช้งานเต็มรูปแบบอีก ${sub.daysLeft} วัน ขอบคุณที่อยู่กับเรา`
      : `You're all set on the ${planName} plan — ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} of full access remaining. Thank you for being with us.`
  })()

  async function startPmsTrial() {
    if (upgradeLocked) { toast.error(lang === 'th' ? 'เฉพาะผู้บริหารระดับสูงเท่านั้นที่เข้าถึงได้' : 'Only Top Management have access.'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('kaizen_start_pms_trial', { p_company_id: activeCompany?.id })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    toast.success(lang === 'th' ? `ปลดล็อกการบำรุงรักษาเชิงป้องกันถึงวันที่ ${fmtDate(data as string)}` : `Preventive Maintenance unlocked until ${fmtDate(data as string)}`)
    setTimeout(() => window.location.reload(), 700)
  }
  function requestQuote(item: string) {
    if (upgradeLocked) { toast.error(lang === 'th' ? 'เฉพาะผู้บริหารระดับสูงเท่านั้นที่เข้าถึงได้' : 'Only Top Management have access.'); return }
    window.location.href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Kaizen System — ${item}`)}&body=${encodeURIComponent(`Hi NNR-Solutions,\n\nWe'd like a quotation for: ${item}\n\nCompany: ${activeCompany?.name ?? ''}\n`)}`
  }

  const overM = maxM != null && usage != null && usage.managers >= maxM
  const overS = maxS != null && usage != null && usage.staff >= maxS

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto animate-fade-in">
      <button onClick={() => navigate('/settings')} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-4">
        <ArrowLeft className="h-4 w-4" />{lang === 'th' ? 'กลับไปที่การตั้งค่า' : 'Back to Settings'}
      </button>

      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="h-5 w-5 text-[var(--brand-primary)]" />
        <h1 className="text-xl font-bold text-gray-900">{lang === 'th' ? 'แพ็กเกจและส่วนเสริม' : 'Packages & Expansions'}</h1>
      </div>
      <p className="text-sm text-gray-500 mb-5">{lang === 'th' ? 'แพ็กเกจของคุณ การอัปเกรด และส่วนเสริมที่มี' : 'Your plan, available upgrades and add-ons.'}</p>

      {/* Welcome countdown */}
      <div className="rounded-xl bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/15 p-4 mb-5">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="h-4 w-4 text-[var(--brand-primary)]" />
          <span className="text-sm font-semibold text-gray-900">{lang === 'th' ? 'แพ็กเกจปัจจุบัน' : 'Current plan'}: {planName}</span>
          {sub.daysLeft != null && !sub.expired && <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${sub.daysLeft <= 7 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{lang === 'th' ? `เหลือ ${sub.daysLeft} วัน` : `${sub.daysLeft} days left`}</span>}
          {sub.expired && <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">{lang === 'th' ? 'สิ้นสุดแล้ว' : 'Ended'}</span>}
        </div>
        <p className="text-sm text-gray-600">{welcome}</p>
        {sub.end && <p className="text-xs text-gray-500 mt-1 flex items-center gap-1"><Calendar className="h-3 w-3" />{sub.isTrial ? (lang === 'th' ? 'ทดลองใช้สิ้นสุด' : 'Trial ends') : (lang === 'th' ? 'การสมัครสิ้นสุด' : 'Subscription ends')}: {fmtDate(sub.end)}</p>}
      </div>

      {/* Usage nudge */}
      {usage && (overM || overS) && planRank < 2 && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 mb-5 text-sm text-amber-800">
          {overM && <p>{lang === 'th' ? `คุณใช้ผู้จัดการ ${usage.managers}/${maxM} ราย` : `You're using ${usage.managers}/${maxM} managers.`}</p>}
          {overS && <p>{lang === 'th' ? `คุณใช้พนักงาน ${usage.staff}/${maxS} ราย` : `You're using ${usage.staff}/${maxS} staff.`}</p>}
          <p className="mt-0.5">{lang === 'th' ? `อัปเกรดเป็น ${planRank === 0 ? 'Gold หรือ Premium' : 'Premium'} เพื่อเพิ่มความจุ` : `Upgrade to ${planRank === 0 ? 'Gold or Premium' : 'Premium'} for more capacity.`}</p>
        </div>
      )}

      {/* Packages */}
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">{lang === 'th' ? 'แพ็กเกจการสมัคร' : 'Subscription plans'}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {packages.map((p) => {
          const current = p.key === plan
          const canUpgrade = (RANK[p.key] ?? 0) > planRank   // only higher tiers
          const Icon = p.icon
          return (
            <div key={p.key} className={`rounded-xl border p-4 flex flex-col ${current ? 'border-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5' : 'border-gray-200'}`}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <Icon className="h-4 w-4 text-[var(--brand-primary)]" />
                <span className="font-semibold text-gray-900">{p.name}</span>
                {current && <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--brand-primary)] text-white">{lang === 'th' ? 'ปัจจุบัน' : 'Current'}</span>}
              </div>
              {!hidePrices && <p className="text-sm font-bold text-gray-900 mb-2">{p.price}</p>}
              <div className="flex-1" />
              {canUpgrade && (
                <button onClick={() => openPay({ kind: 'subscription', target: p.key, label: `${p.name} plan`, amount: p.amount })}
                  className={`mt-3 w-full h-8 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 ${upgradeLocked ? 'bg-gray-100 text-gray-400' : 'bg-[var(--brand-primary)] text-white hover:opacity-90'}`}>
                  {upgradeLocked && <Lock className="h-3 w-3" />}{lang === 'th' ? 'อัปเกรด' : 'Upgrade'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Comparison table */}
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">{lang === 'th' ? 'เปรียบเทียบแพ็กเกจ' : 'Compare plans'}</p>
      <div className="overflow-x-auto rounded-xl border border-gray-200 mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left font-semibold text-gray-500 px-3 py-2">{lang === 'th' ? 'ฟีเจอร์' : 'Feature'}</th>
              <th className="text-center font-semibold text-gray-700 px-3 py-2">Starter</th>
              <th className="text-center font-semibold text-gray-700 px-3 py-2">Gold</th>
              <th className="text-center font-semibold text-gray-700 px-3 py-2">Premium</th>
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((row) => (
              <tr key={row.label} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-2 text-gray-700">{lang === 'th' ? (COMPARE_TH[row.label] ?? row.label) : row.label}</td>
                {row.values.map((v, i) => (
                  <td key={i} className="px-3 py-2 text-center">
                    {v === true ? <Check className="h-4 w-4 text-green-500 mx-auto" />
                      : v === false ? <XIcon className="h-4 w-4 text-gray-300 mx-auto" />
                      : <span className="text-xs text-gray-700">{v === 'Unlimited' ? (lang === 'th' ? 'ไม่จำกัด' : 'Unlimited') : v}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add-ons (no prices shown) */}
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">{lang === 'th' ? 'ส่วนเสริม (แอด-ออน)' : 'Expansions (add-ons)'}</p>
      <div className="space-y-2 mb-3">
        {ADDONS.map((a) => {
          const purchased = activeCompany?.addons?.[a.key] === true
          const trialLeft = addonTrialDaysLeft(activeCompany, a.key)
          const trialUsed = !!activeCompany?.addons?.[`${a.key}_trial_used`]
          const Icon = a.icon
          return (
            <div key={a.key} className="rounded-xl border border-gray-200 p-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-[var(--brand-primary)]/10 flex items-center justify-center flex-shrink-0"><Icon className="h-4 w-4 text-[var(--brand-primary)]" /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900 text-sm">{lang === 'th' ? (ADDON_TH[a.key]?.name ?? a.name) : a.name}</span>
                    {purchased && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">{lang === 'th' ? 'ใช้งานอยู่' : 'Active'}</span>}
                    {!purchased && trialLeft != null && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700">{lang === 'th' ? `ทดลองใช้ · เหลือ ${trialLeft} วัน` : `Trial · ${trialLeft} days left`}</span>}
                  </div>
                  <p className="text-[11px] text-gray-600 mt-0.5">{lang === 'th' ? (ADDON_TH[a.key]?.desc ?? a.desc) : a.desc}</p>
                  {/* Subscription-end counter for a purchased add-on (pauses with the subscription) */}
                  {purchased && sub.end && <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1"><Calendar className="h-3 w-3" />{lang === 'th' ? `ใช้งานได้ถึง ${fmtDate(sub.end)}` : `Active until ${fmtDate(sub.end)}`}</p>}
                  {!purchased && (
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <button onClick={() => openPay({ kind: 'addon', target: a.key, label: a.name, amount: price[a.key] ?? 0 })} className={`h-8 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap flex-shrink-0 ${upgradeLocked ? 'bg-gray-100 text-gray-400' : 'bg-[var(--brand-primary)] text-white hover:opacity-90'}`}>{upgradeLocked && <Lock className="h-3 w-3" />}{lang === 'th' ? 'สมัครเลย' : 'Subscribe now'}</button>
                      {trialLeft == null && !trialUsed && (
                        <button onClick={startPmsTrial} disabled={busy} className={`h-8 px-3 rounded-lg text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap flex-shrink-0 border ${upgradeLocked ? 'border-gray-200 text-gray-400' : 'border-[var(--brand-primary)] text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/5'}`}>
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : upgradeLocked ? <Lock className="h-3 w-3" /> : <Sparkles className="h-3.5 w-3.5" />}{lang === 'th' ? 'ทดลองใช้ฟรี 7 วัน' : 'Try free for 7 days'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {/* Days-remaining counter (right) — until the subscription/renewal */}
                {purchased && sub.daysLeft != null && !sub.expired && (
                  <div className="text-right flex-shrink-0 pl-2">
                    <p className="text-xl font-bold text-[var(--brand-primary)] leading-none">{sub.daysLeft}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{lang === 'th' ? 'วันที่เหลือ' : 'days left'}</p>
                  </div>
                )}
                {!purchased && trialLeft != null && (
                  <div className="text-right flex-shrink-0 pl-2">
                    <p className="text-xl font-bold text-violet-600 leading-none">{trialLeft}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{lang === 'th' ? 'วันทดลองใช้' : 'trial days'}</p>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[11px] text-gray-400 leading-relaxed">
        {lang === 'th' ? (
          <>หมายเหตุ: ส่วนเสริมจะทำงานควบคู่ไปกับการสมัครของคุณ หากการสมัครสิ้นสุดก่อนระยะเวลาของส่วนเสริม ส่วนเสริมจะถูก <span className="font-medium text-gray-500">หยุดชั่วคราว</span> และจะกลับมาทำงานโดยอัตโนมัติเมื่อต่ออายุการสมัครแล้ว</>
        ) : (
          <>Note: expansions run alongside your subscription. If your subscription ends before an expansion period, the expansion is <span className="font-medium text-gray-500">paused</span> and resumes automatically once your subscription is renewed.</>
        )}
      </p>

      {/* Transaction history */}
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mt-6 mb-2">{lang === 'th' ? 'ประวัติการชำระเงิน' : 'Transaction history'}</p>
      {history.length === 0 ? (
        <p className="text-sm text-gray-400 mb-2">{lang === 'th' ? 'ยังไม่มีการชำระเงินที่บันทึกไว้' : 'No payments recorded yet.'}</p>
      ) : (
        <div className="rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
          {history.map((tx) => (
            <div key={`${tx._t}-${tx.id}`} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{tx.amount != null ? `฿${Number(tx.amount).toLocaleString()}` : '—'}</p>
                <p className="text-[11px] text-gray-400">
                  {fmtDate(tx.date)}
                  {tx._t === 'inv' && tx.period_end ? (lang === 'th' ? ` · ใช้ได้ถึง ${fmtDate(tx.period_end)}` : ` · valid to ${fmtDate(tx.period_end)}`) : ''}
                  {tx._t === 'sub' ? ` · ${tx.label}` : ''}
                </p>
              </div>
              {tx._t === 'sub' ? (
                tx.status === 'rejected'
                  ? <span className="text-[11px] font-medium text-gray-400">{lang === 'th' ? 'ไม่อนุมัติ' : 'Not approved'}</span>
                  : <span className="text-[11px] font-medium text-amber-600 flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{lang === 'th' ? 'รอตรวจสอบ' : 'Pending review'}</span>
              ) : tx.receipt_issued ? (
                <span className="text-[11px] font-medium text-green-600 flex items-center gap-1"><Check className="h-3.5 w-3.5" />{lang === 'th' ? 'ส่งใบเสร็จแล้ว' : 'Receipt sent'}</span>
              ) : tx.receipt_requested ? (
                <span className="text-[11px] text-amber-600">{lang === 'th' ? 'ขอใบเสร็จแล้ว' : 'Receipt requested'}</span>
              ) : !upgradeLocked ? (
                <button onClick={() => setReceiptFor(tx.id)} className="text-xs font-medium text-[var(--brand-primary)] hover:opacity-75">{lang === 'th' ? 'ขอใบกำกับภาษี/ใบเสร็จ' : 'Request Tax/Receipt'}</button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-gray-400 mt-2">{lang === 'th' ? 'ใบเสร็จจะถูกส่งไปยังอีเมลบริษัทที่ลงทะเบียนไว้ หากมีปัญหาเกี่ยวกับใบเสร็จ โปรดติดต่อเราผ่านเมนูช่วยเหลือ' : 'Receipts are emailed to your registered company email. Problems with a receipt? Contact us via Help.'}</p>

      <div className="mt-6 flex items-center justify-center">
        <button onClick={() => requestQuote('Book a demo / call')} className="flex items-center gap-1.5 text-sm font-medium text-[var(--brand-primary)] hover:opacity-75">
          <Mail className="h-4 w-4" />{lang === 'th' ? 'นัดหมายสาธิตหรือพูดคุยกับทีมงานของเรา' : 'Book a demo or call with our team'}
        </button>
      </div>

      {payItem && <PayModal item={payItem} vendor={vendor} companyId={activeCompany?.id ?? ''} supportEmail={vendor?.support_email ?? 'potichao@me.com'} onClose={() => setPayItem(null)} />}

      {/* Receipt request — confirmation prompt */}
      {receiptFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => !receiptBusy && setReceiptFor(null)}>
          <div className="bg-white rounded-2xl p-5 max-w-md w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-bold text-gray-900 mb-3 text-center">{lang === 'th' ? 'ขอใบกำกับภาษี / ใบเสร็จรับเงิน' : 'Request Tax Invoice / Receipt'}</h3>
            <div className="text-[12px] leading-snug text-gray-600 space-y-2">
              {lang === 'th' ? (
                <>
                  <p>สามารถขอใบกำกับภาษี / ใบเสร็จรับเงินได้ <span className="font-semibold text-gray-900">เพียงครั้งเดียว</span> ต่อการชำระเงินหนึ่งครั้ง เพื่อป้องกันการออกเอกสารภาษีซ้ำ ซึ่งไม่ได้รับอนุญาตตามระเบียบภาษี <span className="font-semibold text-gray-900">คำขอนี้ไม่สามารถยกเลิกได้</span></p>
                  <p>เอกสารจะถูกออกไปยัง <span className="font-semibold text-gray-900">อีเมลบริษัทที่ลงทะเบียนไว้เท่านั้น</span></p>
                  <p>หากต้องการแก้ไขข้อมูลบริษัท โปรด <a href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Update company details — ' + (activeCompany?.name ?? ''))}`} className="text-[var(--brand-primary)] font-medium underline">ติดต่อเรา</a> ก่อนทำการขอ</p>
                </>
              ) : (
                <>
                  <p>A Tax Invoice / Receipt can be requested <span className="font-semibold text-gray-900">only once</span> per payment. To prevent duplicate tax documents — which is not permitted under tax regulations — <span className="font-semibold text-gray-900">this request cannot be undone.</span></p>
                  <p>The document will be issued to your <span className="font-semibold text-gray-900">registered company email only</span>.</p>
                  <p>If any company details need to be corrected, please <a href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Update company details — ' + (activeCompany?.name ?? ''))}`} className="text-[var(--brand-primary)] font-medium underline">contact us</a> before requesting.</p>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button onClick={() => setReceiptFor(null)} disabled={receiptBusy} className="h-9 px-4 rounded-lg text-[13px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50">{lang === 'th' ? 'ยกเลิก' : 'Cancel'}</button>
              <button onClick={confirmReceipt} disabled={receiptBusy} className="h-9 px-4 rounded-lg text-[13px] font-semibold bg-[var(--brand-primary)] text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5">
                {receiptBusy && <Loader2 className="h-4 w-4 animate-spin" />}{lang === 'th' ? 'ขอเอกสาร' : 'Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt request — success acknowledgement */}
      {receiptDone && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setReceiptDone(false)}>
          <div className="bg-white rounded-2xl p-5 max-w-md w-full shadow-xl text-center" onClick={(e) => e.stopPropagation()}>
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3"><Check className="h-6 w-6 text-green-600" /></div>
            <h3 className="text-[15px] font-bold text-gray-900 mb-2">{lang === 'th' ? 'รับคำขอแล้ว' : 'Request received'}</h3>
            <p className="text-[12px] leading-snug text-gray-600">{lang === 'th' ? (<>โปรดรอประมาณ <span className="font-semibold text-gray-900">2–3 วันทำการ</span> เพื่อให้ทีมงานของเราจัดเตรียมและจัดส่งใบกำกับภาษี / ใบเสร็จรับเงินไปยังอีเมลบริษัทที่ลงทะเบียนไว้</>) : (<>Please allow <span className="font-semibold text-gray-900">2–3 working days</span> for our team to prepare and deliver your Tax Invoice / Receipt to your registered company email.</>)}</p>
            <button onClick={() => setReceiptDone(false)} className="mt-5 h-9 px-5 rounded-lg text-[13px] font-semibold bg-[var(--brand-primary)] text-white hover:opacity-90">{lang === 'th' ? 'เสร็จสิ้น' : 'Done'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

function PayModal({ item, vendor, companyId, supportEmail, onClose }: {
  item: PayItem; vendor: Vendor | null; companyId: string; supportEmail: string; onClose: () => void
}) {
  const { lang } = useLanguage()
  const [proof, setProof] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [verified, setVerified] = useState(false)

  async function pickProof(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { toast.error(lang === 'th' ? 'โปรดเลือกรูปภาพสลิปการชำระเงินของคุณ' : 'Please choose an image of your payment slip.'); return }
    try { setProof(await fileToProof(file)) } catch { toast.error(lang === 'th' ? 'ไม่สามารถอ่านรูปภาพนั้นได้' : 'Could not read that image.') }
  }
  async function submit() {
    if (!proof) { toast.error(lang === 'th' ? 'โปรดแนบสลิปการชำระเงินของคุณ' : 'Please attach your payment slip.'); return }
    setBusy(true)
    const { data, error } = await supabase.functions.invoke('kaizen-pay', {
      body: { company_id: companyId, kind: item.kind, target: item.target, target_label: item.label, amount: item.amount, currency: 'THB', proof_url: proof },
    })
    setBusy(false)
    if (error) { toast.error(lang === 'th' ? 'ไม่สามารถส่งการชำระเงินได้ โปรดลองอีกครั้งหรือติดต่อฝ่ายสนับสนุน' : 'Could not submit payment. Please try again or contact support.'); return }
    setVerified(!!(data as { verified?: boolean })?.verified)
    setSubmitted(true)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">{submitted ? (lang === 'th' ? 'ขอบคุณ!' : 'Thank you!') : (lang === 'th' ? `ชำระเงินสำหรับ ${item.label}` : `Pay for ${item.label}`)}</h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><XIcon className="h-4 w-4" /></button>
        </div>

        {submitted ? (
          <div className="px-5 py-6 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto"><Check className="h-6 w-6 text-green-600" /></div>
            <p className="text-sm text-gray-700">{lang === 'th' ? '🎉 ขอบคุณที่เลือกใช้ Kaizen System!' : '🎉 Thank you for choosing Kaizen System!'}</p>
            {verified ? (
              lang === 'th'
                ? <p className="text-sm text-gray-600">การชำระเงินของคุณได้รับการ <span className="font-semibold text-green-600">ยืนยันแล้ว</span> — {item.label} ของคุณเปิดใช้งานแล้ว โปรด <span className="font-semibold">รีสตาร์ทแอป</span> ในอีกประมาณ <span className="font-semibold">5 นาที</span> เพื่อดูฟีเจอร์ใหม่ของคุณ</p>
                : <p className="text-sm text-gray-600">Your payment is <span className="font-semibold text-green-600">verified</span> — your {item.label} is now active. Please <span className="font-semibold">restart the app</span> in about <span className="font-semibold">5 minutes</span> to see your new features.</p>
            ) : (
              lang === 'th'
                ? <p className="text-sm text-gray-600">เราได้รับการยืนยันการชำระเงินของคุณแล้ว {item.label} ของคุณจะเปิดใช้งานภายใน <span className="font-semibold">24 ชั่วโมง</span> เมื่อเปิดใช้งานแล้ว โปรด <span className="font-semibold">รีสตาร์ทแอป</span> เพื่อดูฟีเจอร์ใหม่ของคุณ</p>
                : <p className="text-sm text-gray-600">We've received your payment confirmation. Your {item.label} will be activated within <span className="font-semibold">24 hours</span>. Once it's active, please <span className="font-semibold">restart the app</span> to see your new features.</p>
            )}
            <p className="text-xs text-gray-500">{lang === 'th' ? (<>มีปัญหาใช่ไหม? ติดต่อเราได้ทุกเมื่อผ่าน <span className="font-medium">เมนูช่วยเหลือ</span></>) : (<>Having trouble? Reach us any time via <span className="font-medium">Help</span>.</>)}</p>
            <button onClick={onClose} className="mt-1 w-full h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold">{lang === 'th' ? 'เสร็จสิ้น' : 'Done'}</button>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-3 overflow-y-auto">
            <p className="text-sm text-gray-600">{lang === 'th' ? (<>สแกน QR พร้อมเพย์ด้านล่างเพื่อชำระ <span className="font-bold text-gray-900">฿{item.amount.toLocaleString()}</span> จากนั้นอัปโหลดสลิปการชำระเงินของคุณ</>) : (<>Scan the PromptPay QR below to pay <span className="font-bold text-gray-900">฿{item.amount.toLocaleString()}</span>, then upload your payment slip.</>)}</p>
            <div className="rounded-xl border border-gray-200 p-3 flex flex-col items-center">
              {vendor?.promptpay_qr ? (
                <img src={vendor.promptpay_qr} alt="PromptPay QR" className="w-44 h-44 object-contain" />
              ) : (
                <div className="w-44 h-44 flex flex-col items-center justify-center text-gray-400 text-center"><QrCode className="h-10 w-10 mb-2" /><span className="text-xs">{vendor?.promptpay_id ? `PromptPay: ${vendor.promptpay_id}` : (lang === 'th' ? 'รายละเอียดการชำระเงินจะแจ้งให้ทราบเร็วๆ นี้ — โปรดติดต่อฝ่ายสนับสนุน' : 'Payment details coming soon — please contact support.')}</span></div>
              )}
              {vendor?.promptpay_name && <p className="text-xs text-gray-600 mt-2">{vendor.promptpay_name}</p>}
            </div>

            <div>
              {proof ? (
                <div className="flex items-center gap-3">
                  <img src={proof} alt="Slip" className="w-14 h-14 rounded-lg object-cover border border-gray-200" />
                  <button onClick={() => setProof(null)} className="text-xs text-red-500">{lang === 'th' ? 'ลบ' : 'Remove'}</button>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 h-16 rounded-lg border-2 border-dashed border-gray-300 hover:border-gray-400 cursor-pointer text-gray-500 text-sm">
                  <Upload className="h-4 w-4" />{lang === 'th' ? 'อัปโหลดสลิปการชำระเงิน' : 'Upload payment slip'}
                  <input type="file" accept="image/*" className="hidden" onChange={pickProof} />
                </label>
              )}
            </div>
            <button onClick={submit} disabled={busy || !proof} className="w-full h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'ยืนยันการชำระเงิน' : 'Submit payment'}
            </button>
            <p className="text-[11px] text-gray-400 text-center">{lang === 'th' ? `มีปัญหาใช่ไหม? ติดต่อเราได้ที่ ${supportEmail}` : `Problems? Contact us at ${supportEmail}`}</p>
          </div>
        )}
      </div>
    </div>
  )
}
