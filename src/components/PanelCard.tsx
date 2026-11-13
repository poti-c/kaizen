import type { CSSProperties, ReactNode } from 'react'
import { PANEL as P } from '@/lib/panelTheme'
import { cn } from '@/lib/utils'

/** A titled card on the 1024×600 wall canvas. Shared by every board. */
export function Panel({ className, style, title, right, children }: {
  className?: string
  style?: CSSProperties
  title?: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className={cn('rounded-xl p-3 flex flex-col min-w-0', className)}
      style={{ background: P.card, border: `1px solid ${P.border}`, ...style }}
    >
      {title && (
        <div className="flex items-baseline justify-between mb-2 flex-shrink-0">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: P.muted }}>{title}</h2>
          {right}
        </div>
      )}
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  )
}
