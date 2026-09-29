import type { ReactNode, HTMLAttributes } from 'react'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export function Card({ children, className = '', ...props }: CardProps) {
  return (
    <div {...props} className={`bg-paper border-2 border-ink shadow-flat-xs rounded-base ${className}`}>
      {children}
    </div>
  )
}
