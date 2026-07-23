// Coordinates deferral of the service-worker auto-update reload (see index.html).
//
// index.html reloads the page when a new service worker takes control, so an
// installed PWA never stays on a stale build. But that reload fires on
// `controllerchange`, which is commonly reached right after the app returns to
// the foreground (index.html re-checks for updates on `visibilitychange`) — and
// returning from the native camera IS a foreground event. The result: tapping
// "Take Photo", capturing, and returning could reload the page mid-upload,
// discarding the in-progress photo and the resolve form around it. (That leak is
// visible as orphaned objects in the kaizen-photos bucket.)
//
// While any block is held, index.html defers the reload; when the last block is
// released it applies the pending reload (if one was deferred). Multiple callers
// can hold independent blocks by reason — the reload waits for all to clear.

const reasons = new Set<string>()

export function blockSWReload(reason: string): void {
  reasons.add(reason)
  try { (window as unknown as { __kaizenDeferReload?: boolean }).__kaizenDeferReload = true } catch { /* window unavailable */ }
}

export function unblockSWReload(reason: string): void {
  reasons.delete(reason)
  if (reasons.size > 0) return
  try {
    const w = window as unknown as { __kaizenDeferReload?: boolean; __kaizenApplyPendingReload?: () => void }
    w.__kaizenDeferReload = false
    w.__kaizenApplyPendingReload?.()
  } catch { /* window unavailable */ }
}
