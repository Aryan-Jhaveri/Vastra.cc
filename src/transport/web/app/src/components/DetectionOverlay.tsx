import { useState, useRef, useEffect } from 'react'
import { X } from 'lucide-react'
import { Sheet } from './ui/Sheet'
import { Button } from './ui/Button'

export interface Detection {
  id: string
  label: string
  category: string
  cropColor: string
  box: { x: number; y: number; w: number; h: number } // % of container
  kept: boolean
  alternatives: string[]
}

interface DetectionOverlayProps {
  detections: Detection[]
  onChange: (detections: Detection[]) => void
  onTapAdd?: (x: number, y: number, scale?: number) => void
  sourcePhotoLabel?: string
  sourcePhotoUri?: string
  aspectRatio?: string
  categories?: string[]
}

// Theme-token-derived pastels — follow the active palette and dark mode,
// unlike the hardcoded hexes these replace.
const CATEGORY_CHIP_COLORS: Record<string, string> = {
  tops: 'color-mix(in srgb, var(--color-accent) 15%, var(--color-paper))',
  bottoms: 'color-mix(in srgb, var(--color-primary-container) 30%, var(--color-paper))',
  shoes: 'color-mix(in srgb, var(--color-secondary-container) 30%, var(--color-paper))',
  outerwear: 'color-mix(in srgb, var(--color-surface-container-highest) 50%, var(--color-paper))',
  accessories: 'color-mix(in srgb, var(--color-outline) 20%, var(--color-paper))',
  dresses: 'color-mix(in srgb, var(--color-success) 15%, var(--color-paper))',
  bags: 'color-mix(in srgb, var(--color-on-surface-variant) 15%, var(--color-paper))',
}

const VIEWPORT_PADDING = 0.15

const ALL_CATEGORIES = ['tops', 'bottoms', 'shoes', 'outerwear', 'accessories', 'dresses', 'bags']

type Handle = 'nw' | 'ne' | 'sw' | 'se'
type DragState =
  | { type: 'move'; id: string; startPx: number; startPy: number; origBox: Detection['box'] }
  | { type: 'resize'; id: string; handle: Handle; startPx: number; startPy: number; origBox: Detection['box'] }
  | { type: 'pan'; startX: number; startY: number; startTx: number; startTy: number }

export interface ViewState { scale: number; tx: number; ty: number }

export function clientToSourcePercent(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  view: ViewState,
): { px: number; py: number } {
  const xInner = (clientX - rect.left - view.tx) / view.scale
  const yInner = (clientY - rect.top - view.ty) / view.scale
  return {
    px: (xInner / rect.width) * 100,
    py: (yInner / rect.height) * 100,
  }
}

export function clampView(v: ViewState, cw: number, ch: number): ViewState {
  const scale = Math.max(1, Math.min(6, v.scale))
  if (scale <= 1.001) return { scale: 1, tx: 0, ty: 0 }
  const minTx = -(scale - 1) * cw
  const minTy = -(scale - 1) * ch
  return {
    scale,
    tx: Math.max(minTx, Math.min(0, v.tx)),
    ty: Math.max(minTy, Math.min(0, v.ty)),
  }
}

