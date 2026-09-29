import { useEffect, useRef, type ReactNode } from 'react'

interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /** Action row pinned to the bottom of the sheet; stays visible while content scrolls. */
  actions?: ReactNode
  peekHeight?: string
  /** Hide the close button. Use when a step is non-dismissable (e.g. mid-generation). */
  closable?: boolean
}

export function Sheet({ open, onClose, title, children, actions, peekHeight = '50vh', closable = true }: SheetProps) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const prevBody = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    backdropRef.current?.animate([{ opacity: '0' }, { opacity: '1' }], { duration: 200, fill: 'backwards' })
    panelRef.current?.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 250, easing: 'ease-out', fill: 'backwards' })
    return () => {
      document.body.style.overflow = prevBody
    }
  }, [open])

  if (!open) return null

  return (
    // stopPropagation: when Sheet is rendered inside another modal (e.g. ItemDetail)
    // we don't want sheet-internal clicks to dismiss the parent modal.
    <div className="fixed inset-0 nav-anchor-right z-[60] flex flex-col justify-end" onClick={e => e.stopPropagation()}>
      <div
        ref={backdropRef}
        className="absolute inset-0 bg-black/40"
        onClick={closable ? onClose : undefined}
      />
      <div
        ref={panelRef}
        className="relative bg-paper border-t-2 border-ink w-full max-w-lg mx-auto flex flex-col"
        style={{ minHeight: peekHeight, maxHeight: '90vh' }}
      >
        <div className="flex-none flex items-center justify-between px-4 pt-4 pb-2 border-b-2 border-ink">
          {title && (
            <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-ink">
              {title}
            </span>
          )}
          {closable && (
            <button
              onClick={onClose}
              className="ml-auto text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-muted hover:text-ink"
            >
              close
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {children}
        </div>
        {actions && (
          <div data-testid="sheet-actions" className="flex-none border-t-2 border-ink bg-paper">
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}
