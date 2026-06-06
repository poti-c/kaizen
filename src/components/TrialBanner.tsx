import { AlertTriangle, Clock } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'

const TRIAL_DAYS = 30

/**
 * Shows a free-trial countdown to the hotel's decision-makers (owner/managers)
 * while the company is on the Starter ('trial') plan. The reminder becomes
 * prominent in the final 7 days and red once the trial has ended.
 */
export function TrialBanner() {
  const { activeCompany } = useCompany()
  const { profile } = useAuth()
  const { lang } = useLanguage()

  // Only the people who'd actually subscribe need to see this.
  if (!profile || (profile.role !== 'super_admin' && profile.role !== 'manager')) return null
  const company = activeCompany as { plan?: string | null; created_at?: string | null } | null
  if (!company || company.plan !== 'trial' || !company.created_at) return null

  const start = new Date(String(company.created_at).slice(0, 10) + 'T00:00:00')
  const end = new Date(start); end.setDate(start.getDate() + TRIAL_DAYS)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const daysLeft = Math.ceil((end.getTime() - today.getTime()) / 86400000)

  const expired = daysLeft < 0
  const urgent = !expired && daysLeft <= 7

  const tone = expired || urgent
    ? 'bg-amber-50 border-amber-300 text-amber-900'
    : 'bg-sky-50 border-sky-200 text-sky-900'
  const Icon = expired ? AlertTriangle : Clock

  const msg = (() => {
    if (lang === 'th') {
      if (expired) return 'แพ็กเกจ Starter ของคุณสิ้นสุดแล้ว — อัปเกรดเป็น Gold หรือ Premium เพื่อใช้งานต่อ เรายินดีดูแลคุณเสมอ'
      if (urgent) return `แพ็กเกจ Starter ของคุณเหลืออีก ${daysLeft} วัน — อัปเกรดเป็น Gold หรือ Premium เพื่อให้ทุกอย่างราบรื่น เรายินดีช่วยเหลือ`
      return `คุณกำลังใช้แพ็กเกจ Starter — มีเวลา ${daysLeft} วันในการสำรวจฟีเจอร์ทั้งหมดของ Kaizen อัปเกรดเป็น Gold หรือ Premium ได้ทุกเมื่อที่พร้อม`
    }
    if (expired) return "Your Starter plan has ended — upgrade to Gold or Premium to continue. We'd love to keep serving you."
    if (urgent) return `Your Starter plan has ${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining — upgrade to Gold or Premium to keep everything running smoothly. We're happy to help.`
    return `You're on the Starter plan — ${daysLeft} days to explore everything Kaizen offers. Upgrade to Gold or Premium whenever you're ready.`
  })()

  return (
    <div className={`flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium border-b ${tone}`}>
      <Icon className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1">{msg}</span>
    </div>
  )
}
