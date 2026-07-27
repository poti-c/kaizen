import { useState, useRef, useEffect } from 'react'
import { Upload, X, Image, Camera, ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { cn, buildPhotoPath } from '@/lib/utils'
import { useLanguage } from '@/contexts/LanguageContext'
import { blockSWReload, unblockSWReload, clearSWReloadReason } from '@/lib/swReload'

// Per-mount id so each PhotoUpload holds its own SW-reload deferral independently.
let photoUploadSeq = 0

// True on any touch-capable device (phones, tablets)
const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)

// Must match the kaizen-photos Storage bucket config, or uploads fail server-side
// (the old code silently dropped the photo — the #1 "can't upload on Android" cause).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

// Set right before we open the native camera. Opening the camera backgrounds the tab, and
// low-memory Android can kill it while the camera app is foreground — the captured File then
// never reaches the (dead) page, so the photo is silently lost. sessionStorage survives the
// OS tab-kill-and-restore (the same property CreateCasePage's draft recovery relies on), so
// if this marker is still present when PhotoUpload next mounts, we know a capture was
// interrupted and can tell the user to retake it instead of leaving a silent gap.
// Exported so CreateCasePage can tell an OS-forced reload-during-capture apart from a genuine
// cold return to an abandoned draft, and suppress its "Restored your unsaved draft" toast in
// the former case (the reload here is expected, not a recovered abandonment).
export const CAMERA_PENDING_KEY = 'kaizen-camera-capture-pending'
// Ignore a stale marker older than this (e.g. a much-later session restore) to avoid a
// confusing warning long after the fact.
export const CAMERA_PENDING_MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes

function rawExtOf(file: File): string {
  return (file.name.split('.').pop() ?? 'jpg').toLowerCase()
}

// Image file extensions we recognise when the browser gives us NO MIME type.
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp']
// Extensions we can upload verbatim (raw fallback) without re-encoding.
const RAW_OK_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif']

// Old Android browsers/WebViews very often deliver a camera/gallery File with an EMPTY
// `type` (""), which the old `type.startsWith('image/')` guard rejected outright — the
// #1 reason photos couldn't be uploaded on those phones.
//
// Worse: many Android gallery / file-manager pickers ALSO hand back a name with no
// usable extension (e.g. "image", or a content:// URI), so keying off the filename
// dropped these too — a valid JPEG whose thumbnail even renders, rejected before we ever
// try to decode it. When the MIME is empty we trust the <input accept="image/*"> filter
// and let the decoder be the real judge (a non-image will simply fail to decode and get
// the same clear error). Only a file that positively declares a non-image MIME is
// rejected up front.
function looksLikeImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  if (file.type === '') return true
  return IMAGE_EXTS.includes(rawExtOf(file))
}

// HEIC/HEIF is the default "High Efficiency" capture format on modern Samsung/Pixel and
// iOS phones, and the browser's native image pipeline (createImageBitmap / <img>) CANNOT
// decode it on Android — so those photos failed to upload entirely. Detect them so we can
// transcode to JPEG first. Android often delivers HEIC as `image/heic`/`image/heif`, or as
// an empty MIME with a `.heic`/`.heif` name.
function isHeic(file: File): boolean {
  const t = file.type.toLowerCase()
  if (t === 'image/heic' || t === 'image/heif' || t === 'image/heic-sequence' || t === 'image/heif-sequence') return true
  if (t === '') { const e = rawExtOf(file); return e === 'heic' || e === 'heif' }
  return false
}

// Transcode a HEIC/HEIF blob to a JPEG the canvas pipeline can then downscale. The heic2any
// decoder (libheif-wasm, ~fat) is dynamically imported so it only downloads for the users
// who actually pick a HEIC — it never enters the main bundle. Returns null if decoding fails.
async function heicToJpeg(file: Blob): Promise<Blob | null> {
  try {
    const { default: heic2any } = await import('heic2any')
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 })
    return Array.isArray(out) ? (out[0] ?? null) : out
  } catch {
    return null
  }
}

