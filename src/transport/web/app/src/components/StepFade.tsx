import { type ReactNode, useEffect, useRef } from 'react'

interface StepFadeProps {
  children: ReactNode
}

export function StepFade({ children }: StepFadeProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.animate(
      [
        { opacity: '0', transform: 'translateY(12px)' },
        { opacity: '1', transform: 'translateY(0)' },
      ],
      { duration: 250, easing: 'ease-out', fill: 'backwards' },
    )
  }, [])

  return <div ref={ref}>{children}</div>
}
