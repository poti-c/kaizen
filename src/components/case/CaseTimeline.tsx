import { formatDateTime } from '@/lib/utils'
import { useLanguage } from '@/contexts/LanguageContext'
import { timelineActionLabel } from '@/lib/i18nDynamic'
import type { KaizenCaseTimeline } from '@/types'

interface CaseTimelineProps {
  timeline: KaizenCaseTimeline[]
  title: string
  emptyLabel: string
}

export function CaseTimeline({ timeline, title, emptyLabel }: CaseTimelineProps) {
  const { lang } = useLanguage()
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sticky top-4">
      <h3 className="font-semibold text-gray-900 mb-4">{title}</h3>
      {timeline.length === 0 ? (
        <p className="text-sm text-gray-400">{emptyLabel}</p>
      ) : (
        <div className="space-y-3">
          {timeline.map((entry, i) => (
            <div key={entry.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)] mt-1.5 flex-shrink-0" />
                {i < timeline.length - 1 && <div className="w-0.5 flex-1 bg-gray-100 mt-1" />}
              </div>
              <div className="flex-1 min-w-0 pb-3">
                <p className="text-xs font-medium text-gray-900">{timelineActionLabel(entry.action, lang)}</p>
                {entry.description && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{entry.description}</p>}
                <p className="text-xs text-gray-400 mt-1">
                  {formatDateTime(entry.created_at)}
                  {entry.performer?.full_name && (
                    <span>{lang === 'th' ? ' · โดย ' : ' · by '}<span className="font-medium text-gray-500">{entry.performer.full_name}</span></span>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
