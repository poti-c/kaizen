import { CheckCircle2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { PhotoGallery } from '@/components/PhotoUpload'
import { useLanguage } from '@/contexts/LanguageContext'
import type { KaizenCase, KaizenCaseTimeline, KaizenCasePhoto } from '@/types'

interface ResolutionCardProps {
  kcase: KaizenCase
  timeline: KaizenCaseTimeline[]
  resolutionPhotos: KaizenCasePhoto[]
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Heading for the resolved (non-reopened) state, e.g. t.caseDetail.resolutionPhotos */
  resolutionPhotosLabel: string
}

/**
 * Shows the case resolution. For reopened cases it renders as a collapsible
 * "Previous Resolution" card; otherwise as a standard resolved card.
 * Returns null when there is nothing to show.
 */
export function ResolutionCard({
  kcase,
  timeline,
  resolutionPhotos,
  collapsed,
  onToggleCollapsed,
  resolutionPhotosLabel,
}: ResolutionCardProps) {
  const { lang } = useLanguage()
  // resolution_note column (new cases) OR fall back to timeline entry for older cases
  const resolutionDesc =
    kcase.resolution_note ||
    timeline.find((e) => e.action === 'resolved')?.description?.replace(/^Staff resolved the case:\s*/i, '') ||
    null
  if (!resolutionDesc && resolutionPhotos.length === 0) return null

  const isReopened = kcase.status === 'reopened'

  // Date: prefer the most recent resolved/closed timeline entry
  const resolvedTimelineEntry = [...timeline].reverse().find((e) => e.action === 'resolved' || e.action === 'closed')
  const resolutionDate = resolvedTimelineEntry?.created_at
    ? new Date(resolvedTimelineEntry.created_at).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok',
      })
    : null

  if (isReopened) {
    return (
      <div className="border border-amber-200 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="w-full flex items-center gap-2 px-5 py-3.5 bg-amber-50 hover:bg-amber-100 transition-colors text-left"
        >
          <RefreshCw className="h-4 w-4 text-amber-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-amber-900 text-sm">{lang === 'th' ? 'การแก้ไขครั้งก่อน' : 'Previous Resolution'}</span>
            {resolutionDate && <span className="ml-2 text-xs text-amber-600">{lang === 'th' ? `· แก้ไขเมื่อ ${resolutionDate}` : `· Resolved ${resolutionDate}`}</span>}
          </div>
          {collapsed
            ? <ChevronDown className="h-4 w-4 text-amber-500 flex-shrink-0" />
            : <ChevronUp className="h-4 w-4 text-amber-500 flex-shrink-0" />}
        </button>

        {!collapsed && (
          <div className="bg-amber-50/40 px-5 pb-5 pt-4 space-y-4 border-t border-amber-100">
            {resolutionDesc && (
              <div className="bg-white border border-amber-200 rounded-lg px-4 py-3">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">{lang === 'th' ? 'รายละเอียดการแก้ไข' : 'Resolution Description'}</p>
                <p className="text-sm text-gray-800 whitespace-pre-wrap">{resolutionDesc}</p>
              </div>
            )}
            {resolutionPhotos.length > 0 && <PhotoGallery urls={resolutionPhotos.map((p) => p.photo_url)} />}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="bg-green-50 border border-green-200 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-green-600" />
        <h3 className="font-semibold text-green-900">{resolutionPhotosLabel}</h3>
        {resolutionDate && <span className="ml-auto text-xs text-green-600">{resolutionDate}</span>}
      </div>

      {resolutionDesc && (
        <div className="bg-white border border-green-200 rounded-lg px-4 py-3">
          <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1">{lang === 'th' ? 'รายละเอียดการแก้ไข' : 'Resolution Description'}</p>
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{resolutionDesc}</p>
        </div>
      )}

      {resolutionPhotos.length > 0 && <PhotoGallery urls={resolutionPhotos.map((p) => p.photo_url)} />}
    </div>
  )
}
