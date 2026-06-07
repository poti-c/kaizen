import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Crown, Check, X as XIcon, Wrench, Clock, Loader2, Mail, ArrowLeft, Lock, Calendar, Upload, QrCode } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { companyHasAddon, addonTrialDaysLeft, subscriptionInfo } from '@/lib/utils'
import { toast } from 'sonner'

const SALES_EMAIL = 'info@nnr-solutions.com'
const RANK: Record<string, number> = { trial: 0, gold: 1, premium: 2 }
const PRICE: Record<string, number> = { gold: 39000, premium: 0, pms: 10000 } // 0 = quote only

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
  { key: 'trial', name: 'Starter', price: 'Free · 30 days', icon: Sparkles },
  { key: 'gold', name: 'Gold', price: '฿39,000 / year', icon: Crown },
  { key: 'premium', name: 'Premium', price: 'Contact for pricing', icon: Crown },
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

export function PackagesExpansions() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<{ managers: number; staff: number } | null>(null)
  const [vendor, setVendor] = useState<Vendor | null>(null)
  const [payItem, setPayItem] = useState<PayItem | null>(null)

  useEffect(() => {
    supabase.from('kaizen_console_settings').select('promptpay_id, promptpay_name, promptpay_qr, support_email').eq('id', true).maybeSingle()
      .then(({ data }) => setVendor(data as Vendor))
  }, [])

  function openPay(item: PayItem) {
    if (upgradeLocked) { toast.error('Only Top Management have access.'); return }
    if (!item.amount) { requestQuote(item.label); return } // no fixed price → quote
    setPayItem(item)
  }

  const isTopMgmt = profile?.role === 'super_admin'
  const hidePrices = !isTopMgmt          // managers don't see prices
  const upgradeLocked = !isTopMgmt       // managers can't act

  const sub = subscriptionInfo(activeCompany)
  const plan = activeCompany?.plan ?? 'trial'
  const planRank = RANK[plan] ?? 0
  const planName = PACKAGES.find(p => p.key === plan)?.name ?? 'Starter'
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
    if (sub.expired) return `Your ${planName} plan has ended — renew any time to pick up right where you left off.`
    if (sub.daysLeft == null) return `You're on the ${planName} plan. We're glad to have you with us.`
    if (sub.isTrial) return `Welcome aboard! You have ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} on your Starter plan to explore everything Kaizen System offers.`
    return `You're all set on the ${planName} plan — ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} of full access remaining. Thank you for being with us.`
  })()

  async function startPmsTrial() {
    if (upgradeLocked) { toast.error('Only Top Management have access.'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('kaizen_start_pms_trial')
    setBusy(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Preventive Maintenance unlocked until ${fmtDate(data as string)}`)
    setTimeout(() => window.location.reload(), 700)
  }
  function requestQuote(item: string) {
    if (upgradeLocked) { toast.error('Only Top Management have access.'); return }
    window.location.href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Kaizen System — ${item}`)}&body=${encodeURIComponent(`Hi NNR-Solutions,\n\nWe'd like a quotation for: ${item}\n\nCompany: ${activeCompany?.name ?? ''}\n`)}`
  }

  const overM = maxM != null && usage != null && usage.managers >= maxM
  const overS = maxS != null && usage != null && usage.staff >= maxS

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto animate-fade-in">
      <button onClick={() => navigate('/settings')} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-4">
        <ArrowLeft className="h-4 w-4" />Back to Settings
      </button>

      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="h-5 w-5 text-[var(--brand-primary)]" />
        <h1 className="text-xl font-bold text-gray-900">Packages &amp; Expansions</h1>
      </div>
      <p className="text-sm text-gray-500 mb-5">Your plan, available upgrades and add-ons.</p>

      {/* Welcome countdown */}
      <div className="rounded-xl bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/15 p-4 mb-5">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="h-4 w-4 text-[var(--brand-primary)]" />
          <span className="text-sm font-semibold text-gray-900">Current plan: {planName}</span>
          {sub.daysLeft != null && !sub.expired && <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${sub.daysLeft <= 7 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{sub.daysLeft} days left</span>}
          {sub.expired && <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Ended</span>}
        </div>
        <p className="text-sm text-gray-600">{welcome}</p>
        {sub.end && <p className="text-xs text-gray-500 mt-1 flex items-center gap-1"><Calendar className="h-3 w-3" />{sub.isTrial ? 'Trial ends' : 'Subscription ends'}: {fmtDate(sub.end)}</p>}
      </div>

      {/* Usage nudge */}
      {usage && (overM || overS) && planRank < 2 && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 mb-5 text-sm text-amber-800">
          {overM && <p>You're using {usage.managers}/{maxM} managers.</p>}
          {overS && <p>You're using {usage.staff}/{maxS} staff.</p>}
          <p className="mt-0.5">Upgrade to {planRank === 0 ? 'Gold or Premium' : 'Premium'} for more capacity.</p>
        </div>
      )}

      {/* Packages */}
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Subscription plans</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {PACKAGES.map((p) => {
          const current = p.key === plan
          const canUpgrade = (RANK[p.key] ?? 0) > planRank   // only higher tiers
          const Icon = p.icon
          return (
            <div key={p.key} className={`rounded-xl border p-4 flex flex-col ${current ? 'border-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5' : 'border-gray-200'}`}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <Icon className="h-4 w-4 text-[var(--brand-primary)]" />
                <span className="font-semibold text-gray-900">{p.name}</span>
                {current && <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--brand-primary)] text-white">Current</span>}
              </div>
              {!hidePrices && <p className="text-sm font-bold text-gray-900 mb-2">{p.price}</p>}
              <div className="flex-1" />
              {canUpgrade && (
                <button onClick={() => openPay({ kind: 'subscription', target: p.key, label: `${p.name} plan`, amount: PRICE[p.key] ?? 0 })}
                  className={`mt-3 w-full h-8 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 ${upgradeLocked ? 'bg-gray-100 text-gray-400' : 'bg-[var(--brand-primary)] text-white hover:opacity-90'}`}>
                  {upgradeLocked && <Lock className="h-3 w-3" />}Upgrade
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Comparison table */}
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Compare plans</p>
      <div className="overflow-x-auto rounded-xl border border-gray-200 mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left font-semibold text-gray-500 px-3 py-2">Feature</th>
              <th className="text-center font-semibold text-gray-700 px-3 py-2">Starter</th>
              <th className="text-center font-semibold text-gray-700 px-3 py-2">Gold</th>
              <th className="text-center font-semibold text-gray-700 px-3 py-2">Premium</th>
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((row) => (
              <tr key={row.label} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-2 text-gray-700">{row.label}</td>
                {row.values.map((v, i) => (
                  <td key={i} className="px-3 py-2 text-center">
                    {v === true ? <Check className="h-4 w-4 text-green-500 mx-auto" />
                      : v === false ? <XIcon className="h-4 w-4 text-gray-300 mx-auto" />
                      : <span className="text-xs text-gray-700">{v}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add-ons (no prices shown) */}
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Expansions (add-ons)</p>
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
                    <span className="font-semibold text-gray-900 text-sm">{a.name}</span>
                    {purchased && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">Active</span>}
                    {!purchased && trialLeft != null && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700">Trial · {trialLeft} days left</span>}
                  </div>
                  <p className="text-[11px] text-gray-600 mt-0.5">{a.desc}</p>
                  {/* Subscription-end counter for a purchased add-on (pauses with the subscription) */}
                  {purchased && sub.end && <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1"><Calendar className="h-3 w-3" />Active until {fmtDate(sub.end)}{sub.daysLeft != null && !sub.expired ? ` · ${sub.daysLeft} days left` : ''}</p>}
                  <div className="flex items-center gap-2 mt-2">
                    {purchased ? null : trialLeft != null || trialUsed ? (
                      <button onClick={() => openPay({ kind: 'addon', target: a.key, label: a.name, amount: PRICE[a.key] ?? 0 })} className={`h-8 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${upgradeLocked ? 'bg-gray-100 text-gray-400' : 'bg-[var(--brand-primary)] text-white'}`}>{upgradeLocked && <Lock className="h-3 w-3" />}Subscribe</button>
                    ) : (
                      <>
                        <button onClick={startPmsTrial} disabled={busy} className={`h-8 px-3 rounded-lg text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5 ${upgradeLocked ? 'bg-gray-100 text-gray-400' : 'bg-[var(--brand-primary)] text-white'}`}>
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : upgradeLocked ? <Lock className="h-3 w-3" /> : <Sparkles className="h-3.5 w-3.5" />}Try free for 7 days
                        </button>
                        <button onClick={() => requestQuote(a.name)} className="h-8 px-3 rounded-lg border border-gray-300 text-gray-600 text-xs font-medium flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" />Ask for a quote</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[11px] text-gray-400 leading-relaxed">
        Note: expansions run alongside your subscription. If your subscription ends before an expansion period, the expansion is <span className="font-medium text-gray-500">paused</span> and resumes automatically once your subscription is renewed.
      </p>

      <div className="mt-6 flex items-center justify-center">
        <button onClick={() => requestQuote('Book a demo / call')} className="flex items-center gap-1.5 text-sm font-medium text-[var(--brand-primary)] hover:opacity-75">
          <Mail className="h-4 w-4" />Book a demo or call with our team
        </button>
      </div>

      {payItem && <PayModal item={payItem} vendor={vendor} companyId={activeCompany?.id ?? ''} supportEmail={vendor?.support_email ?? 'potichao@me.com'} onClose={() => setPayItem(null)} />}
    </div>
  )
}

function PayModal({ item, vendor, companyId, supportEmail, onClose }: {
  item: PayItem; vendor: Vendor | null; companyId: string; supportEmail: string; onClose: () => void
}) {
  const [proof, setProof] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function pickProof(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image of your payment slip.'); return }
    try { setProof(await fileToProof(file)) } catch { toast.error('Could not read that image.') }
  }
  async function submit() {
    if (!proof) { toast.error('Please attach your payment slip.'); return }
    setBusy(true)
    const { error } = await supabase.from('kaizen_payment_submissions').insert({
      company_id: companyId, kind: item.kind, target: item.target, target_label: item.label,
      amount: item.amount, currency: 'THB', proof_url: proof, status: 'pending',
    })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    setSubmitted(true)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">{submitted ? 'Thank you!' : `Pay for ${item.label}`}</h3>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><XIcon className="h-4 w-4" /></button>
        </div>

        {submitted ? (
          <div className="px-5 py-6 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto"><Check className="h-6 w-6 text-green-600" /></div>
            <p className="text-sm text-gray-700">🎉 Thank you for choosing Kaizen System! We've received your payment confirmation.</p>
            <p className="text-sm text-gray-600">Your {item.label} will be activated within <span className="font-semibold">24 hours</span>. Once it's active, please <span className="font-semibold">restart the app</span> to see your new features.</p>
            <p className="text-xs text-gray-500">Having trouble? Reach us any time via <span className="font-medium">Help</span>.</p>
            <button onClick={onClose} className="mt-1 w-full h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold">Done</button>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-3 overflow-y-auto">
            <p className="text-sm text-gray-600">Scan the PromptPay QR below to pay <span className="font-bold text-gray-900">฿{item.amount.toLocaleString()}</span>, then upload your payment slip.</p>
            <div className="rounded-xl border border-gray-200 p-3 flex flex-col items-center">
              {vendor?.promptpay_qr ? (
                <img src={vendor.promptpay_qr} alt="PromptPay QR" className="w-44 h-44 object-contain" />
              ) : (
                <div className="w-44 h-44 flex flex-col items-center justify-center text-gray-400 text-center"><QrCode className="h-10 w-10 mb-2" /><span className="text-xs">{vendor?.promptpay_id ? `PromptPay: ${vendor.promptpay_id}` : 'Payment details coming soon — please contact support.'}</span></div>
              )}
              {vendor?.promptpay_name && <p className="text-xs text-gray-600 mt-2">{vendor.promptpay_name}</p>}
            </div>

            <div>
              {proof ? (
                <div className="flex items-center gap-3">
                  <img src={proof} alt="Slip" className="w-14 h-14 rounded-lg object-cover border border-gray-200" />
                  <button onClick={() => setProof(null)} className="text-xs text-red-500">Remove</button>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 h-16 rounded-lg border-2 border-dashed border-gray-300 hover:border-gray-400 cursor-pointer text-gray-500 text-sm">
                  <Upload className="h-4 w-4" />Upload payment slip
                  <input type="file" accept="image/*" className="hidden" onChange={pickProof} />
                </label>
              )}
            </div>
            <button onClick={submit} disabled={busy || !proof} className="w-full h-9 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Submit payment
            </button>
            <p className="text-[11px] text-gray-400 text-center">Problems? Contact us at {supportEmail}</p>
          </div>
        )}
      </div>
    </div>
  )
}
