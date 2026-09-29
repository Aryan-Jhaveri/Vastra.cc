import { useState, useEffect, useRef } from 'react'

export function useDelayedLoading(isLoading: boolean, showAfter = 180, minVisible = 400) {
  const [show, setShow] = useState(false)
  const startRef = useRef<number>(0)
  const firedRef = useRef(false)

  useEffect(() => {
    if (isLoading && !firedRef.current) {
      const timer = setTimeout(() => {
        startRef.current = Date.now()
        firedRef.current = true
        setShow(true)
      }, showAfter)
      return () => clearTimeout(timer)
    }
    if (!isLoading) {
      firedRef.current = false
    }
  }, [isLoading, showAfter])

  useEffect(() => {
    if (!isLoading && show) {
      const elapsed = Date.now() - startRef.current
      const remaining = Math.max(0, minVisible - elapsed)
      const timer = setTimeout(() => setShow(false), remaining)
      return () => clearTimeout(timer)
    }
  }, [isLoading, show, minVisible])

  return show
}
