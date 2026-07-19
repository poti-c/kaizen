import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface LoadErrorProps {
  message: string
  onRetry?: () => void
  retryLabel?: string
  icon?: ReactNode
  dark?: boolean
  compact?: boolean
  className?: string
}

// Shared "failed to load, offer a retry" state for wherever a page/panel's
// data fetch can fail and needs to show something better than a silently
// empty or stale view (previously reimplemented near-identically in
// console/Calendar.tsx, SettingsPage.tsx's MultiDeptManagersSection, and
// pm/PMReport.tsx). `compact` renders a single inline line with no retry
// button, for smaller in-page sections; otherwise a centered block meant to
// replace the loading-spinner state it follows.
export function LoadError({ message, onRetry, retryLabel = 'Retry', icon, dark, compact, className }: LoadErrorProps) {
  if (compact) {
    return <p className={cn('text-sm py-2', dark ? 'text-red-400' : 'text-red-500', className)}>{message}</p>
  }
  return (
    <div className={cn('flex flex-col items-center gap-3 text-center', className)}>
      {icon}
      <p className={cn('text-sm max-w-sm', dark ? 'text-slate-400' : 'text-gray-600')}>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className={cn(
            'px-4 h-9 rounded-lg text-sm font-medium',
            dark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-[var(--brand-primary)] text-white'
          )}
        >
          {retryLabel}
        </button>
      )}
    </div>
  )
}