// Convert a data URL (from canvas.toDataURL) into a Blob, for engines lacking canvas.toBlob.
function dataURLToBlob(dataURL: string): Blob {
  const comma = dataURL.indexOf(',')
  const header = dataURL.slice(0, comma)
  const body = dataURL.slice(comma + 1)
  const mime = header.slice(header.indexOf(':') + 1, header.indexOf(';')) || 'image/jpeg'
  const bin = atob(body)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// canvas.toBlob is missing on old Android (stock browser / old WebView). Fall back to the
// universally-supported toDataURL so re-encode/downscale still works there instead of
// throwing and dropping the photo.
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(resolve, type, quality)
      return
    }
    try {
      resolve(dataURLToBlob(canvas.toDataURL(type, quality)))
    } catch {
      resolve(null)
    }
  })
}

// Resolve a promise but never hang: low-memory Android devices can stall an <img>
// decode indefinitely (neither onload nor onerror fires), which would freeze the
// upload loop on a spinner forever. A timeout turns that into a graceful fallback.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('decode timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

// Decode a File into something drawable. Prefer createImageBitmap — it uses less memory
// than an <img> element and honours EXIF orientation, so Android camera shots aren't
// uploaded sideways. Falls back to an <img> element where the API is missing.
// NOTE: `Image` is shadowed by the lucide-react import here, so we use document.createElement.
// `onUrlCreated` reports the <img>-fallback's object URL the instant it's created (before
// awaiting the load), so a caller racing this against a timeout (see compressImage) can
// still revoke it even if decodeImage's own promise never settles in time — otherwise that
// promise, and the `release` closure holding the only other reference to the URL, is
// silently discarded and the blob leaks for the rest of the page's life.
async function decodeImage(file: Blob, onUrlCreated?: (url: string) => void): Promise<{ w: number; h: number; src: CanvasImageSource; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
      return { w: bmp.width, h: bmp.height, src: bmp, release: () => bmp.close() }
    } catch {
      // Some formats can't be decoded this way — try an <img> element next. (HEIC is
      // transcoded to JPEG upstream in compressImage before it ever reaches here.)
    }
  }
  const url = URL.createObjectURL(file)
  onUrlCreated?.(url)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = document.createElement('img')
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image load failed'))
      el.src = url
    })
    return { w: img.naturalWidth, h: img.naturalHeight, src: img, release: () => { try { URL.revokeObjectURL(url) } catch { /* already revoked */ } } }
  } catch (e) {
    try { URL.revokeObjectURL(url) } catch { /* already revoked */ }
    throw e
  }
}

