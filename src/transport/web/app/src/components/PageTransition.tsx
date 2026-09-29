import { type ReactNode, useLayoutEffect, useRef } from 'react'

interface PageTransitionProps {
  children: ReactNode
}

export function PageTransition({ children }: PageTransitionProps) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    el.style.opacity = '0'
    const anim = el.animate(
      [
        { opacity: '0', transform: 'translateY(20px) scale(0.97)' },
        { opacity: '1', transform: 'translateY(0) scale(1)' },
      ],
      { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' },
    )
    anim.finished.then(() => {
      el.style.opacity = '1'
      el.style.transform = ''
      // Cancel the WAAPI effect so transform: scale(1) stops applying.
      // Otherwise this element becomes the containing block for any descendant
      // position:fixed modal, clamping it to this wrapper's width.
      anim.cancel()
    }).catch(() => {})
  }, [])

  return <div ref={ref}>{children}</div>
}
