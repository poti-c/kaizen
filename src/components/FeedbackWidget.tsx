import { createContext, useContext, useState, type ReactNode } from 'react'
import { MessageSquarePlus, X, Loader2, Check } from 'lucide-react'
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
 * Layout). Triggers live in the nav chrome — the sidebar footer on desktop, the mobile
 * nav drawer on small screens — instead of a fixed button that can obstruct page content.
 * Captures the current route + role + company so trial friction is
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
