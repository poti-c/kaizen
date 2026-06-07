import { useState } from 'react'
import { Sparkles, Crown, Check, Wrench, Clock, Loader2, Mail } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { companyHasAddon, addonTrialDaysLeft, subscriptionInfo } from '@/lib/utils'
import { toast } from 'sonner'

const SALES_EMAIL = 'info@nnr-solutions.com'

const PACKAGES = [
  { key: 'trial', name: 'Starter', price: 'Free · 30 days', icon: Sparkles,
    highlights: ['Issue reporting & case tracking', 'Calendar', 'Up to 2 managers · 10 staff'] },
  { key: 'gold', name: 'Gold', price: '฿39,000 / year', icon: Crown,
    highlights: ['Everything in Starter', 'Performance analytics', 'Translation & activity log', 'Up to 5 managers · 50 staff'] },
  { key: 'premium', name: 'Premium', price: 'Contact for pricing', icon: Crown,
    highlights: ['Everything in Gold', 'All features unlocked', 'Multi-property', 'Unlimited managers & staff'] },
]

const ADDONS = [
  { key: 'pms' as const, name: 'Preventive Maintenance Scheduler', price: '฿10,000 / year', icon: Wrench,
    desc: 'Register assets, auto-generate scheduled maintenance, checklists, approvals and a live health dashboard.' },
]

export function PackagesExpansions() {
  const { activeCompany } = useCompany()
  const [busy, setBusy] = useState(false)
  const sub = subscriptionInfo(activeCompany)
  const plan = activeCompany?.plan ?? 'trial'
  const planName = PACKAGES.find(p => p.key === plan)?.name ?? 'Starter'

  const welcome = (() => {
    if (sub.expired) return `Your ${planName} plan has ended — renew any time to pick up right where you left off.`
    if (sub.daysLeft == null) return `You're on the ${planName} plan. We're glad to have you with us.`
    if (sub.isTrial) return `Welcome aboard! You have ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} on your Starter plan to explore everything Kaizen System offers.`
    return `You're all set on the ${planName} plan — ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} of full access remaining. Thank you for being with us.`
  })()

  async function startPmsTrial() {
    setBusy(true)
    const { data, error } = await supabase.rpc('kaizen_start_pms_trial')
    setBusy(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Preventive Maintenance unlocked until ${data}`)
    setTimeout(() => window.location.reload(), 600)
  }
  function requestQuote(item: string) {
    window.location.href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Kaizen System — ${item}`)}&body=${encodeURIComponent(`Hi NNR-Solutions,\n\nWe'd like a quotation for: ${item}\n\nCompany: ${activeCompany?.name ?? ''}\n`)}`
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-6 pt-6 pb-1">
        <Sparkles className="h-4 w-4 text-[var(--brand-primary)]" />
        <h2 className="font-semibold text-gray-900">Packages &amp; Expansions</h2>
      </div>
      <p className="px-6 text-xs text-gray-500 mb-4">Your plan, available upgrades and add-ons.</p>

      {/* Welcome countdown */}
      <div className="mx-6 mb-5 rounded-xl bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/15 p-4">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="h-4 w-4 text-[var(--brand-primary)]" />
          <span className="text-sm font-semibold text-gray-900">Current plan: {planName}</span>
          {sub.daysLeft != null && !sub.expired && (
            <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${sub.daysLeft <= 7 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{sub.daysLeft} days left</span>
          )}
          {sub.expired && <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Ended</span>}
        </div>
        <p className="text-sm text-gray-600">{welcome}</p>
      </div>

      {/* Packages */}
      <div className="px-6 mb-5">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Subscription plans</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {PACKAGES.map((p) => {
            const current = p.key === plan
            const Icon = p.icon
            return (
              <div key={p.key} className={`rounded-xl border p-4 flex flex-col ${current ? 'border-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5' : 'border-gray-200'}`}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Icon className="h-4 w-4 text-[var(--brand-primary)]" />
                  <span className="font-semibold text-gray-900">{p.name}</span>
                  {current && <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--brand-primary)] text-white">Current</span>}
                </div>
                <p className="text-sm font-bold text-gray-900 mb-2">{p.price}</p>
                <ul className="space-y-1 flex-1">
                  {p.highlights.map((h) => (
                    <li key={h} className="flex items-start gap-1.5 text-[11px] text-gray-600"><Check className="h-3 w-3 text-green-500 flex-shrink-0 mt-0.5" />{h}</li>
                  ))}
                </ul>
                {!current && p.key !== 'trial' && (
                  <button onClick={() => requestQuote(`${p.name} plan`)} className="mt-3 w-full h-8 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-semibold hover:opacity-90">
                    Upgrade
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Add-ons */}
      <div className="px-6 pb-5">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Expansions (add-ons)</p>
        <div className="space-y-2">
          {ADDONS.map((a) => {
            const active = companyHasAddon(activeCompany, a.key)
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
                      <span className="ml-auto text-xs font-bold text-gray-900">{a.price}</span>
                    </div>
                    <p className="text-[11px] text-gray-600 mt-0.5">{a.desc}</p>
                    <div className="flex items-center gap-2 mt-2">
                      {purchased ? null : trialLeft != null ? (
                        <button onClick={() => requestQuote(`${a.name} (convert trial to subscription)`)} className="h-8 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-semibold">Subscribe</button>
                      ) : trialUsed ? (
                        <button onClick={() => requestQuote(a.name)} className="h-8 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-semibold">Subscribe</button>
                      ) : (
                        <>
                          <button onClick={startPmsTrial} disabled={busy} className="h-8 px-3 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5">
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Try free for 7 days
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
        <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
          Note: expansions run alongside your subscription. If your subscription ends before an expansion period, the expansion is <span className="font-medium text-gray-500">paused</span> and resumes automatically once your subscription is renewed.
        </p>
      </div>
    </div>
  )
}
