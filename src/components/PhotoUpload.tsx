import { useState, useRef } from 'react'
import { Upload, X, Image, Camera, ImageIcon } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { cn, buildPhotoPath } from '@/lib/utils'
import { useLanguage } from '@/contexts/LanguageContext'

// True on any touch-capable device (phones, tablets)
const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)

// Downscale + re-encode a photo before upload so Storage doesn't fill up with raw
// multi-megabyte camera shots. Evidence photos don't need full resolution —
// max 1600px longest edge at 70% JPEG turns a 3–8 MB photo into ~300–600 KB.
// Falls back to the original file if it isn't a raster image or anything fails.
// NOTE: `Image` is shadowed by the lucide-react import in this file, so we build
// the element via document.createElement('img').
async function compressImage(file: File, maxEdge = 1600, quality = 0.7): Promise<{ blob: Blob; ext: string }> {
  const rawExt = (file.name.split('.').pop() ?? 'jpg').toLowerCase()
  if (!file.type.startsWith('image/')) return { blob: file, ext: rawExt }
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const img = document.createElement('img')
      const url = URL.createObjectURL(file)
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.round(img.naturalWidth * scale)
        const h = Math.round(img.naturalHeight * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        const ctx = canvas.getContext('2d')
        URL.revokeObjectURL(url)
        if (!ctx) return reject(new Error('no canvas context'))
        ctx.drawImage(img, 0, 0, w, h)
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality)
      }
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
      img.src = url
    })
    // Only keep the compressed version if it's actually smaller.
    return blob.size < file.size ? { blob, ext: 'jpg' } : { blob: file, ext: rawExt }
  } catch {
    return { blob: file, ext: rawExt }
  }
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

    const uploadedUrls: string[] = []

    for (const item of items) {
      const { blob, ext } = await compressImage(item.file)
      const path =
        caseNumber && department
          ? buildPhotoPath(caseNumber, department, photoIndexRef.current++, ext, companyId)
          : `Na Nirand Kaizen/unsorted/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { data, error } = await supabase.storage.from(bucket).upload(path, blob, { contentType: blob.type || 'image/jpeg' })

      if (!error && data) {
        const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(data.path)
        const url = urlData.publicUrl
        uploadedUrls.push(url)
        setPreviews((prev) =>
          prev.map((p) => (p.preview === item.preview ? { ...p, uploading: false, url } : p))
        )
      } else {
        setPreviews((prev) => prev.filter((p) => p.preview !== item.preview))
      }
    }

    if (uploadedUrls.length > 0) {
      onUpload(uploadedUrls)
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
