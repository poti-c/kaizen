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

    // RLS only permits authenticated inserts, so a signed-out visitor still has
    // nothing to report to. But identity is read from the CACHED session rather
    // than getUser(): getUser() calls /auth/v1/user over the network on every
    // single error, and when that call failed the old code returned early and
    // dropped the error entirely. That inverted the reporter's purpose — a
    // flaky connection is exactly when errors happen and exactly when they were
    // least likely to be recorded. getSession() reads localStorage and cannot
    // fail for network reasons.
    const { data: s } = await supabase.auth.getSession()
    const session = s?.session ?? null
    if (!session) return
    // Fall back to null rather than dropping the row: user_id is nullable, and
    // an error with no attributed user is far more useful than no error at all.
    const uid = session.user?.id ?? null

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
    if (isOpaqueCrossOriginError(e)) return
    void reportError('window', e.message || 'Uncaught error', {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: (e.error as Error | undefined)?.stack?.slice(0, 2000),
    })
  })

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    void reportError('promise', describeReason(r), detailForReason(r))
  })
}

/**
 * The browser reports a cross-origin script exception as the bare string
 * "Script error." with filename "", lineno 0, colno 0 and no `error` object —
 * it withholds everything as a security measure. There is nothing to act on,
 * and it is never our code: Vite emits its module scripts with `crossorigin`
 * from our own origin, so an app-code error always carries a filename and a
 * line number.
 *
 * In practice these come from mobile in-app webviews and browser extensions
 * injecting their own scripts. They accounted for 77 of 220 production log
 * rows — every single `source: 'window'` row we had ever recorded — which
 * buried the errors that mattered. Genuine app failures still arrive through
 * the other channels: React render errors via ErrorBoundary ('react') and
 * async failures via unhandledrejection ('promise').
 */
function isOpaqueCrossOriginError(e: ErrorEvent): boolean {
  return !e.error && !e.filename && !e.lineno && /^script error\.?$/i.test((e.message || '').trim())
}

/**
 * A rejection reason is very often NOT an Error. Supabase/PostgREST reject with
 * a plain object ({ message, code, details, hint }), and `String(obj)` on those
 * yields the useless literal "[object Object]" — which is how 66 production
 * errors ended up unreadable, with an empty detail to match.
 */
function describeReason(r: unknown): string {
  if (r instanceof Error) return r.message || 'Unhandled promise rejection'
  if (typeof r === 'string') return r || 'Unhandled promise rejection'
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    // Supabase errors, fetch failures, and OAuth-style { error_description }.
    for (const k of ['message', 'error_description', 'error', 'statusText']) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v
    }
    const json = safeStringify(o)
    if (json && json !== '{}') return json.slice(0, 200)
  }
  return r == null ? 'Unhandled promise rejection' : String(r)
}

/** Keep the whole reason around — the message alone loses the useful part. */
function detailForReason(r: unknown): Record<string, unknown> {
  if (r instanceof Error) return { stack: r.stack?.slice(0, 2000) }
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    return {
      // PostgREST puts the actionable part in code/details/hint, not message.
      code: o.code,
      details: o.details,
      hint: o.hint,
      status: o.status,
      reason: safeStringify(o)?.slice(0, 2000),
      reasonType: Object.prototype.toString.call(r),
    }
  }
  return { reason: String(r).slice(0, 2000), reasonType: typeof r }
}

/** JSON.stringify that survives circular references and throwing getters. */
function safeStringify(v: unknown): string | undefined {
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack }
      if (val && typeof val === 'object') {
        if (seen.has(val as object)) return '[circular]'
        seen.add(val as object)
      }
      return val
    })
  } catch {
    return undefined
  }
}