// Re-encode a camera photo to a JPEG that fits the Storage bucket: downscale and step the
// quality/edge down until it's under the size cap. Evidence photos don't need full
// resolution. Returns null when the image can't be decoded or re-encoded AND the raw file
// isn't an uploadable type/size (e.g. an unsupported HEIC) — so the caller can tell the
// user instead of silently dropping the photo.
async function compressImage(file: File): Promise<{ blob: Blob; ext: string } | null> {
  if (!looksLikeImage(file)) return null

  // HEIC/HEIF can't be decoded natively — transcode to JPEG first, then run the normal
  // downscale/re-encode path on the result. If the transcode fails the photo genuinely
  // can't be used (the raw HEIC isn't an uploadable bucket type either), so bail to null
  // and let the caller show a clear error instead of silently dropping it.
  let input: Blob = file
  let inputType = file.type
  let rawExt = rawExtOf(file)
  if (isHeic(file)) {
    let jpeg: Blob | null = null
    try {
      jpeg = await withTimeout(heicToJpeg(file), 20000)
    } catch {
      jpeg = null
    }
    if (!jpeg) return null
    input = jpeg
    inputType = 'image/jpeg'
    rawExt = 'jpg'
  }

  // The (post-transcode) input is uploadable as-is when it's a known image type/extension
  // and within the size cap. Accept empty-MIME files whose extension is a plain web image
  // (old Android) so the raw fallback can still rescue them if re-encoding is unavailable.
  const rawTypeOk = ALLOWED_TYPES.includes(inputType) || (inputType === '' && RAW_OK_EXTS.includes(rawExt))
  const rawUsable = rawTypeOk && input.size <= MAX_UPLOAD_BYTES
  const rawFallback = () => (rawUsable ? { blob: input, ext: rawExt } : null)

  // Set synchronously by decodeImage's <img>-fallback branch, before the (possibly slow)
  // load it then awaits — so if withTimeout below rejects first, we can still revoke it.
  let pendingUrl: string | null = null
  let decoded: Awaited<ReturnType<typeof decodeImage>>
  try {
    decoded = await withTimeout(decodeImage(input, (url) => { pendingUrl = url }), 15000)
  } catch {
    if (pendingUrl) { try { URL.revokeObjectURL(pendingUrl) } catch { /* already revoked */ } }
    return rawFallback()
  }

  try {
    for (const [maxEdge, quality] of [[1600, 0.7], [1280, 0.6], [1024, 0.5], [800, 0.45]] as const) {
      const scale = Math.min(1, maxEdge / Math.max(decoded.w, decoded.h))
      const w = Math.max(1, Math.round(decoded.w * scale))
      const h = Math.max(1, Math.round(decoded.h * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) break
      ctx.drawImage(decoded.src, 0, 0, w, h)
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return { blob, ext: 'jpg' }
    }
  } catch {
    // fall through to the raw fallback
  } finally {
    decoded.release()
  }

  return rawFallback()
}

interface PhotoUploadProps {
  onUpload: (urls: string[]) => void
  maxFiles?: number
  label?: string
  bucket?: string
  caseNumber?: string
  department?: string
  companyId?: string
  // Already-uploaded photo URLs to show as removable thumbnails on mount — used to
  // rehydrate a recovered draft (e.g. the resolve form after an update reload) so
  // photos that survived in the parent's state are visible again, not just queued.
  initialUrls?: string[]
  // Called when a thumbnail is removed, so the parent can drop the URL from its own
  // list (onUpload only ever appends). Without it a removed photo is still submitted.
  onRemove?: (url: string) => void
}

export function PhotoUpload({ onUpload, maxFiles = 3, label = 'Add Photos', bucket = 'kaizen-photos', caseNumber, department, companyId, initialUrls, onRemove }: PhotoUploadProps) {
  const { lang } = useLanguage()
  // `file` is dropped (set undefined) once the photo is uploaded — see handleFiles — so the
  // multi-MB uncompressed camera File isn't pinned in memory for the rest of the form's life.
  const [previews, setPreviews] = useState<{ file?: File; preview: string; uploading: boolean; url?: string }[]>(
    // Seed once from any recovered URLs (already in Storage, so uploading:false).
    () => (initialUrls ?? []).map((url) => ({ preview: url, url, uploading: false })),
  )
  const [dragOver, setDragOver] = useState(false)
  const desktopInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const photoIndexRef = useRef(1)
  // This mount's SW-reload deferral reason, and the fallback timer that releases it
  // if the user returns from the picker without choosing a file (no handleFiles).
  const reloadReasonRef = useRef<string>('')
  if (!reloadReasonRef.current) reloadReasonRef.current = `photo-upload-${++photoUploadSeq}`
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const remaining = maxFiles - previews.length

  // Camera-capture interruption guard. See CAMERA_PENDING_KEY above.
  const clearCameraPending = () => {
    try { sessionStorage.removeItem(CAMERA_PENDING_KEY) } catch { /* storage unavailable */ }
  }
  const markCameraPending = () => {
    try { sessionStorage.setItem(CAMERA_PENDING_KEY, String(Date.now())) } catch { /* storage unavailable */ }
    // Hold off any pending SW update reload until the capture has been handled —
    // otherwise returning from the camera can reload the page and lose the photo.
    blockSWReload(reloadReasonRef.current)
  }

  // Safety net: always release this mount's reload block (and its timer) when the
  // component unmounts, so a deferral can never get stuck open. Uses the full-clear
  // variant, not unblockSWReload — if two captures were overlapping when this unmounts,
  // a per-call unblock would only cancel one of them, leaving the reason permanently
  // stuck at a positive count since nothing can call unblock for it after unmount.
  useEffect(() => () => {
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
    clearSWReloadReason(reloadReasonRef.current)
  }, [])

  // On mount, if a capture was pending (the tab was killed while the camera was open), the
  // photo never made it back — warn the user to retake it rather than leaving a silent gap.
  useEffect(() => {
    let pending: string | null = null
    try { pending = sessionStorage.getItem(CAMERA_PENDING_KEY) } catch { /* storage unavailable */ }
    if (!pending) return
    clearCameraPending()
    const age = Date.now() - Number(pending)
    if (Number.isFinite(age) && age >= 0 && age <= CAMERA_PENDING_MAX_AGE_MS) {
      toast.error(lang === 'th'
        ? 'รูปที่เพิ่งถ่ายอาจไม่ได้ถูกบันทึก — กรุณาถ่ายใหม่อีกครั้ง'
        : "Your last photo may not have been captured — please take it again.")
    }
    // Run once on mount; `lang` is captured at that point which is fine for a one-shot toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Returning to the tab (camera closed, whether a photo was taken or cancelled) means the
  // page survived — clear the pending marker so it can't trigger a false warning on a later
  // reload. A genuine tab-kill destroys the page before this ever runs, leaving the marker
  // for the mount check above.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      clearCameraPending()
      // Returned from the camera/gallery. If a file was chosen, handleFiles holds
      // the reload block and releases it when the upload finishes. If the user
      // cancelled (no onChange), release it after a short grace period so a pending
      // SW update isn't deferred forever.
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = setTimeout(() => {
        releaseTimerRef.current = null
        unblockSWReload(reloadReasonRef.current)
      }, 5000)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  async function handleFiles(files: FileList | null) {
    // A capture (or cancel) returned to a live page — the interruption guard no longer applies.
    clearCameraPending()
    // A file arrived, so cancel the visibility-based fallback release; the reload
    // block is now held for the whole upload and released in `finally` below.
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null }
    if (!files || remaining <= 0) { unblockSWReload(reloadReasonRef.current); return }
    const newFiles = Array.from(files).slice(0, remaining)

    const items = newFiles.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      uploading: true,
    }))

    setPreviews((prev) => [...prev, ...items])

    try {
    for (const item of items) {
      const compressed = await compressImage(item.file)
      if (!compressed) {
        // Couldn't produce an uploadable image (unsupported format like HEIC, or still too
        // large). Tell the user instead of silently dropping it.
        try { URL.revokeObjectURL(item.preview) } catch { /* already revoked */ }
        setPreviews((prev) => prev.filter((p) => p.preview !== item.preview))
        toast.error(lang === 'th'
          ? 'อัปโหลดรูปนี้ไม่ได้ — ไฟล์ใหญ่เกินไปหรือไม่รองรับ (ลองถ่ายใหม่หรือเลือกจากคลังภาพ)'
          : "Couldn't use this photo — it's too large or an unsupported format (try retaking it or picking from your library).")
        continue
      }
      const { blob, ext } = compressed
      const path =
        caseNumber && department
          ? buildPhotoPath(caseNumber, department, photoIndexRef.current++, ext, companyId)
          // PHOTO-ORPHAN-01: no spaces — see the matching comment in buildPhotoPath.
          : `na_nirand_kaizen/unsorted/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { data, error } = await supabase.storage.from(bucket).upload(path, blob, { contentType: blob.type || 'image/jpeg' })

      if (!error && data) {
        const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(data.path)
        const url = urlData.publicUrl
        setPreviews((prev) =>
          prev.map((p) => {
            if (p.preview !== item.preview) return p
            // Photo is safely in Storage now. Revoke the local object URL and drop the
            // uncompressed File so neither is pinned in memory while the form stays open —
            // lowering the page's footprint during capture, when low-memory Android is
            // deciding whether to kill the backgrounded tab. The thumbnail switches to the
            // remote `url` below (`item.url ?? item.preview`), so nothing visual is lost.
            try { URL.revokeObjectURL(p.preview) } catch { /* already revoked */ }
            return { ...p, uploading: false, url, file: undefined }
          })
        )
        // Report each photo as soon as it's uploaded rather than batching at the end of
        // the loop — on Android, backgrounding the tab to open the camera can get the
        // page killed and reloaded by the OS before the loop finishes, which used to lose
        // every already-uploaded photo because onUpload() never got called for them.
        onUpload([url])
      } else {
        try { URL.revokeObjectURL(item.preview) } catch { /* already revoked */ }
        setPreviews((prev) => prev.filter((p) => p.preview !== item.preview))
        toast.error((lang === 'th' ? 'อัปโหลดรูปไม่สำเร็จ: ' : 'Photo upload failed: ') + (error?.message ?? 'unknown error'))
      }
    }
    } finally {
      // Whole capture handled (uploaded and reported, or failed) — the photo now
      // lives in Storage + the parent's state, so an SW update reload is safe again.
      unblockSWReload(reloadReasonRef.current)
    }
  }

  function remove(index: number) {
    // PHOTO-REMOVE-RENDER-01: onRemove (the parent's setState) must NOT be called from
    // inside the setPreviews updater — React updater functions can run during another
    // component's render, and calling a different component's setState there triggers
    // "Cannot update a component while rendering a different component". Read the item
    // and fire onRemove/revoke here, outside any setState callback; only the filter
    // itself needs the functional form.
    const removed = previews[index]
    if (!removed) return
    // Only a local object URL needs revoking; a remote (already-uploaded) URL must not be.
    if (removed.url !== removed.preview) { try { URL.revokeObjectURL(removed.preview) } catch { /* already revoked */ } }
    // Keep the parent's list in sync — onUpload only appends, so without this a
    // removed (or recovered) photo would still be submitted.
    if (removed.url) onRemove?.(removed.url)
    setPreviews((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3">
      {remaining > 0 && (
        isTouchDevice ? (
          /* ── Mobile: Camera + Gallery buttons ── */
          <div className="grid grid-cols-2 gap-3">
            {/* Take Photo button */}
            <button
              type="button"
              onClick={() => { markCameraPending(); cameraInputRef.current?.click() }}
              className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 py-5 active:bg-gray-50 transition-colors"
            >
              <Camera className="h-7 w-7 text-gray-400" />
              <span className="text-xs font-medium text-gray-500">{lang === 'th' ? 'ถ่ายรูป' : 'Take Photo'}</span>
            </button>
            {/* Choose from Library button */}
            <button
              type="button"
              onClick={() => { markCameraPending(); galleryInputRef.current?.click() }}
              className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 py-5 active:bg-gray-50 transition-colors"
            >
              <ImageIcon className="h-7 w-7 text-gray-400" />
              <span className="text-xs font-medium text-gray-500">{lang === 'th' ? 'เลือกจากคลังภาพ' : 'Choose from Library'}</span>
            </button>
            {/* Hidden camera input — opens rear camera directly */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
            />
            {/* Hidden gallery input — opens photo library */}
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
            />
          </div>
        ) : (
          /* ── Desktop: drag & drop zone ── */
          <div
            className={cn(
              'border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors',
              dragOver ? 'border-[var(--brand-primary)] bg-blue-50' : 'border-gray-300 hover:border-gray-400'
            )}
            onClick={() => desktopInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
          >
            <Upload className="mx-auto h-8 w-8 text-gray-400 mb-2" />
            <p className="text-sm text-gray-600 font-medium">{label}</p>
            <p className="text-xs text-gray-400 mt-1">{lang === 'th' ? `คลิกหรือลากวาง — JPG, PNG, WEBP (สูงสุด ${maxFiles} รูป)` : `Click or drag & drop — JPG, PNG, WEBP (max ${maxFiles} photos)`}</p>
            <input
              ref={desktopInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
            />
          </div>
        )
      )}

      {previews.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {previews.map((item, i) => (
            <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-gray-100">
              {/* Once uploaded, prefer the stored URL: the local object-URL preview of a
                  HEIC can't be rendered by the browser, so it would show broken otherwise. */}
              <img src={item.url ?? item.preview} alt="" className="w-full h-full object-cover" />
              {item.uploading && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              {!item.uploading && (
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="absolute top-1 right-1 bg-red-600 text-white rounded-full p-0.5 shadow-sm"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface PhotoGalleryProps {
  urls: string[]
  className?: string
}

export function PhotoGallery({ urls, className }: PhotoGalleryProps) {
  const { lang } = useLanguage()
  const [selected, setSelected] = useState<string | null>(null)

  if (urls.length === 0) {
    return (
      <div className={cn('flex items-center justify-center h-24 bg-gray-50 rounded-lg border border-dashed border-gray-200', className)}>
        <div className="text-center text-gray-400">
          <Image className="h-6 w-6 mx-auto mb-1" />
          <p className="text-xs">{lang === 'th' ? 'ไม่มีรูปภาพ' : 'No photos'}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={cn('grid grid-cols-3 gap-2', className)}>
        {urls.map((url, i) => (
          <div
            key={i}
            className="relative aspect-square rounded-lg overflow-hidden bg-gray-100 cursor-pointer group"
            onClick={() => setSelected(url)}
          >
            <img src={url} alt={`Photo ${i + 1}`} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" />
          </div>
        ))}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setSelected(null)}
        >
          <img src={selected} alt="Full size" className="max-w-full max-h-full rounded-lg object-contain" />
          <button className="absolute top-4 right-4 text-white bg-black/40 rounded-full p-2">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </>
  )
}
