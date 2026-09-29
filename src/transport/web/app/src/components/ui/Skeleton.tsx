import { type CSSProperties, type ReactNode } from 'react'

interface SkeletonProps {
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

export function Skeleton({ className = '', style, children }: SkeletonProps) {
  return (
    <div style={style} className={`animate-skeleton-pulse bg-surface-dim rounded-base ${className}`}>
      {children}
    </div>
  )
}

/** Grid of skeleton cards matching the 3-column item grid */
export function SkeletonItemGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 gap-[3px]">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="aspect-[4/5]" />
      ))}
    </div>
  )
}

/** Skeleton cards matching the outfits list layout */
export function SkeletonOutfitList({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-[3px]">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="aspect-[4/5]" />
      ))}
    </div>
  )
}

/** Skeleton for a large photo area */
export function SkeletonPhoto() {
  return <Skeleton className="w-full aspect-[3/4]" />
}

/** Skeleton for text lines */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-4"
          style={{ width: `${i === lines - 1 ? 60 : 85 + Math.random() * 15}%` }}
        />
      ))}
    </div>
  )
}
