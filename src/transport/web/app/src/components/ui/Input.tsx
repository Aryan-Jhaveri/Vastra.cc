import type { InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export function Input({ label, error, className = '', id, ...props }: InputProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-')
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted">
          {label}
        </label>
      )}
      <input
        id={inputId}
        {...props}
        className={`border-2 border-ink px-3 py-2 text-sm outline-none focus:bg-surface-dim bg-paper text-ink ${error ? 'border-error' : ''} ${className}`}
      />
      {error && <p className="text-[14px] font-mono text-error">{error}</p>}
    </div>
  )
}