function bboxViewportImg(sourcePhotoUri: string | undefined, box: Detection['box'], aspectRatio?: string) {
  if (!sourcePhotoUri) return null
  const { x, y, w, h } = box
  if (w < 1 || h < 1 || w >= 99.9 || h >= 99.9) return null
  let r = 1
  if (aspectRatio) {
    const [W, H] = aspectRatio.split('/').map(Number)
    if (W > 0 && H > 0) r = H / W
  }

  const padW = w * (1 + VIEWPORT_PADDING * 2)
  const padH = h * (1 + VIEWPORT_PADDING * 2)
  const S = Math.min(10000 / padW, 10000 / (padH * r))
  const imgLeft = 50 - (x + w / 2) * S / 100
  const imgTop  = 50 - (y + h / 2) * S * r / 100
  // Contain leaves slack in the card's looser dimension. Without a clip, that
  // slack shows the neighbouring photo (a tight glasses box showed the whole
  // face). Clip the image to the padded box so the slack is plain background
  // instead (#121). Cover would crop the item itself: a wide 40×5 glasses box
  // in a 1:1 card would show only the middle ~16% of the glasses. inset() %
  // is relative to the img box, which spans the whole source photo.
  const clipTop = Math.max(0, y - h * VIEWPORT_PADDING)
  const clipLeft = Math.max(0, x - w * VIEWPORT_PADDING)
  const clipBottom = Math.max(0, 100 - (y + h + h * VIEWPORT_PADDING))
  const clipRight = Math.max(0, 100 - (x + w + w * VIEWPORT_PADDING))

  return (
    <img
      src={sourcePhotoUri}
      alt=""
      data-testid="bbox-viewport-img"
      style={{
        position: 'absolute',
        left: `${imgLeft}%`,
        top: `${imgTop}%`,
        width: `${S}%`,
        height: 'auto',
        maxWidth: 'none',
        pointerEvents: 'none',
        clipPath: `inset(${clipTop}% ${clipRight}% ${clipBottom}% ${clipLeft}%)`,
      }}
    />
  )
}

