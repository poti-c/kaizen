import { createContext, useContext, useState, type ReactNode } from 'react'
import { MessageSquarePlus, X, Loader2, Check } from 'lucide-react'
const MIN_KEY = 'kaizen-feedback-minimized'
import { useLocation } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

interface FeedbackContextValue {
  openFeedback: () => void
}
const FeedbackContext = createContext<FeedbackContextValue | null>(null)

/** Open the app-wide feedback modal from anywhere (sidebar footer, floating FAB, …). */
export function useFeedback() {
  const ctx = useContext(FeedbackContext)
  if (!ctx) throw new Error('useFeedback must be used within FeedbackProvider')
  return ctx
}

/**
 * Provides the app-wide feedback modal and an `openFeedback()` trigger. Mount once (in
 * Layout). Triggers live wherever they read best — the sidebar footer on desktop, the
 * floating <FeedbackFab/> on mobile — instead of a single fixed button that can obstruct
 * page content. Captures the current route + role + company so trial friction is
 * actionable. Writes to kaizen_feedback (RLS: insert-own; Top Management reads its company's).
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth()
  const { activeCompany } = useCompany()
  const { lang } = useLanguage()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!profile) return
    const text = message.trim()
    if (!text) return
    setBusy(true)
    const { error } = await supabase.from('kaizen_feedback').insert({
      company_id: activeCompany?.id ?? null,
      user_id: profile.id,
      user_name: profile.full_name,
      role: profile.role,
      route: location.pathname,
      message: text,
      user_agent: navigator.userAgent.slice(0, 200),
      lang,
    })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    setMessage('')
    setOpen(false)
    toast.success(lang === 'th' ? 'ขอบคุณสำหรับความคิดเห็น!' : 'Thanks for your feedback!')
  }

  return (
    <FeedbackContext.Provider value={{ openFeedback: () => setOpen(true) }}>
      {children}

      {open && profile && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <MessageSquarePlus className="h-4 w-4 text-[var(--brand-primary)]" />
                {lang === 'th' ? 'ส่งความคิดเห็น' : 'Send feedback'}
              </h3>
              <button onClick={() => setOpen(false)} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
            </div>
            <div className="px-5 py-4 space-y-2">
              <p className="text-xs text-gray-500">
                {lang === 'th'
                  ? 'พบปัญหาหรือมีข้อเสนอแนะ? บอกเราได้เลย (ระบบจะแนบหน้าจอที่คุณอยู่โดยอัตโนมัติ)'
                  : 'Hit a snag or have an idea? Tell us — we’ll automatically include the screen you’re on.'}
              </p>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                autoFocus
                placeholder={lang === 'th' ? 'ความคิดเห็นของคุณ...' : 'Your feedback...'}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/40 resize-none"
              />
              <p className="text-[11px] text-gray-400">{location.pathname}</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 bg-gray-50 border-t border-gray-100">
              <button onClick={() => setOpen(false)} className="h-9 px-3 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100">
                {lang === 'th' ? 'ยกเลิก' : 'Cancel'}
              </button>
              <button onClick={submit} disabled={busy || !message.trim()}
                className="h-9 px-4 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {lang === 'th' ? 'ส่ง' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  )
}

/**
 * Floating "Send feedback" affordance for layouts without a sidebar to host the trigger
 * (mobile / bottom-nav mode). Collapses to a small bubble when dismissed; remembered per
 * device. On desktop the sidebar footer button is used instead, so this isn't rendered.
 */
export function FeedbackFab() {
  const { profile } = useAuth()
  const { lang } = useLanguage()
  const { openFeedback } = useFeedback()
  // Collapsed to a small bubble when the user dismisses it; remembered per device.
  const [minimized, setMinimized] = useState(() => localStorage.getItem(MIN_KEY) === '1')
  const minimize = (on: boolean) => { setMinimized(on); localStorage.setItem(MIN_KEY, on ? '1' : '0') }

  if (!profile) return null

  return minimized ? (
    // Collapsed: a small, unobtrusive bubble — tap to bring the button back.
    <button
      onClick={() => minimize(false)}
      title={lang === 'th' ? 'แสดงปุ่มความคิดเห็น' : 'Show feedback button'}
      className="fixed right-4 bottom-20 md:bottom-5 z-40 h-9 w-9 flex items-center justify-center rounded-full shadow-md bg-[var(--brand-primary)]/70 text-white hover:bg-[var(--brand-primary)] transition-colors"
    >
      <MessageSquarePlus className="h-4 w-4" />
    </button>
  ) : (
    <div className="fixed right-4 bottom-20 md:bottom-5 z-40 flex items-center">
      <button
        onClick={openFeedback}
        title={lang === 'th' ? 'ส่งความคิดเห็น' : 'Send feedback'}
        className="flex items-center gap-1.5 h-10 pl-3 pr-3 rounded-l-full rounded-r-none shadow-lg bg-[var(--brand-primary)] text-white text-sm font-semibold hover:opacity-90 transition-opacity"
      >
        <MessageSquarePlus className="h-4 w-4" />
        <span className="hidden sm:inline">{lang === 'th' ? 'ความคิดเห็น' : 'Feedback'}</span>
      </button>
      <button
        onClick={() => minimize(true)}
        title={lang === 'th' ? 'ซ่อน' : 'Hide'}
        className="h-10 w-7 flex items-center justify-center rounded-r-full shadow-lg bg-[var(--brand-primary)] text-white/80 hover:text-white border-l border-white/20"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
