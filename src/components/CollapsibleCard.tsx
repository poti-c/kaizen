import { useState, type ReactNode, type ComponentType } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * A settings card whose body collapses/expands when the header is clicked.
 * Collapsed by default (set `defaultOpen` to start expanded). Keeps the same
 * white-card chrome used across the Settings page.
 */
export function CollapsibleCard({
  icon: Icon,
  title,
  badge,
  defaultOpen = false,
  bodyClassName = 'px-6 pb-6',
  children,
}: {
  icon?: ComponentType<{ className?: string }>
  title: ReactNode
  badge?: ReactNode
  defaultOpen?: boolean
  bodyClassName?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-6 py-5 text-left hover:bg-gray-50 transition-colors"
      >
        {Icon && <Icon className="h-4 w-4 text-gray-400 flex-shrink-0" />}
        <h2 className="font-semibold text-gray-900">{title}</h2>
        {badge != null && (
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full font-medium">{badge}</span>
        )}
        <ChevronDown className={`ml-auto h-4 w-4 text-gray-400 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className={bodyClassName}>{children}</div>}
    </div>
  )
}
