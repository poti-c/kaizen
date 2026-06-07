// Client-app error reporter.
// Captures real runtime errors from the hotel app (uncaught window errors,
// unhandled promise rejections, and React render errors via ErrorBoundary)
// and logs them to `kaizen_error_log` so they surface in the System Console
// under Audit Logs → Errors. Best-effort and silent: the reporter never throws.
import { supabase } from './supabase'

let currentCompanyId: string | null = null
let installed = false
const recent = new Map<string, number>()
const DEDUPE_MS = 60_000

/** Keep the reporter aware of the active company so errors are scoped correctly. */
export function setErrorContext(companyId: string | null) {
  currentCompanyId = companyId
}

export async function reportError(
  source: 'window' | 'promise' | 'react' | 'app',
  message: string,
  detail: Record<string, unknown> = {},
) {
  try {
    const msg = (message || '').trim()
    if (!msg) return

    // De-duplicate the same error within a short window to avoid log floods.
    const key = `${source}|${msg.slice(0, 200)}`
    const now = Date.now()
    const last = recent.get(key)
    if (last && now - last < DEDUPE_MS) return
    recent.set(key, now)
    if (recent.size > 100) recent.clear()

    // RLS only permits authenticated inserts; skip anonymous (pre-login) errors.
    const { data: u } = await supabase.auth.getUser()
    const uid = u?.user?.id ?? null
    if (!uid) return

    await supabase.from('kaizen_error_log').insert({
      company_id: currentCompanyId,
      user_id: uid,
      source,
      message: msg.slice(0, 1000),
      detail,
      url: typeof location !== 'undefined' ? location.href : null,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    })
  } catch {
    /* never throw from the reporter */
  }
}

/** Install global window-level handlers once. */
export function installGlobalErrorReporter() {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (e) => {
    void reportError('window', e.message || 'Uncaught error', {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: (e.error as Error | undefined)?.stack?.slice(0, 2000),
    })
  })

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    const msg = r instanceof Error ? r.message : String(r)
    void reportError('promise', msg || 'Unhandled promise rejection', {
      stack: r instanceof Error ? r.stack?.slice(0, 2000) : undefined,
    })
  })
}
