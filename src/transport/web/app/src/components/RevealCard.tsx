import { type ReactNode } from 'react'
import { useInView } from '../hooks/useInView'

interface RevealCardProps {
  children: ReactNode
  className?: string
}

export function RevealCard({ children, className }: RevealCardProps) {
  const { ref, inView } = useInView({ rootMargin: '200px', triggerOnce: true })

  return (
    <div
      ref={ref}
      className={`reveal-card ${inView ? 'reveal-card--visible' : ''} ${className ?? ''}`}
    >
      {children}
    </div>
  )
}
