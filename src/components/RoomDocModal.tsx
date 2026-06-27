import { useState, useEffect } from 'react'
import { X, Upload, Printer, Download, Check, FileText, Loader2, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

const BUCKET = 'kaizen-invoices'
const MAX_BYTES = 2 * 1024 * 1024 // matches the bucket cap

export interface DocLineRef {
  id: string
  room_no: string
  slot: string | null
  item: string | null
  document_path?: string | null
  document_name?: string | null
}

// Downscale an image to a JPEG under the size cap (digital PDFs are already small; we don't
// recompress PDFs). Returns the original file if it isn't an image or compression doesn't help.
async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
    for (const [maxEdge, q] of [[1600, 0.7], [1280, 0.6], [1024, 0.5]] as const) {
      const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
      const w = Math.max(1, Math.round(bmp.width * scale))
      const h = Math.max(1, Math.round(bmp.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) break
      ctx.drawImage(bmp, 0, 0, w, h)
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q))
      if (blob && blob.size <= MAX_BYTES) { bmp.close(); return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) }
    }
    bmp.close()
  } catch { /* fall through to original */ }
  return file
}

/**
 * Upload (Accounting) or view (Front Office / Monitor) a room line's document.
 * - mode 'upload': pick a PDF/image, preview, submit → stores it and calls onUploaded.
 * - mode 'view': renders the stored doc via a short-lived signed URL with Save / Print and,
 *   when canConfirm, a "Confirm received" action.
 */
