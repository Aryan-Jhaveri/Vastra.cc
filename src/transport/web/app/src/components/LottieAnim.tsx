import { useState, useEffect, useRef, useCallback } from 'react'
import Lottie, { type LottieRefCurrentProps } from 'lottie-react'
import { Spinner } from './ui/Spinner'

interface LottieAnimProps {
  src: string
  className?: string
  loop?: boolean
  autoplay?: boolean
  hoverToPlay?: boolean
  onComplete?: () => void
  animationData?: unknown
}

export function LottieAnim({
  src,
  className,
  loop = true,
  autoplay = true,
  hoverToPlay,
  onComplete,
  animationData: preloadedData,
}: LottieAnimProps) {
  const [animationData, setAnimationData] = useState<unknown>(preloadedData ?? null)
  const [loading, setLoading] = useState(!preloadedData)
  const [hasError, setHasError] = useState(false)
  const lottieRef = useRef<LottieRefCurrentProps | null>(null)
  const prefersReducedMotion = useRef(false)

  useEffect(() => {
    prefersReducedMotion.current = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
  }, [])

  useEffect(() => {
    if (!src) return
    if (preloadedData) return
    let live = true

    setLoading(true)
    setHasError(false)

    fetch(src)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json) => {
        if (live) { setAnimationData(json); setLoading(false) }
      })
      .catch(() => { if (live) { setLoading(false); setHasError(true) } })

    return () => { live = false }
  }, [src, preloadedData])

  useEffect(() => {
    if (preloadedData) setAnimationData(preloadedData)
  }, [preloadedData])

  const handleMouseEnter = useCallback(() => {
    if (hoverToPlay) lottieRef.current?.play()
  }, [hoverToPlay])

  const handleMouseLeave = useCallback(() => {
    if (hoverToPlay) lottieRef.current?.pause()
  }, [hoverToPlay])

  if (loading) {
    return (
      <div
        className={`flex items-center justify-center bg-surface-dim ${className ?? ''}`}
      >
        <Spinner size={20} />
      </div>
    )
  }

  if (hasError || !animationData) {
    return (
      <div className={`flex items-center justify-center bg-surface-dim ${className ?? ''}`}>
        <span className="text-[11px] font-mono text-muted">animation failed</span>
      </div>
    )
  }

  const frozen = prefersReducedMotion.current

  return (
    <div
      className={`relative overflow-hidden ${className ?? ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Lottie
        lottieRef={lottieRef}
        animationData={animationData}
        loop={frozen ? false : loop}
        autoplay={frozen ? false : autoplay}
        renderer="svg"
        style={{ width: '100%', height: '100%' }}
        onComplete={onComplete}
      />
    </div>
  )
}
