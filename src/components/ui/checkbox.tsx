import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export type CheckboxProps = React.InputHTMLAttributes<HTMLInputElement> & {
  checked?: boolean | 'indeterminate'
  onCheckedChange?: (checked: boolean | 'indeterminate') => void
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => {
    const [isChecked, setIsChecked] = React.useState(checked === true)

    return (
      <div className="relative inline-flex items-center">
        <input
          ref={ref}
          type="checkbox"
          checked={isChecked}
          onChange={(e) => {
            const newChecked = e.target.checked
            setIsChecked(newChecked)
            onCheckedChange?.(newChecked)
          }}
          className="peer h-4 w-4 rounded border border-gray-300 cursor-pointer appearance-none bg-white checked:bg-[var(--brand-primary)] checked:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          {...props}
        />
        <Check
          className={cn(
            'absolute h-3 w-3 text-white pointer-events-none',
            isChecked ? 'opacity-100' : 'opacity-0'
          )}
          strokeWidth={3}
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        />
      </div>
    )
  }
)
Checkbox.displayName = 'Checkbox'

export { Checkbox }