export function RoomDocModal({ companyId, line, mode, canConfirm, canReplace, onClose, onUploaded, onConfirm }: {
  companyId: string
  line: DocLineRef
  mode: 'upload' | 'view'
  canConfirm?: boolean
  canReplace?: boolean
  onClose: () => void
  onUploaded?: (path: string, name: string) => void | Promise<void>
  onConfirm?: () => void | Promise<void>
}) {
  const { lang } = useLanguage()
  const [curMode, setCurMode] = useState<'upload' | 'view'>(mode)
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false) // submit guard ("are you sure?")
  const [confirmingReceive, setConfirmingReceive] = useState(false) // Front Office receive guard
  const [loadingDoc, setLoadingDoc] = useState(mode === 'view')

  const title = line.item?.trim() || line.slot?.trim() || (lang === 'th' ? 'เอกสาร' : 'Document')

  // View mode: mint a short-lived signed URL for the stored object.
  useEffect(() => {
    if (curMode !== 'view' || !line.document_path) { setLoadingDoc(false); return }
    let stale = false
    supabase.storage.from(BUCKET).createSignedUrl(line.document_path, 300).then(({ data, error }) => {
      if (stale) return
      if (error) toast.error(error.message)
      setSignedUrl(data?.signedUrl ?? null)
      setLoadingDoc(false)
    })
    return () => { stale = true }
  }, [curMode, line.document_path])

  function onPick(file: File | undefined) {
    if (!file) return
    if (!(file.type === 'application/pdf' || file.type.startsWith('image/'))) {
      toast.error(lang === 'th' ? 'รองรับเฉพาะ PDF หรือรูปภาพ' : 'Only PDF or image files are supported.')
      return
    }
    if (picked?.url) URL.revokeObjectURL(picked.url)
    setPicked({ file, url: URL.createObjectURL(file) })
    setConfirming(false)
  }

  async function doSubmit() {
    if (!picked) return
    setBusy(true)
    const file = await shrinkImage(picked.file)
    if (file.size > MAX_BYTES) {
      setBusy(false); setConfirming(false)
      toast.error(lang === 'th'
        ? 'ไฟล์ใหญ่เกิน 2 MB — กรุณาบันทึก PDF ให้เล็กลง หรือถ่ายรูปเอกสารแทน'
        : 'File is over 2 MB — export a smaller PDF or upload a photo of the document instead.')
      return
    }
    const ext = file.type === 'application/pdf' ? 'pdf' : (file.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${companyId}/${line.room_no}-${line.id}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: true })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    await onUploaded?.(path, picked.file.name)
    if (picked.url) URL.revokeObjectURL(picked.url)
    onClose()
  }

  async function save() {
    if (!line.document_path) return
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(line.document_path, 120, { download: line.document_name || true })
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }
  function print() { if (signedUrl) window.open(signedUrl, '_blank') }

  async function confirm() {
    if (!onConfirm) return
    setBusy(true)
    await onConfirm()
    setBusy(false)
    onClose()
  }

  const isPdf = (picked?.file.type === 'application/pdf') || (curMode === 'view' && (line.document_name?.toLowerCase().endsWith('.pdf') || line.document_path?.toLowerCase().endsWith('.pdf')))
  const previewUrl = curMode === 'upload' ? picked?.url : signedUrl

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">{title}</h3>
            <p className="text-xs text-gray-400">{line.room_no}{curMode === 'upload' ? ` · ${lang === 'th' ? 'อัปโหลดเอกสาร' : 'Upload document'}` : ''}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {curMode === 'upload' && !picked && (
            <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 py-12 cursor-pointer hover:border-[var(--brand-primary)]">
              <Upload className="h-8 w-8 text-gray-400" />
              <span className="text-sm font-medium text-gray-600">{lang === 'th' ? 'เลือกไฟล์ PDF หรือรูปภาพ' : 'Choose a PDF or image'}</span>
              <span className="text-[11px] text-gray-400">{lang === 'th' ? 'สูงสุด 2 MB (รูปภาพจะถูกย่ออัตโนมัติ)' : 'Max 2 MB (images are shrunk automatically)'}</span>
              <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = '' }} />
            </label>
          )}

          {previewUrl ? (
            <div className="rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
              {isPdf
                ? <iframe title="document" src={previewUrl} className="w-full" style={{ height: '60vh' }} />
                : <img src={previewUrl} alt={title} className="w-full max-h-[60vh] object-contain" />}
            </div>
          ) : curMode === 'view' && (loadingDoc ? (
            <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-16 text-gray-400">
              <FileText className="h-8 w-8" /><span className="text-sm">{lang === 'th' ? 'ไม่พบเอกสาร' : 'No document found'}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-200 flex-shrink-0">
          {curMode === 'upload' ? (
            confirming ? (
              <>
                <span className="text-xs text-gray-600 flex-1">{lang === 'th' ? 'ยืนยันส่งเอกสารนี้ไปยังแผนกต้อนรับ?' : 'Send this document to Front Office?'}</span>
                <button onClick={() => setConfirming(false)} disabled={busy} className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                  {lang === 'th' ? 'ย้อนกลับ' : 'Back'}
                </button>
                <button onClick={doSubmit} disabled={busy}
                  className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'ยืนยันส่ง' : 'Yes, submit'}
                </button>
              </>
            ) : (
            <>
              {picked && (
                <label className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 cursor-pointer">
                  <RefreshCw className="h-4 w-4" />{lang === 'th' ? 'เปลี่ยนไฟล์' : 'Change file'}
                  <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = '' }} />
                </label>
              )}
              <button onClick={() => setConfirming(true)} disabled={!picked || busy}
                className="ml-auto flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'ส่งเอกสาร' : 'Submit document'}
              </button>
            </>
            )
          ) : confirmingReceive ? (
            <>
              <span className="text-xs text-gray-600 flex-1">{lang === 'th' ? 'ยืนยันว่าได้รับเอกสารแล้ว? ความรับผิดชอบจะเป็นของแผนกต้อนรับ และบัญชีจะแก้ไขไม่ได้อีก' : 'Confirm you received this document? Responsibility moves to Front Office and Accounting can no longer change it.'}</span>
              <button onClick={() => setConfirmingReceive(false)} disabled={busy} className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                {lang === 'th' ? 'ย้อนกลับ' : 'Back'}
              </button>
              <button onClick={confirm} disabled={busy}
                className="flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'ยืนยันรับ' : 'Yes, confirm'}
              </button>
            </>
          ) : (
            <>
              <button onClick={save} disabled={!line.document_path} className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <Download className="h-4 w-4" />{lang === 'th' ? 'บันทึก' : 'Save'}
              </button>
              <button onClick={print} disabled={!signedUrl} className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <Printer className="h-4 w-4" />{lang === 'th' ? 'พิมพ์' : 'Print'}
              </button>
              {canReplace && (
                <button onClick={() => { setCurMode('upload'); setPicked(null) }}
                  className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                  <RefreshCw className="h-4 w-4" />{lang === 'th' ? 'เปลี่ยนเอกสาร' : 'Replace'}
                </button>
              )}
              {canConfirm && (
                <button onClick={() => setConfirmingReceive(true)} disabled={busy || !line.document_path}
                  className="ml-auto flex items-center gap-1.5 bg-[var(--brand-primary)] text-white text-sm font-semibold px-4 h-9 rounded-lg disabled:opacity-50">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{lang === 'th' ? 'ยืนยันรับเอกสาร' : 'Confirm received'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
