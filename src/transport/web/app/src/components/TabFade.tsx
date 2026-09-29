import { type ReactNode, useEffect, useRef } from 'react'

interface TabFadeProps {
  children: ReactNode
  className?: string
}

export function TabFade({ children, className }: TabFadeProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.animate(
      [{ opacity: '0', transform: 'translateY(4px)' }, { opacity: '1', transform: 'translateY(0)' }],
      { duration: 150, easing: 'ease-out', fill: 'backwards' },
    )
  }, [])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
