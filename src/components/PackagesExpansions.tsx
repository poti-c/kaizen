import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Crown, Check, X as XIcon, Wrench, Clock, Loader2, Mail, ArrowLeft, Lock, Calendar } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { companyHasAddon, addonTrialDaysLeft, subscriptionInfo } from '@/lib/utils'
import { toast } from 'sonner'

const SALES_EMAIL = 'info@nnr-solutions.com'
const RANK: Record<string, number> = { trial: 0, gold: 1, premium: 2 }

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
                <button onClick={() => upgradeLocked ? toast.error('Only Top Management have access.') : requestQuote(`${p.name} plan`)}
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
                      <button onClick={() => requestQuote(`${a.name} subscription`)} className={`h-8 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${upgradeLocked ? 'bg-gray-100 text-gray-400' : 'bg-[var(--brand-primary)] text-white'}`}>{upgradeLocked && <Lock className="h-3 w-3" />}Subscribe</button>
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
    </div>
  )
}
