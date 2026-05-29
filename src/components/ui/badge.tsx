import * as React from 'react'
import { cn } from '@/lib/utils'

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'destructive'
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
        {
          'bg-[var(--brand-primary)] text-white border-transparent': variant === 'default',
          'bg-gray-100 text-gray-800 border-transparent': variant === 'secondary',
          'border-current text-current': variant === 'outline',
          'bg-red-100 text-red-800 border-red-200': variant === 'destructive',
        },
        className
      )}
      {...props}
    />
  )
}
