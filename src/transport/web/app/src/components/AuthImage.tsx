import { useState, useEffect, useRef } from 'react'
import { Spinner } from './ui/Spinner'
import { ImageOff } from 'lucide-react'
import { useInView } from '../hooks/useInView'

interface AuthImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string
  lazy?: boolean
  fillBackground?: boolean
}

export function AuthImage({ src, className, lazy, fillBackground, ...props }: AuthImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | undefined>()
  const [loaded, setLoaded] = useState(false)
  const [hasError, setHasError] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const { ref: wrapperRef, inView } = useInView({ rootMargin: '200px', triggerOnce: true })

  useEffect(() => {
    if (imgRef.current?.complete && !hasError) setLoaded(true)
  }, [objectUrl, hasError])

  useEffect(() => {
    if (!src) return
    if (lazy && !inView) return

    let live = true
    let created: string | undefined

    setLoaded(false)
    setHasError(false)

    // Cookie-only auth: the httpOnly `closet-auth` cookie rides this same-origin
    // fetch automatically — no Authorization header, no stored token (#295).
    fetch(src)
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => {
        if (!live) return
        created = URL.createObjectURL(blob)
        setObjectUrl(created)
      })
      .catch(() => { if (live) { setLoaded(true); setHasError(true) } })

    return () => {
      live = false
      if (created) URL.revokeObjectURL(created)
      setObjectUrl(undefined)
    }
  }, [src, inView, lazy])

  useEffect(() => {
    if (!fillBackground || !objectUrl) return
    const img = new Image()
    let live = true
    img.onload = () => {
      if (!live) return
      const canvas = document.createElement('canvas')
      canvas.width = 8
      canvas.height = 8
      const ctx = canvas.getContext('2d')
      if (!ctx || !wrapperRef.current) return
      ctx.drawImage(img, 0, 0, 8, 8)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      wrapperRef.current.style.background = `rgb(${r},${g},${b})`
    }
    img.src = objectUrl
    return () => { live = false }
  }, [objectUrl, fillBackground])

  return (
    <div ref={wrapperRef} className={`relative ${className ?? ''}`}>
      {!loaded && !hasError && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-dim z-10">
          <Spinner size={20} />
        </div>
      )}
      {hasError && (
        <div className="absolute inset-0 bg-surface-dim z-10 flex items-end justify-end">
          <div className="flex items-center gap-1 bg-paper border-2 border-ink rounded-base px-1.5 py-0.5 m-1 text-[11px] font-mono text-muted">
            <ImageOff className="w-3 h-3" strokeWidth={2} />
            <span>missing file</span>
          </div>
        </div>
      )}
      <img
        ref={imgRef}
        {...props}
        src={objectUrl}
        data-src={src}
        className={`${className ?? ''} transition-opacity duration-300 ${loaded && !hasError ? 'opacity-100' : 'opacity-0'}`}
        onLoad={() => setLoaded(true)}
        onError={() => { setLoaded(true); setHasError(true) }}
      />
    </div>
  )
}