export function DetectionOverlay({ detections, onChange, onTapAdd, sourcePhotoLabel, sourcePhotoUri, aspectRatio, categories }: DetectionOverlayProps) {
  const effectiveCategories = categories && categories.length > 0 ? categories : ALL_CATEGORIES
  const [sheetOpen, setSheetOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [addMode, setAddMode] = useState(false)
  const [ripple, setRipple] = useState<{ x: number; y: number } | null>(null)
  const [view, setView] = useState<ViewState>({ scale: 1, tx: 0, ty: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const didDragRef = useRef(false)
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  // Pinch/pan gesture handlers manually verified on iOS Safari + Chrome on a touch device.
  // jsdom cannot simulate multi-touch; integration tests for pinch are skipped.
  const pinchRef = useRef<{ initDist: number; initMx: number; initMy: number; initScale: number; initTx: number; initTy: number } | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    setView({ scale: 1, tx: 0, ty: 0 })
  }, [sourcePhotoUri])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = el!.getBoundingClientRect()
      setView(v => {
        const newScale = Math.max(1, Math.min(6, v.scale * Math.exp(-e.deltaY * 0.005)))
        if (newScale <= 1.001) return { scale: 1, tx: 0, ty: 0 }
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const ratio = newScale / v.scale
        const newTx = cx - ratio * (cx - v.tx)
        const newTy = cy - ratio * (cy - v.ty)
        return clampView({ scale: newScale, tx: newTx, ty: newTy }, rect.width, rect.height)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const active = detections.find(d => d.id === activeId)

  function activateCard(id: string) {
    setActiveId(prev => prev === id ? null : id)
  }

  function openChips(id: string) {
    setActiveId(id)
    setSheetOpen(true)
  }

  function selectAlternative(cat: string) {
    if (!activeId) return
    onChange(detections.map(d =>
      d.id === activeId ? { ...d, category: cat, label: cat } : d
    ))
    setSheetOpen(false)
  }

  function toggleKept(id: string) {
    onChange(detections.map(d => d.id === id ? { ...d, kept: !d.kept } : d))
  }

  function removeDetection(id: string) {
    if (activeId === id) setActiveId(null)
    onChange(detections.filter(d => d.id !== id))
  }

  function toPercent(e: React.PointerEvent): { px: number; py: number } {
    const rect = containerRef.current!.getBoundingClientRect()
    return clientToSourcePercent(e.clientX, e.clientY, rect, viewRef.current)
  }

  function startMove(e: React.PointerEvent, det: Detection) {
    if (pointersRef.current.size >= 2) return
    e.stopPropagation()
    didDragRef.current = false
    const { px, py } = toPercent(e)
    dragRef.current = { type: 'move', id: det.id, startPx: px, startPy: py, origBox: { ...det.box } }
  }

  function startResize(e: React.PointerEvent, det: Detection, handle: Handle) {
    if (pointersRef.current.size >= 2) return
    e.stopPropagation()
    didDragRef.current = false
    const { px, py } = toPercent(e)
    dragRef.current = { type: 'resize', id: det.id, handle, startPx: px, startPy: py, origBox: { ...det.box } }
  }

  function onContainerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values())
      const dx = pts[1].x - pts[0].x
      const dy = pts[1].y - pts[0].y
      pinchRef.current = {
        initDist: Math.sqrt(dx * dx + dy * dy),
        initMx: (pts[0].x + pts[1].x) / 2,
        initMy: (pts[0].y + pts[1].y) / 2,
        initScale: viewRef.current.scale,
        initTx: viewRef.current.tx,
        initTy: viewRef.current.ty,
      }
      dragRef.current = null
      return
    }

    if (e.shiftKey && viewRef.current.scale > 1) {
      const target = e.target as HTMLElement
      if (target.closest('[data-box]') || target.closest('[data-badge]')) return
      e.preventDefault()
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, startTx: viewRef.current.tx, startTy: viewRef.current.ty }
    }
  }

  function onContainerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    if (pointersRef.current.size === 2 && pinchRef.current) {
      e.preventDefault()
      const p = pinchRef.current
      const pts = Array.from(pointersRef.current.values())
      const dx = pts[1].x - pts[0].x
      const dy = pts[1].y - pts[0].y
      const newDist = Math.sqrt(dx * dx + dy * dy)
      const newMx = (pts[0].x + pts[1].x) / 2
      const newMy = (pts[0].y + pts[1].y) / 2

      const newScale = Math.max(1, Math.min(6, p.initScale * (newDist / p.initDist)))
      const newTx = p.initTx + (newMx - p.initMx)
      const newTy = p.initTy + (newMy - p.initMy)
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setView(clampView({ scale: newScale, tx: newTx, ty: newTy }, rect.width, rect.height))
      }
      return
    }

    const drag = dragRef.current
    if (!drag) return

    if (drag.type === 'pan') {
      e.preventDefault()
      didDragRef.current = true
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setView(clampView({ scale: viewRef.current.scale, tx: drag.startTx + dx, ty: drag.startTy + dy }, rect.width, rect.height))
      }
      return
    }

    e.preventDefault()
    didDragRef.current = true
    const { px, py } = toPercent(e)

    if (drag.type === 'move') {
      const dx = px - drag.startPx
      const dy = py - drag.startPy
      const ob = drag.origBox
      const newX = Math.max(0, Math.min(100 - ob.w, ob.x + dx))
      const newY = Math.max(0, Math.min(100 - ob.h, ob.y + dy))
      onChange(detections.map(d =>
        d.id === drag.id ? { ...d, box: { ...ob, x: newX, y: newY } } : d
      ))
    } else {
      let { x, y, w, h } = drag.origBox
      const { handle } = drag
      const MIN = 5

      if (handle === 'se') {
        w = Math.max(MIN, Math.min(100 - x, px - x))
        h = Math.max(MIN, Math.min(100 - y, py - y))
      } else if (handle === 'sw') {
        const newX = Math.max(0, Math.min(x + w - MIN, px))
        w = x + w - newX; x = newX
        h = Math.max(MIN, Math.min(100 - y, py - y))
      } else if (handle === 'ne') {
        w = Math.max(MIN, Math.min(100 - x, px - x))
        const newY = Math.max(0, Math.min(y + h - MIN, py))
        h = y + h - newY; y = newY
      } else { // nw
        const newX = Math.max(0, Math.min(x + w - MIN, px))
        w = x + w - newX; x = newX
        const newY = Math.max(0, Math.min(y + h - MIN, py))
        h = y + h - newY; y = newY
      }

      onChange(detections.map(d =>
        d.id === drag.id ? { ...d, box: { x, y, w, h } } : d
      ))
    }
  }

  function onContainerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) {
      pinchRef.current = null
    }
    if (pointersRef.current.size === 0) {
      dragRef.current = null
    }
  }

  function handlePhotoClick(e: React.MouseEvent<HTMLDivElement>) {
    if (didDragRef.current) { didDragRef.current = false; return }
    const target = e.target as HTMLElement
    if (target.closest('[data-badge]') || target.closest('[data-box]')) return

    const rect = containerRef.current!.getBoundingClientRect()
    const { px: x, py: y } = clientToSourcePercent(e.clientX, e.clientY, rect, viewRef.current)

    if (addMode) {
      setRipple({ x, y })
      setTimeout(() => setRipple(null), 700)
      onTapAdd?.(x, y, view.scale)
      setAddMode(false)
    } else {
      setActiveId(null)
    }
  }

  return (
    <div className="flex flex-col gap-0 h-full min-h-0">
      {/* Source photo with overlays */}
      <div
        ref={containerRef}
        data-testid="bbox-photo"
        className="relative overflow-hidden border-2 border-ink select-none mx-auto flex-1 min-h-0 max-w-full rounded-base"
        style={{ aspectRatio: aspectRatio ?? '3/4', background: '#e8e4df', touchAction: 'none' }}
        onPointerDownCapture={onContainerPointerDown}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
        onPointerLeave={onContainerPointerUp}
        onClick={handlePhotoClick}
      >
        <div
          style={{
            transform: `translate(${view.tx}px,${view.ty}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            width: '100%',
            height: '100%',
          }}
        >
        {/* Photo background */}
        {sourcePhotoUri ? (
          <img
            src={sourcePhotoUri}
            alt="uploaded outfit"
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
            <div className="text-[32px] opacity-20">👤</div>
            {sourcePhotoLabel && (
              <span className="text-[14px] font-mono uppercase tracking-widest text-ink/30">
                {sourcePhotoLabel}
              </span>
            )}
          </div>
        )}

        {/* Detection boxes */}
        {detections.map(det => {
          const isActive = det.id === activeId
          return (
            <div
              key={det.id}
              data-box
              className="absolute"
              style={{
                left: `${det.box.x}%`,
                top: `${det.box.y}%`,
                width: `${det.box.w}%`,
                height: `${det.box.h}%`,
                cursor: isActive ? 'move' : 'pointer',
              }}
              onClick={(e) => {
                e.stopPropagation()
                setActiveId(det.id)
              }}
              onPointerDown={(e) => {
                if (!isActive) return
                const target = e.target as HTMLElement
                if (target.closest('[data-badge]')) return
                startMove(e, det)
              }}
            >
              {/* Tint fill — active only, theme accent (cropColor may be a stale pastel from the backend) */}
              {isActive && (
                <div
                  className="absolute inset-0 opacity-20"
                  style={{ background: 'var(--color-accent)' }}
                />
              )}
              {/* Border */}
              <div
                className={`absolute inset-0 border-2 ${isActive ? 'border-ink' : 'border-outline-variant'}`}
              />

              {/* Active-only overlays: resize handles */}
              {isActive && (
                <>
                  {(['nw', 'ne', 'sw', 'se'] as Handle[]).map(handle => (
                    <div
                      key={handle}
                      data-badge
                      className={`absolute w-3 h-3 bg-paper border-2 border-accent z-10 ${
                        handle === 'nw' ? '-top-1.5 -left-1.5 cursor-nw-resize' :
                        handle === 'ne' ? '-top-1.5 -right-1.5 cursor-ne-resize' :
                        handle === 'sw' ? '-bottom-1.5 -left-1.5 cursor-sw-resize' :
                        '-bottom-1.5 -right-1.5 cursor-se-resize'
                      }`}
                      style={{ transform: `scale(${1/view.scale})` }}
                      onPointerDown={(e) => { e.stopPropagation(); startResize(e, det, handle) }}
                    />
                  ))}
                </>
              )}
            </div>
          )
        })}

        {/* Click ripple */}
        {ripple && (
          <div
            className="absolute pointer-events-none"
            style={{ left: `${ripple.x}%`, top: `${ripple.y}%`, transform: 'translate(-50%,-50%)' }}
          >
            <div className="w-8 h-8 border-2 border-ink bg-paper/80 flex items-center justify-center text-[14px] font-bold"
              style={{ animation: 'ripple-fade 0.7s ease-out forwards' }}>
              +
            </div>
          </div>
        )}

        {/* Add-mode hint */}
        {addMode && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <span data-testid="add-hint" className="text-[14px] font-mono uppercase tracking-widest bg-paper text-ink border-2 border-ink rounded-base shadow-flat-xs px-3 py-1.5">
              tap photo to add a box
            </span>
          </div>
        )}
        </div>

        {/* Zoom controls */}
        <div className="absolute top-2 right-2 flex gap-1 z-20">
          <button
            data-testid="zoom-in"
            onClick={(e) => {
              e.stopPropagation()
              const rect = containerRef.current!.getBoundingClientRect()
              setView(v => clampView({ scale: v.scale + 0.5, tx: v.tx, ty: v.ty }, rect.width, rect.height))
            }}
            className="w-11 h-11 md:w-7 md:h-7 flex items-center justify-center bg-paper text-ink border-2 border-ink rounded-base shadow-flat-xs text-[14px] font-mono font-bold active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors]"
          >
            +
          </button>
          <button
            data-testid="zoom-out"
            onClick={(e) => {
              e.stopPropagation()
              const rect = containerRef.current!.getBoundingClientRect()
              setView(v => clampView({ scale: v.scale - 0.5, tx: v.tx, ty: v.ty }, rect.width, rect.height))
            }}
            className="w-11 h-11 md:w-7 md:h-7 flex items-center justify-center bg-paper text-ink border-2 border-ink rounded-base shadow-flat-xs text-[14px] font-mono font-bold active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors]"
          >
            {'\u2212'}
          </button>
          <button
            data-testid="zoom-fit"
            onClick={(e) => {
              e.stopPropagation()
              setView({ scale: 1, tx: 0, ty: 0 })
            }}
            className="w-11 h-11 md:w-7 md:h-7 flex items-center justify-center bg-paper text-ink border-2 border-ink rounded-base shadow-flat-xs text-[12px] font-mono active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors]"
          >
            fit
          </button>
        </div>
      </div>

      {/* Hint line */}
      <div className="px-3 py-2 border-x-2 border-ink bg-surface-dim">
        <p className="text-[14px] font-mono text-muted uppercase tracking-widest">
          tap card to select · tap title to fix · drag active box · drag corner to resize · + to add
        </p>
      </div>

      {/* Thumbnail strip */}
      <div className="border-2 border-t-0 border-ink bg-paper p-3 rounded-base">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {detections.map(det => {
            const isActive = det.id === activeId
            return (
              <div
                  key={det.id}
                  data-testid={`card-${det.id}`}
                  className={`relative flex-none rounded-base border-2 transition-all ${
                    isActive ? 'border-ink' : det.kept ? 'border-outline' : 'border-outline-variant opacity-40'
                  }`}
                >
                <button
                  onClick={() => activateCard(det.id)}
                  aria-label="select"
                  className="w-16 block"
                >
                  <div
                    className="w-full"
                    style={{ position: 'relative', aspectRatio: '1/1', overflow: 'hidden', background: '#e8e4df' }}
                  >
                    {bboxViewportImg(sourcePhotoUri, det.box, aspectRatio)}
                  </div>
                </button>
                <button
                  onClick={() => openChips(det.id)}
                  aria-label="change category"
                  className="w-16 px-1 py-0.5 bg-paper border-t border-outline-variant block"
                >
                  <p className="text-[14px] font-mono uppercase tracking-wide text-ink truncate">
                    {det.category}
                  </p>
                </button>
                {/* Kept toggle — bottom right of card, outside card button to avoid DOM nesting */}
                <button
                  data-badge
                  onClick={(e) => { e.stopPropagation(); toggleKept(det.id) }}
                  className={`absolute bottom-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-[12px] font-bold z-10 ${
                    det.kept ? 'bg-ink text-accent-on' : 'bg-muted/50 text-muted'
                  }`}
                >
                  {det.kept ? '✓' : '–'}
                </button>
                {/* Delete — top left of card wrapper, ≥24×24 hit area */}
                <button
                  data-badge
                  onClick={(e) => { e.stopPropagation(); removeDetection(det.id) }}
                  title="Remove"
                  className="absolute -top-1.5 -left-1.5 w-6 h-6 flex items-center justify-center text-muted hover:text-ink transition-colors z-10"
                >
                  <X className="w-3 h-3" strokeWidth={2.5} />
                </button>
              </div>
            )
          })}

          {/* Add placeholder */}
          <button
            data-testid="add-tile"
            onClick={() => setAddMode(m => !m)}
            className={`flex-none w-16 border-2 border-dashed flex items-center justify-center transition-colors rounded-base ${
              addMode ? 'border-ink opacity-100 bg-accent/10' : 'border-outline-variant opacity-50'
            }`}
            style={{ aspectRatio: '1/1' }}
          >
            <span className="text-[16px] text-muted">{addMode ? 'tap photo' : '+'}</span>
          </button>
        </div>
      </div>

      {/* Guided chips sheet */}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="looks more like" peekHeight="60vh">
        <div className="p-4 flex flex-col gap-4">
          {active && (
            <>
              <div className="flex items-center gap-3">
                <div
                  className="w-12 h-12 border-2 border-ink flex-none"
                  style={{ background: CATEGORY_CHIP_COLORS[active.category] ?? 'var(--color-surface-container)' }}
                />
                <div>
                  <p className="text-[14px] font-mono uppercase tracking-widest text-muted">currently tagged as</p>
                  <p className="text-[15px] font-bold font-mono uppercase">{active.category}</p>
                </div>
              </div>

              <div>
                <p className="text-[14px] font-mono uppercase tracking-widest text-muted mb-2">change to</p>
                <div className="flex flex-wrap gap-2">
                  {effectiveCategories.filter(c => c !== active.category).map(alt => (
                    <button
                      key={alt}
                      onClick={() => selectAlternative(alt)}
                      className="px-3 py-1.5 border-2 border-ink text-[14px] font-bold font-mono uppercase tracking-wide hover:bg-ink hover:text-paper transition-colors rounded-base"
                      style={{ background: CATEGORY_CHIP_COLORS[alt] ?? 'transparent' }}
                    >
                      {alt}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[14px] font-mono uppercase tracking-widest text-muted mb-1.5">or type it</p>
                <input
                  className="w-full border-2 border-ink px-3 py-2 text-[14px] font-mono"
                  placeholder="e.g. blazer, hoodie, cargo pants..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                      selectAlternative(e.currentTarget.value.trim().toLowerCase())
                    }
                  }}
                />
              </div>
            </>
          )}
        </div>
        <div className="px-4 pb-4">
          <Button className="w-full" onClick={() => setSheetOpen(false)}>
            confirm
          </Button>
        </div>
      </Sheet>

      <style>{`
        @keyframes ripple-fade {
          0% { opacity: 1; transform: scale(0.5); }
          100% { opacity: 0; transform: scale(2); }
        }
      `}</style>
    </div>
  )
}
