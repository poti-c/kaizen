import { useState, useRef } from 'react'
import { Upload, X, Image, Camera, ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { cn, buildPhotoPath } from '@/lib/utils'
import { useLanguage } from '@/contexts/LanguageContext'

// True on any touch-capable device (phones, tablets)
const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)

// Must match the kaizen-photos Storage bucket config, or uploads fail server-side
// (the old code silently dropped the photo — the #1 "can't upload on Android" cause).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

function rawExtOf(file: File): string {
  return (file.name.split('.').pop() ?? 'jpg').toLowerCase()
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
async function decodeImage(file: File): Promise<{ w: number; h: number; src: CanvasImageSource; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
      return { w: bmp.width, h: bmp.height, src: bmp, release: () => bmp.close() }
    } catch {
      // Some formats (e.g. HEIC on Android) can't be decoded this way — try <img> next.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = document.createElement('img')
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image load failed'))
      el.src = url
    })
    return { w: img.naturalWidth, h: img.naturalHeight, src: img, release: () => URL.revokeObjectURL(url) }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

// Re-encode a camera photo to a JPEG that fits the Storage bucket: downscale and step the
// quality/edge down until it's under the size cap. Evidence photos don't need full
// resolution. Returns null when the image can't be decoded or re-encoded AND the raw file
// isn't an uploadable type/size (e.g. an unsupported HEIC) — so the caller can tell the
// user instead of silently dropping the photo.
async function compressImage(file: File): Promise<{ blob: Blob; ext: string } | null> {
  if (!file.type.startsWith('image/')) return null

  const rawUsable = ALLOWED_TYPES.includes(file.type) && file.size <= MAX_UPLOAD_BYTES
  const rawFallback = () => (rawUsable ? { blob: file, ext: rawExtOf(file) } : null)

  let decoded: Awaited<ReturnType<typeof decodeImage>>
  try {
    decoded = await withTimeout(decodeImage(file), 15000)
  } catch {
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
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality))
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
}

export function PhotoUpload({ onUpload, maxFiles = 3, label = 'Add Photos', bucket = 'kaizen-photos', caseNumber, department, companyId }: PhotoUploadProps) {
  const { lang } = useLanguage()
  const [previews, setPreviews] = useState<{ file: File; preview: string; uploading: boolean; url?: string }[]>([])
  const [dragOver, setDragOver] = useState(false)
  const desktopInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const photoIndexRef = useRef(1)

  const remaining = maxFiles - previews.length

  async function handleFiles(files: FileList | null) {
    if (!files || remaining <= 0) return
    const newFiles = Array.from(files).slice(0, remaining)

    const items = newFiles.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      uploading: true,
    }))

    setPreviews((prev) => [...prev, ...items])

    for (const item of items) {
      const compressed = await compressImage(item.file)
      if (!compressed) {
        // Couldn't produce an uploadable image (unsupported format like HEIC, or still too
        // large). Tell the user instead of silently dropping it.
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
          : `Na Nirand Kaizen/unsorted/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { data, error } = await supabase.storage.from(bucket).upload(path, blob, { contentType: blob.type || 'image/jpeg' })

      if (!error && data) {
        const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(data.path)
        const url = urlData.publicUrl
        setPreviews((prev) =>
          prev.map((p) => (p.preview === item.preview ? { ...p, uploading: false, url } : p))
        )
        // Report each photo as soon as it's uploaded rather than batching at the end of
        // the loop — on Android, backgrounding the tab to open the camera can get the
        // page killed and reloaded by the OS before the loop finishes, which used to lose
        // every already-uploaded photo because onUpload() never got called for them.
        onUpload([url])
      } else {
        setPreviews((prev) => prev.filter((p) => p.preview !== item.preview))
        toast.error((lang === 'th' ? 'อัปโหลดรูปไม่สำเร็จ: ' : 'Photo upload failed: ') + (error?.message ?? 'unknown error'))
      }
    }
  }

  function remove(index: number) {
    setPreviews((prev) => {
      const removed = prev[index]
      URL.revokeObjectURL(removed.preview)
      return prev.filter((_, i) => i !== index)
    })
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
              onClick={() => cameraInputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 py-5 active:bg-gray-50 transition-colors"
            >
              <Camera className="h-7 w-7 text-gray-400" />
              <span className="text-xs font-medium text-gray-500">{lang === 'th' ? 'ถ่ายรูป' : 'Take Photo'}</span>
            </button>
            {/* Choose from Library button */}
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
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
              <img src={item.preview} alt="" className="w-full h-full object-cover" />
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
