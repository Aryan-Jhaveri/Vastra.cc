import type { ReactNode } from 'react'

interface BadgeProps {
  children: ReactNode
  color?: string
  className?: string
}

export function Badge({ children, color, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
      style={color ? { backgroundColor: color + '22', color: color } : undefined}
    >
      {children}
    </span>
  )
}
