import { useState } from 'react'
import { Languages, Loader2, RotateCcw } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'
import { useCompany } from '@/contexts/CompanyContext'
import { companyHasFeature } from '@/lib/utils'
import { toast } from 'sonner'

const THAI_RE = /[฀-๿]/g
const LATIN_RE = /[A-Za-z]/g
// MyMemory rejects long inputs; chunk well under its limit (Thai chars are multi-byte).
const MAX_CHUNK = 300
// MyMemory returns HTTP 200 with an error string embedded in translatedText.
const MM_ERROR_RE = /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID (SOURCE|TARGET)|PLEASE SELECT TWO DISTINCT/i

function splitChunks(s: string, max = MAX_CHUNK): string[] {
  if (s.length <= max) return [s]
  const chunks: string[] = []
  let rest = s
  while (rest.length > max) {
    // Prefer breaking at a sentence/newline near the limit, else a space, else hard cut.
    const sentence = Math.max(rest.lastIndexOf('. ', max), rest.lastIndexOf('\n', max))
    let cut = sentence > max * 0.5 ? sentence + 1 : rest.lastIndexOf(' ', max)
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) chunks.push(rest)
  return chunks
}

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
  const { activeCompany } = useCompany()
  const [translated, setTranslated] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showingTranslation, setShowingTranslation] = useState(false)

  // Dominant-script detection so mixed text (mostly one language with a few
  // foreign chars) picks the correct source language.
  const thaiCount = (text.match(THAI_RE) || []).length
  const latinCount = (text.match(LATIN_RE) || []).length
  const target: 'th' | 'en' = lang === 'th' ? 'th' : 'en'
  const source: 'th' | 'en' | null = thaiCount > latinCount ? 'th' : latinCount > 0 ? 'en' : null
  const canTranslate = !!text.trim() && source !== null && source !== target && companyHasFeature(activeCompany, 'translation')

  async function translateChunk(chunk: string): Promise<string> {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${source}|${target}`
    )
    const data = await res.json()
    const out: string | undefined = data?.responseData?.translatedText
    if (!out || data?.responseStatus >= 400 || MM_ERROR_RE.test(out)) {
      throw new Error('translation error')
    }
    return out
  }

  async function handleTranslate() {
    // If already translated, just toggle between original/translation
    if (translated) {
      setShowingTranslation((v) => !v)
      return
    }
    setLoading(true)
    try {
      // Split long text into chunks (MyMemory rejects long inputs), translate each.
      const parts: string[] = []
      for (const chunk of splitChunks(text)) {
        parts.push(await translateChunk(chunk))
      }
      setTranslated(parts.join(' '))
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
