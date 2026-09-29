import { useEffect, useRef, useState } from 'react'

interface UseInViewOptions {
  rootMargin?: string
  triggerOnce?: boolean
}

export function useInView(options: UseInViewOptions = {}) {
  const { rootMargin = '200px', triggerOnce = true } = options
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        const intersecting = entry.isIntersecting
        setInView(intersecting)
        if (intersecting && triggerOnce) observer.disconnect()
      },
      { rootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin, triggerOnce])

  return { ref, inView }
}
