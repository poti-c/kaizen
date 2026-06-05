import { useState } from 'react'
import { Languages, Loader2, RotateCcw } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'
import { toast } from 'sonner'

const THAI_RE = /[฀-๿]/
const LATIN_RE = /[A-Za-z]/

/**
 * A card section that shows text, plus a "Translate" button in the header
 * when the text's language differs from the current UI language.
 * Translation uses the free MyMemory API (no key required).
 */
export function TranslatableSection({
  title,
  text,
  className = '',
}: {
  title: string
  text: string
  className?: string
}) {
  const { lang, t } = useLanguage()
  const [translated, setTranslated] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showingTranslation, setShowingTranslation] = useState(false)

  const hasThai = THAI_RE.test(text)
  const hasLatin = LATIN_RE.test(text)
  const target: 'th' | 'en' = lang === 'th' ? 'th' : 'en'
  // Source script detection: Thai chars => 'th'; otherwise Latin letters => 'en'
  const source: 'th' | 'en' | null = hasThai ? 'th' : hasLatin ? 'en' : null
  const canTranslate = !!text.trim() && source !== null && source !== target

  async function handleTranslate() {
    // If already translated, just toggle between original/translation
    if (translated) {
      setShowingTranslation((v) => !v)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${target}`
      )
      const data = await res.json()
      const out: string | undefined = data?.responseData?.translatedText
      if (!out || data?.responseStatus >= 400) throw new Error('no translation')
      setTranslated(out)
      setShowingTranslation(true)
    } catch {
      toast.error(t.caseDetail.translateFailed)
    } finally {
      setLoading(false)
    }
  }

  const body = showingTranslation && translated ? translated : text

  return (
    <div className={`bg-white rounded-xl border border-gray-200 shadow-sm p-5 ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="font-semibold text-gray-900">{title}</h3>
        {canTranslate && (
          <button
            onClick={handleTranslate}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--brand-primary)] hover:opacity-75 transition-opacity flex-shrink-0 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : showingTranslation ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <Languages className="h-3.5 w-3.5" />
            )}
            {showingTranslation ? t.caseDetail.showOriginal : t.caseDetail.translate}
          </button>
        )}
      </div>
      <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{body}</p>
      {showingTranslation && (
        <p className="text-[10px] text-gray-400 mt-2 italic">{t.caseDetail.machineTranslation}</p>
      )}
    </div>
  )
}
