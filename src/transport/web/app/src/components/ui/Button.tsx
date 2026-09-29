import { type ButtonHTMLAttributes } from 'react'
import { Spinner } from './Spinner'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  loading?: boolean
}

const variantClass: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:   'bg-accent text-accent-on border-2 border-ink shadow-flat-xs hover:opacity-90 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40',
  secondary: 'bg-paper text-ink border-2 border-ink shadow-flat-xs hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40',
  ghost:     'text-muted hover:text-ink disabled:opacity-40',
  danger:    'bg-error text-on-error border-2 border-error shadow-[2px_2px_0px_0px_var(--color-error)] hover:opacity-80 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40',
}

export function Button({ variant = 'primary', loading, children, className = '', ...props }: ButtonProps) {
  return (
    <button
      {...props}
      disabled={loading || props.disabled}
      // min-h-[44px] satisfies WCAG 2.5.5 target-size (44×44 CSS px)
      className={`inline-flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-[14px] font-bold font-sans uppercase tracking-[0.04em] rounded-base transition-[transform,box-shadow,opacity,background-color] duration-75 ${variantClass[variant]} ${className}`}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  )
}
