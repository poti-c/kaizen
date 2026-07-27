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

// Reference-counted per reason, not membership in a Set — a single PhotoUpload mount
// reuses one reason string across every capture it makes (see reloadReasonRef in
// PhotoUpload.tsx), and two captures can genuinely overlap (tap "Take Photo" again while
// the first is still compressing/uploading). A Set collapsed both calls to one entry, so
// the FIRST capture finishing released the block while the SECOND was still in flight —
// exactly the mid-upload reload this mechanism exists to prevent.
const reasons = new Map<string, number>()

export function blockSWReload(reason: string): void {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  try { (window as unknown as { __kaizenDeferReload?: boolean }).__kaizenDeferReload = true } catch { /* window unavailable */ }
}

function releaseIfAllClear(): void {
  if (reasons.size > 0) return
  try {
    const w = window as unknown as { __kaizenDeferReload?: boolean; __kaizenApplyPendingReload?: () => void }
    w.__kaizenDeferReload = false
    w.__kaizenApplyPendingReload?.()
  } catch { /* window unavailable */ }
}

export function unblockSWReload(reason: string): void {
  const count = reasons.get(reason) ?? 0
  if (count <= 1) reasons.delete(reason)
  else reasons.set(reason, count - 1)
  releaseIfAllClear()
}

// Unconditionally drops every outstanding block held under `reason`, regardless of how
// many overlapping blockSWReload calls are still unmatched. Used as a component-unmount
// safety net — a per-call unblockSWReload there would only cancel ONE of possibly several
// still-open blocks (e.g. two overlapping photo captures), leaving the reason stuck with a
// positive count forever once the component is gone and nothing can ever call
// unblockSWReload for it again, permanently deferring every future reload for the page.
export function clearSWReloadReason(reason: string): void {
  reasons.delete(reason)
  releaseIfAllClear()
}
