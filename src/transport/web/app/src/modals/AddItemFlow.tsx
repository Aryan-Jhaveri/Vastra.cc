import { useState, useRef, useEffect, type DragEvent, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router'
import { Camera, Search, Pencil, ArrowLeftRight, ArrowLeft, ChevronLeft, ChevronRight, X, Sparkles, AlertCircle } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { Sheet } from '../components/ui/Sheet'
import { Spinner } from '../components/ui/Spinner'
import { DetectionOverlay, type Detection } from '../components/DetectionOverlay'
import { analyzeItem, createItem, deleteItem, fetchItemMeta, type ItemClassification } from '../api/items'
import { cropDetectedBox, detectBulkItems, stageSourcePhoto } from '../api/bulkItems'
import { fetchTokenBalance } from '../hosted'
import { useBillingEnabled } from '../hooks/useBillingEnabled'
import { cropToBbox } from '../lib/cropToBbox'
import { limitConcurrency, type Limiter } from '../lib/limitConcurrency'
import { createRateLimitGate, withRateLimitRetry, type RateLimitGate } from '../lib/rateLimitRetry'
import { makePhotoThumbnail } from '../lib/photoThumbnail'
import { usePasteImage } from '../lib/usePasteImage'
import { track } from '../lib/analytics'
import { AddRelatedViewsStep, type ExtrasItem } from './AddRelatedViewsStep'
import { normalizeColor } from '../lib/normalizeColor'

// ── Types ──────────────────────────────────────────────────────────────────

interface PhotoEntry {
  file: File
  /** blob: URL of the full photo — rendered only in the box editor. */
  preview: string
  /** Downscaled blob: URL for tiles; equals `preview` when a thumbnail can't be made. */
  thumb: string
  aspectRatio: string | null
  detections: Detection[] | null
  /** The server's copy of this photo (from bulk-detect); boxes are cropped from it. */
  sourceUri?: string | null
  detectError: string | null
  /** A single-photo detect (retry) is in flight. */
  detecting: boolean
}

export interface ReviewItem {
  id: string
  photoIdx: number
  box: Detection['box']
  category: string
  cropColor: string
  croppedFile: File | null
  croppedPreview: string | null
  classification: ItemClassification | null
  classifying: boolean
  classifyError: boolean
  decision: 'pending' | 'saving' | 'saved' | 'skipped' | 'failed'
  /** Idempotency key for POST /api/items: a retry of this item reuses it (#347). */
  saveKey: string
  createdItemId: string | null
  createdImageUri: string | null
  editCategory: string
  editSubcategory: string
  editColors: string[]
  editBrand: string
  editSize: string
  editSeason: string
  editDescription: string
}

type FlowStep = 'upload' | 'detecting' | 'bbox' | 'review' | 'extras' | 'done'

export interface AddItemFlowProps {
  mode: 'closet-add' | 'onboarding'
  onClose: () => void
  /** Fires once on reaching the done step. `itemIds` are the items this flow
   *  created and kept (skipped-after-save items are excluded). */
  onSaved: (count: number, itemIds: string[]) => void
  onBack?: () => void
}

// Theme-token-derived pastels — follow the active palette and dark mode,
// unlike the hardcoded hexes these replace.
const CROP_COLORS = [
  'color-mix(in srgb, var(--color-accent) 15%, var(--color-paper))',
  'color-mix(in srgb, var(--color-primary-container) 30%, var(--color-paper))',
  'color-mix(in srgb, var(--color-secondary-container) 30%, var(--color-paper))',
  'color-mix(in srgb, var(--color-success) 15%, var(--color-paper))',
  'color-mix(in srgb, var(--color-surface-container-highest) 50%, var(--color-paper))',
  'color-mix(in srgb, var(--color-outline) 20%, var(--color-paper))',
  'color-mix(in srgb, var(--color-on-surface-variant) 15%, var(--color-paper))',
  'color-mix(in srgb, var(--color-active) 15%, var(--color-paper))',
]

// In-flight caps for the bulk passes. Detection uploads the full photo, so
// keep it to two at a time; crop → classify decodes the source photo per box.
const DETECT_CONCURRENCY = 2
const CROP_CLASSIFY_CONCURRENCY = 3
// Thumbnails decode each photo at full size once; two at a time bounds that.
const THUMBNAIL_CONCURRENCY = 2

// Product cap on one batch, not a technical limit. Nothing in the pipeline
// breaks past it (uploads are one photo per request, queues are bounded and
// pace under the 30 calls/min per-user AI budget shared by detect and
// classify), but 10 photos × ~5 boxes already fills that budget for a couple
// of minutes, the batch lives only in this tab, and every photo leaves a
// staged source image on disk. More photos → another batch.
export const MAX_BATCH_PHOTOS = 10

// Above this many photos / items, the nav dots stop fitting a phone row and
// turn into a plain "n / total" counter.
const MAX_NAV_DOTS = 12

const STEP_ORDER: Record<FlowStep, number> = {
  upload: 0, detecting: 1, bbox: 1, review: 2, extras: 2, done: 3,
}

// ── Swipe card helpers ─────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

// ── Swipe card ─────────────────────────────────────────────────────────────

interface SwipeCardProps {
  item: ReviewItem
  showHint: boolean
  onDismissHint: () => void
  onSave: () => void
  onSkip: () => void
  onUpdateItem: (updates: Partial<ReviewItem>) => void
  /** Re-run crop → classify for this item after it failed. */
  onRetryClassify?: () => void
}

// Distance OR velocity past these thresholds commits the swipe — same model
// as Tinder/Bumble. The state machine prevents the half-released or
// direction-flipped gestures users reported, and `velocity` lets a quick
// flick commit even at small drag distances.
const COMMIT_DISTANCE = 100
const COMMIT_VELOCITY = 0.55  // px / ms
const FLY_DISTANCE = 600
const FLY_DURATION = 220

type GestureState = 'idle' | 'tracking' | 'committing'

function SwipeCard({ item, showHint, onDismissHint, onSave, onSkip, onUpdateItem, onRetryClassify }: SwipeCardProps) {
  const [translateX, setTranslateX] = useState(0)
  const [gesture, setGesture] = useState<GestureState>('idle')
  const [editOpen, setEditOpen] = useState(false)

  // Refs — written during pointer events, read at decide-time. Never trigger
  // a render on their own, so we don't fight React batching mid-gesture.
  const startRef = useRef({ x: 0, t: 0 })
  const lastRef = useRef({ x: 0, t: 0 })
  const velocityRef = useRef(0)
  const movedRef = useRef(false)
  const committedRef = useRef<null | 'left' | 'right'>(null)

  // Crop still in flight — block interaction so user can't mass-skip placeholders
  const notReady = item.croppedFile === null && item.classifying
  // Block during in-flight save or while a fly-out animation is playing
  const interactionLocked = item.decision === 'saving' || gesture === 'committing'

  // Visual feedback (computed from current translate, not stale state)
  const greenOpacity = Math.min(1, Math.max(0, translateX / 80))
  const redOpacity = Math.min(1, Math.max(0, -translateX / 80))
  const tilt = Math.min(12, Math.abs(translateX) / 20) * Math.sign(translateX)

  function resetGesture() {
    startRef.current = { x: 0, t: 0 }
    lastRef.current = { x: 0, t: 0 }
    velocityRef.current = 0
    movedRef.current = false
    committedRef.current = null
  }

  function onPointerDown(e: React.PointerEvent) {
    // Dismiss the swipe hint on any touch — even taps that don't end up
    // triggering a swipe.
    if (showHint) onDismissHint()
    if (editOpen || interactionLocked || notReady) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    resetGesture()
    const now = e.timeStamp
    startRef.current = { x: e.clientX, t: now }
    lastRef.current = { x: e.clientX, t: now }
    setGesture('tracking')
    // Force any lingering offset to clear before tracking, so the next
    // pointermove computes dx from the actual fingerdown point.
    setTranslateX(0)
  }

  function onPointerMove(e: React.PointerEvent) {
    if (gesture !== 'tracking') return
    const dx = e.clientX - startRef.current.x
    if (Math.abs(dx) > 5) movedRef.current = true
    const dt = Math.max(1, e.timeStamp - lastRef.current.t)
    velocityRef.current = (e.clientX - lastRef.current.x) / dt
    lastRef.current = { x: e.clientX, t: e.timeStamp }
    setTranslateX(dx)
  }

  function commit(direction: 'left' | 'right') {
    if (committedRef.current) return
    committedRef.current = direction
    setGesture('committing')
    setTranslateX(direction === 'right' ? FLY_DISTANCE : -FLY_DISTANCE)
    window.setTimeout(() => {
      setGesture('idle')
      setTranslateX(0)
      resetGesture()
      if (direction === 'right') onSave(); else onSkip()
    }, FLY_DURATION)
  }

  function onPointerUp() {
    if (gesture !== 'tracking') return
    if (!movedRef.current) {
      // Treat as a tap — reset cleanly without committing
      setGesture('idle')
      setTranslateX(0)
      resetGesture()
      return
    }
    const dist = translateX
    const vel = velocityRef.current
    const commitRight = dist > COMMIT_DISTANCE || vel > COMMIT_VELOCITY
    const commitLeft = dist < -COMMIT_DISTANCE || vel < -COMMIT_VELOCITY
    if (commitRight) { commit('right'); return }
    if (commitLeft) { commit('left'); return }
    // Spring back
    setGesture('idle')
    setTranslateX(0)
    resetGesture()
  }

  const isTransitioning = gesture !== 'tracking'

  // Pre-compute display values with fallbacks so we always show something
  const cls = item.classification
  const displayCategory = item.editCategory || item.category
  const displaySubcategory = item.editSubcategory || cls?.subcategory || ''
  const rawColors = cls?.colors
  const displayColors: string[] = Array.isArray(rawColors) && rawColors.length
    ? rawColors
    : item.editColors.length ? item.editColors : []
  const rawSeason = cls?.season
  const displaySeasons: string[] = Array.isArray(rawSeason) && rawSeason.length
    ? rawSeason
    : typeof rawSeason === 'string' && rawSeason
      ? [rawSeason as string]
      : item.editSeason ? [item.editSeason] : []
  const displayTags: string[] = Array.isArray(cls?.suggested_tags) ? cls!.suggested_tags.slice(0, 8) : []

  return (
    <div className="flex flex-col flex-1 min-h-0 select-none relative">
      {/* Swipeable card */}
      <div className="flex-1 px-4 pb-2 min-h-0">
        <div
          className="h-full border-2 border-ink flex flex-col relative overflow-hidden cursor-grab active:cursor-grabbing rounded-base"
          style={{
            transform: `translateX(${translateX}px) rotate(${tilt}deg)`,
            transition: isTransitioning ? 'transform 0.25s ease-out' : 'none',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* Save indicator */}
          <div
            className="absolute inset-0 bg-success/20 border-r-4 border-success pointer-events-none z-10 flex items-center justify-end pr-4 transition-opacity"
            style={{ opacity: greenOpacity }}
          >
              <span className="text-[14px] font-bold font-mono uppercase tracking-widest text-success">Save <ChevronRight className="w-3 h-3 inline-block" /></span>
          </div>
          {/* Skip indicator */}
          <div
            className="absolute inset-0 bg-error/20 border-l-4 border-error pointer-events-none z-10 flex items-center justify-start pl-4 transition-opacity"
            style={{ opacity: redOpacity }}
          >
            <span className="text-[14px] font-bold font-mono uppercase tracking-widest text-error"><ChevronLeft className="w-4 h-4" /> Skip</span>
          </div>

          {/* Decision badge — shown when revisiting a decided item */}
          {item.decision !== 'pending' && (
            <div className="absolute inset-0 pointer-events-none z-20 flex items-start justify-end p-2"
              style={{ background: item.decision === 'saved' ? 'rgba(34,197,94,0.08)' : item.decision === 'skipped' || item.decision === 'failed' ? 'rgba(239,68,68,0.06)' : 'transparent' }}
            >
              <span className={`px-2 py-0.5 border text-[11px] font-bold font-mono uppercase tracking-widest ${
                item.decision === 'saved' || item.decision === 'saving'
                  ? 'border-success text-success bg-paper/90'
                  : item.decision === 'failed'
                  ? 'border-error text-error bg-paper/90'
                  : 'border-error text-error bg-paper/90'
              }`}>
                {item.decision === 'saved' ? <span>✓ saved · swipe <ChevronLeft className="w-2.5 h-2.5 inline-block" /> to undo</span> :
                 item.decision === 'saving' ? '...' :
                 item.decision === 'failed' ? '✗ failed' :
                 <span>✗ skipped · swipe <ChevronRight className="w-2.5 h-2.5 inline-block" /> to keep</span>}
              </span>
            </div>
          )}

          {/* Image — 45% of card height, portrait */}
          <div
            className="w-full flex-none border-b-2 border-ink overflow-hidden"
            style={{ height: '45%', background: item.croppedPreview ? 'var(--color-surface-container)' : item.cropColor }}
          >
            {item.croppedPreview ? (
              <img
                src={item.croppedPreview}
                alt={displayCategory}
                className="w-full h-full object-contain pointer-events-none"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                {item.classifying && <Spinner size={20} />}
                <span className="text-[12px] font-mono text-muted uppercase tracking-widest">
                  {item.classifying ? 'cropping...' : 'no preview'}
                </span>
              </div>
            )}
          </div>

          {/* Info panel — scrollable, takes remaining height */}
          <div
            className="flex-1 overflow-y-auto bg-paper min-h-0"
            onPointerDown={e => e.stopPropagation()}
          >
            {editOpen ? (
              <div className="p-3 flex flex-col gap-2">
                <Field label="Category" value={item.editCategory} onChange={v => onUpdateItem({ editCategory: v })} />
                <Field label="Subcategory" value={item.editSubcategory} onChange={v => onUpdateItem({ editSubcategory: v })} />
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono uppercase tracking-widest text-muted">Color</label>
                  {item.editColors.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {item.editColors.map(c => (
                        <span key={c} className="flex items-center gap-0.5 border border-outline-variant px-1.5 py-0.5 text-[11px] font-mono uppercase tracking-wide">
                          {c}
                          <button onClick={() => onUpdateItem({ editColors: item.editColors.filter(x => x !== c) })} className="text-muted hover:text-ink"><X className="w-2.5 h-2.5" strokeWidth={2} /></button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1">
                    <input
                      className="flex-1 border border-outline-variant px-2 py-1 text-[13px] font-mono focus:border-ink outline-none"
                      placeholder="add color"
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault()
                          const v = normalizeColor(e.currentTarget.value)
                          if (v && !item.editColors.includes(v)) onUpdateItem({ editColors: [...item.editColors, v] })
                          e.currentTarget.value = ''
                        }
                      }}
                      onBlur={e => {
                        const v = normalizeColor(e.currentTarget.value)
                        if (v && !item.editColors.includes(v)) onUpdateItem({ editColors: [...item.editColors, v] })
                        e.currentTarget.value = ''
                      }}
                    />
                    {cls?.colors && cls.colors.length > 0 && cls.colors.some(c => !item.editColors.includes(c)) && (
                      <button
                        onClick={() => onUpdateItem({ editColors: [...new Set([...item.editColors, ...(cls?.colors ?? [])])] })}
                        className="text-[11px] font-mono uppercase tracking-widest text-muted hover:text-ink border border-outline-variant px-1.5 py-0.5 flex-none"
                      >
                        + from AI
                      </button>
                    )}
                  </div>
                </div>
                <Field label="Season" value={item.editSeason} onChange={v => onUpdateItem({ editSeason: v })} />
                <Field label="Brand" value={item.editBrand} onChange={v => onUpdateItem({ editBrand: v })} />
                <Field label="Size" value={item.editSize} onChange={v => onUpdateItem({ editSize: v })} />
                <div className="flex flex-col gap-0.5">
                  <label className="text-[11px] font-mono uppercase tracking-widest text-muted">Description</label>
                  <textarea
                    className="border border-outline-variant px-2 py-1 text-[13px] font-mono focus:border-ink outline-none resize-y min-h-[3rem]"
                    rows={3}
                    value={item.editDescription}
                    onChange={e => onUpdateItem({ editDescription: e.target.value })}
                  />
                </div>
                <button
                  onClick={() => setEditOpen(false)}
                  className="mt-1 text-[12px] font-mono uppercase tracking-widest text-muted hover:text-ink text-right"
                >
                  done ✓
                </button>
              </div>
            ) : (
              <div className="p-3 flex flex-col gap-2.5">
                {/* Title + edit */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <p className="text-[15px] font-bold font-mono uppercase tracking-tight leading-none truncate">
                      {displayCategory}
                    </p>
                    {displaySubcategory && (
                      <p className="text-[12px] font-mono text-muted uppercase tracking-widest">{displaySubcategory}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setEditOpen(true)}
                    className="text-[12px] font-mono uppercase tracking-widest text-ink flex-none border-2 border-ink bg-paper rounded-base shadow-flat-xs px-1.5 py-0.5 hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors]"
                  >
                    <Pencil className="inline w-2.5 h-2.5 mr-0.5 -mt-0.5" strokeWidth={2.5} /> edit
                  </button>
                </div>

                {/* Analysing indicator */}
                {item.classifying && (
                  <div className="flex items-center gap-1.5">
                    <Spinner size={10} />
                    <span className="text-[12px] font-mono text-muted uppercase tracking-widest">
                      analysing item...
                    </span>
                  </div>
                )}

                {/* Error */}
                {item.classifyError && (
                  <div className="flex items-center justify-between gap-2 border border-error/20 px-2 py-1">
                    <p className="text-[12px] font-mono text-error uppercase tracking-widest">
                      AI failed — retry, edit fields manually or skip
                    </p>
                    {onRetryClassify && (
                      <button
                        onClick={onRetryClassify}
                        className="text-[12px] font-mono uppercase tracking-widest text-ink border-2 border-ink bg-paper rounded-base shadow-flat-xs px-1.5 py-0.5 hover:bg-surface-dim flex-none"
                      >
                        retry
                      </button>
                    )}
                  </div>
                )}

                {/* AI description */}
                {cls?.ai_description && (
                  <p className="text-[12px] font-mono text-muted leading-relaxed border-l-2 border-outline-variant pl-2">
                    {cls.ai_description}
                  </p>
                )}

                {/* Colors */}
                {displayColors.length > 0 && (
                  <Row label="color">
                    {displayColors.map(c => <Chip key={c}>{c}</Chip>)}
                  </Row>
                )}

                {/* Season */}
                {displaySeasons.length > 0 && (
                  <Row label="season">
                    {displaySeasons.map(s => <Chip key={s}>{s}</Chip>)}
                  </Row>
                )}

                {/* Material */}
                {cls?.material && (
                  <Row label="material">
                    <span className="text-[12px] font-mono text-ink">{cls.material}</span>
                  </Row>
                )}

                {/* Tags */}
                {displayTags.length > 0 && (
                  <Row label="tags">
                    {displayTags.map(t => <Chip key={t}>{t}</Chip>)}
                  </Row>
                )}

                {/* Brand / Size */}
                {(item.editBrand || item.editSize) && (
                  <div className="flex gap-4">
                    {item.editBrand && (
                      <Row label="brand">
                        <span className="text-[12px] font-mono text-ink">{item.editBrand}</span>
                      </Row>
                    )}
                    {item.editSize && (
                      <Row label="size">
                        <span className="text-[12px] font-mono text-ink">{item.editSize}</span>
                      </Row>
                    )}
                  </div>
                )}

                {/* Cancel / remove — the non-swipe skip path and the un-save action */}
                <button
                  onClick={onSkip}
                  disabled={interactionLocked || item.decision === 'skipped'}
                  className="text-[12px] font-mono uppercase tracking-widest text-error border-2 border-error bg-paper rounded-base shadow-flat-xs px-2 py-1 hover:bg-surface-dim text-left self-start mt-1 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-30"
                >
                  {item.decision === 'saved' ? 'remove' : 'cancel'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hint (desktop) — only shows until first interaction; click to dismiss. */}
      {showHint && (
        <div className="px-4 pb-1 flex-none hidden md:block">
          <p
            onClick={onDismissHint}
            className="text-[11px] font-mono text-muted uppercase tracking-widest text-center cursor-pointer hover:text-muted"
          >
            <ChevronLeft className="w-2.5 h-2.5 inline-block" /> skip · <ChevronRight className="w-2.5 h-2.5 inline-block" /> save · e to edit  ·  tap to dismiss
          </p>
        </div>
      )}
      {/* Buttons — desktop only */}
      <div className="hidden md:flex gap-2 px-4 pb-4 flex-none">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={onSkip}
          disabled={interactionLocked || notReady || item.decision === 'skipped'}
        >
          {item.decision === 'skipped' ? '— skipped' : <span><ChevronLeft className="w-3 h-3 inline-block" /> skip</span>}
        </Button>
        <Button
          className="flex-1"
          onClick={onSave}
          disabled={interactionLocked || notReady || item.decision === 'saved'}
          loading={item.decision === 'saving' || notReady}
        >
          {notReady ? 'preparing...' :
           item.decision === 'saved' ? '✓ saved' :
           <span>save <ChevronRight className="w-3 h-3 inline-block" /></span>}
        </Button>
      </div>

      {/* Mobile swipe hint — full-height tinted side panels.
          Tap anywhere on the hint to dismiss it permanently. The swipe
          gesture on the underlying card also dismisses (pointerdown on the
          card calls onDismissHint). */}
      {showHint && (
        <div
          className="md:hidden absolute inset-0 z-[5] flex cursor-pointer"
          onClick={onDismissHint}
          onPointerDown={onDismissHint}
        >
          <div className="flex-1 bg-error/15 flex flex-col items-center justify-center gap-3 border-r border-error/30 pointer-events-none">
            <ChevronLeft className="w-16 h-16 text-error swipe-hint-arrow-left" strokeWidth={2.5} />
            <span className="text-[14px] font-bold font-mono uppercase tracking-[0.18em] text-error">swipe to skip</span>
          </div>
          <div className="flex-1 bg-success/15 flex flex-col items-center justify-center gap-3 border-l border-success/30 pointer-events-none">
            <ChevronRight className="w-16 h-16 text-success swipe-hint-arrow-right" strokeWidth={2.5} />
            <span className="text-[14px] font-bold font-mono uppercase tracking-[0.18em] text-success">swipe to save</span>
          </div>
          <style>{`
            @keyframes swipeHintArrowLeft { 0%,100% { transform: translateX(0); opacity: .7 } 50% { transform: translateX(-12px); opacity: 1 } }
            @keyframes swipeHintArrowRight { 0%,100% { transform: translateX(0); opacity: .7 } 50% { transform: translateX(12px); opacity: 1 } }
            .swipe-hint-arrow-left { animation: swipeHintArrowLeft 1.4s ease-in-out infinite }
            .swipe-hint-arrow-right { animation: swipeHintArrowRight 1.4s ease-in-out infinite }
          `}</style>
        </div>
      )}
    </div>
  )
}

// Calm status for a 429 back-off: the queue is waiting, nothing failed.
function PacingNote() {
  return (
    <p role="status" className="px-4 py-1 text-[11px] font-mono uppercase tracking-widest text-muted text-center flex-none">
      pacing to stay under limits · resuming shortly
    </p>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-[11px] font-mono uppercase tracking-widest text-muted w-20 flex-none">{label}</label>
      <input
        className="flex-1 border border-outline-variant px-2 py-1 text-[13px] font-mono focus:border-ink outline-none"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1.5 py-0.5 border border-outline-variant text-[11px] font-mono uppercase tracking-wide text-muted">
      {children}
    </span>
  )
}

// Exported for tests — builds the POST body for createItem from ReviewItem state.
// edit* fields win over classification data.
export function buildClassificationPatch(item: ReviewItem) {
  return {
    subcategory: item.editSubcategory || item.classification?.subcategory || undefined,
    primaryColor: item.editColors[0] || item.classification?.primary_color || undefined,
    colors: item.editColors.length ? item.editColors : item.classification?.colors,
    season: item.editSeason
      ? [item.editSeason]
      : item.classification?.season?.length
        ? item.classification.season
        : undefined,
    tags: item.classification?.suggested_tags,
    aiDescription: item.editDescription || item.classification?.ai_description || undefined,
    wearContext: item.classification?.wear_context || undefined,
    material: item.classification?.material || undefined,
  }
}

export function buildItemPayload(item: ReviewItem) {
  return {
    category: item.editCategory || item.category,
    brand: item.editBrand || undefined,
    size: item.editSize || undefined,
    ...buildClassificationPatch(item),
  }
}

// Exported for tests — merges AI classification result into a ReviewItem.
// Preserves any fields the user has explicitly edited (non-default values).
export function applyClassificationToItem(ri: ReviewItem, cls: ItemClassification): Partial<ReviewItem> {
  const wasEdited = ri.editCategory !== ri.category ||
    ri.editSubcategory !== '' ||
    ri.editColors.length > 0 ||
    ri.editBrand !== '' ||
    ri.editSeason !== '' ||
    ri.editDescription !== '' ||
    ri.editSize !== ''
  return {
    classification: cls,
    classifying: false,
    editCategory: wasEdited ? ri.editCategory : (cls.category ?? ri.editCategory),
    editSubcategory: wasEdited ? ri.editSubcategory : (cls.subcategory ?? ''),
    editColors: wasEdited ? ri.editColors : (cls.colors ?? []),
    editSeason: wasEdited ? ri.editSeason : (cls.season?.[0] ?? ''),
    editDescription: wasEdited ? ri.editDescription : (cls.ai_description ?? ''),
  }
}

// ── Main component ──────────────────────────────────────────────────────────

export function AddItemFlow({ mode, onClose, onSaved, onBack }: AddItemFlowProps) {
  const navigate = useNavigate()
  const [step, setStep] = useState<FlowStep>('upload')
  const [photos, setPhotos] = useState<PhotoEntry[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [activePhotoIdx, setActivePhotoIdx] = useState(0)
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([])
  const [activeReviewIdx, setActiveReviewIdx] = useState(0)
  const [savedCount, setSavedCount] = useState(0)
  const [undoStack, setUndoStack] = useState<number[]>([])
  const [describeOpen, setDescribeOpen] = useState(false)
  const [describeText, setDescribeText] = useState('')
  const [reanalyzing, setReanalyzing] = useState(false)
  const [closetCategories, setClosetCategories] = useState<string[]>([])
  const [batchCost, setBatchCost] = useState<{ billedTokens: number; wholesaleCostCentsX100: number; tokensIn: number; tokensOut: number } | null>(null)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  // #315 — self-host has no wallet (/api/billing is unmounted): skip the
  // balance fetch + pre-check and hide the token cost on auto-detect.
  const billingEnabled = useBillingEnabled()
  const [batchPreviewError, setBatchPreviewError] = useState<string | null>(null)
  const [detectingInBbox, setDetectingInBbox] = useState(false)
  const [autoDetected, setAutoDetected] = useState(false)
  // Batch-level detect progress ("detecting · 6 of 24 done").
  const [detectProgress, setDetectProgress] = useState<{ done: number; total: number } | null>(null)
  // True while a 429 has the queue waiting out Retry-After.
  const [aiPacing, setAiPacing] = useState(false)
  const [savePacing, setSavePacing] = useState(false)
  const [batchLimitNote, setBatchLimitNote] = useState<string | null>(null)
  // Persist hint dismissal across sessions so it never reappears once the
  // user has shown they understand the gesture (drag, button tap, or hint tap).
  const [showSwipeHint, setShowSwipeHint] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem('closet:swipe-hint-dismissed') !== '1' } catch { return true }
  })

  function dismissHint() {
    setShowSwipeHint(false)
    try { window.localStorage.setItem('closet:swipe-hint-dismissed', '1') } catch { /* ignore */ }
  }

  // While the modal is mounted, prevent the underlying app-shell AND body from
  // scrolling. Without locking <body> on desktop, the page underneath can scroll
  // past the modal's bottom edge and cut off the action buttons.
  // Preserve scroll position so the page doesn't jump after the modal closes.
  useEffect(() => {
    const shell = document.getElementById('app-shell')
    const shellScrollTop = shell?.scrollTop ?? 0
    const windowScrollY = window.scrollY
    const prevShell = shell?.style.overflow ?? ''
    const prevBody = document.body.style.overflow
    if (shell) shell.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      if (shell) {
        shell.style.overflow = prevShell
        shell.scrollTop = shellScrollTop
      }
      document.body.style.overflow = prevBody
      window.scrollTo(0, windowScrollY)
    }
  }, [])

  useEffect(() => {
    fetchItemMeta()
      .then(meta => { if (meta.categories.length > 0) setClosetCategories(meta.categories) })
      .catch(() => { /* use hardcoded fallback in DetectionOverlay */ })
  }, [])

  useEffect(() => {
    if (!billingEnabled) return
    fetchTokenBalance()
      .then(setWalletBalance)
      .catch(() => setWalletBalance(null))
  }, [billingEnabled])

  const fileInputRef = useRef<HTMLInputElement>(null)

  // Every blob: URL this flow creates (photo previews, crop previews). Each one
  // pins its Blob in memory until revoked, so release them when the photo or
  // crop is dropped and everything left over on unmount.
  const objectUrlsRef = useRef<Set<string>>(new Set())

  function trackObjectUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob)
    objectUrlsRef.current.add(url)
    return url
  }

  function releaseObjectUrl(url: string | null | undefined) {
    if (!url || !objectUrlsRef.current.delete(url)) return
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    const urls = objectUrlsRef.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  // ── Rate-limit pacing ───────────────────────────────────────────────────

  // bulk-detect and /analyze draw on one per-user server budget, so they share
  // one gate: a 429 on any job pauses every job until Retry-After passes.
  // Saves (POST /api/items) have their own budget and gate.
  const aiGateRef = useRef<RateLimitGate | null>(null)
  const saveGateRef = useRef<RateLimitGate | null>(null)
  function aiGate() {
    return aiGateRef.current ??= createRateLimitGate(setAiPacing)
  }
  function saveGate() {
    return saveGateRef.current ??= createRateLimitGate(setSavePacing)
  }
  useEffect(() => () => {
    aiGateRef.current?.dispose()
    saveGateRef.current?.dispose()
  }, [])

  // Bumped whenever the review queue is rebuilt; crop/classify jobs from an
  // earlier pass check it and drop their results instead of writing into the
  // new queue by index.
  const reviewGenRef = useRef(0)
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => { unmountedRef.current = true }
  }, [])
  const classifyLimitRef = useRef<Limiter | null>(null)
  const thumbLimitRef = useRef<Limiter | null>(null)

  // ── Upload ──────────────────────────────────────────────────────────────

  function readAspectRatio(url: string): Promise<string | null> {
    return new Promise(resolve => {
      const img = new Image()
      img.onload = () => {
        const ratio = `${img.naturalWidth}/${img.naturalHeight}`
        img.src = ''
        resolve(ratio)
      }
      img.onerror = () => resolve(null)
      img.src = url
    })
  }

  async function loadPhotoEntry(file: File): Promise<PhotoEntry> {
    const preview = trackObjectUrl(file)
    const thumbLimit = thumbLimitRef.current ??= limitConcurrency(THUMBNAIL_CONCURRENCY)
    const thumb = await thumbLimit(() => makePhotoThumbnail(file)).catch(() => null)
    if (thumb) {
      return {
        file, preview, thumb: trackObjectUrl(thumb.blob),
        aspectRatio: `${thumb.width}/${thumb.height}`,
        detections: null, detectError: null, detecting: false,
      }
    }
    const aspectRatio = await readAspectRatio(preview)
    return { file, preview, thumb: preview, aspectRatio, detections: null, detectError: null, detecting: false }
  }

  async function addPhotos(files: FileList | File[]) {
    const arr = Array.from(files).filter(f => f.type.startsWith('image/'))
    const remaining = MAX_BATCH_PHOTOS - photos.length
    if (arr.length > remaining) {
      setBatchLimitNote(remaining > 0
        ? `Added ${remaining} of ${arr.length} — a batch holds up to ${MAX_BATCH_PHOTOS} photos.`
        : `A batch holds up to ${MAX_BATCH_PHOTOS} photos — add the rest in another batch.`)
    } else {
      setBatchLimitNote(null)
    }
    if (remaining <= 0) return
    const entries = await Promise.all(arr.slice(0, remaining).map(loadPhotoEntry))
    setPhotos(prev => [...prev, ...entries].slice(0, MAX_BATCH_PHOTOS))
  }

  function removePhoto(idx: number) {
    releaseObjectUrl(photos[idx]?.preview)
    releaseObjectUrl(photos[idx]?.thumb)
    setBatchLimitNote(null)
    setPhotos(prev => prev.filter((_, i) => i !== idx))
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    setDragOver(false)
    void addPhotos(e.dataTransfer.files)
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) void addPhotos(e.target.files)
    e.target.value = ''
  }

  usePasteImage(files => void addPhotos(files), step === 'upload')

  type DetectCost = NonNullable<Awaited<ReturnType<typeof detectBulkItems>>['cost']>

  function addBatchCost(costs: DetectCost[]) {
    if (costs.length === 0) return
    setBatchCost(prev => {
      const total = prev ? { ...prev } : { billedTokens: 0, wholesaleCostCentsX100: 0, tokensIn: 0, tokensOut: 0 }
      for (const c of costs) {
        total.tokensIn += c.tokensIn
        total.tokensOut += c.tokensOut
        total.billedTokens += c.billedTokens
        total.wholesaleCostCentsX100 += c.wholesaleCostCentsX100
      }
      return total
    })
  }

  /**
   * Detect items on the given photos, DETECT_CONCURRENCY at a time. A 429
   * waits and retries the same photo; any other failure marks only that photo
   * (detectError, empty boxes) and the rest of the batch carries on.
   */
  async function detectPhotos(indices: number[], files: File[]) {
    const limit = limitConcurrency(DETECT_CONCURRENCY)
    const results = await Promise.allSettled(indices.map((idx, n) => limit(async () => {
      try {
        const result = await withRateLimitRetry(() => detectBulkItems(files[n]), { gate: aiGate() })
        if (!unmountedRef.current) {
          setPhotos(prev => prev.map((ph, i) => i === idx ? { ...ph, detections: result.detections, sourceUri: result.sourceUri, detectError: null, detecting: false } : ph))
        }
        return result
      } catch (err) {
        if (!unmountedRef.current) {
          setPhotos(prev => prev.map((ph, i) => i === idx ? { ...ph, detections: [], detectError: String(err), detecting: false } : ph))
        }
        throw err
      } finally {
        if (!unmountedRef.current) setDetectProgress(p => p && { ...p, done: p.done + 1 })
      }
    })))
    // Summed outside the state updater so a re-run updater (StrictMode) can't
    // double-count.
    const costs: DetectCost[] = []
    for (const r of results) if (r.status === 'fulfilled' && r.value.cost) costs.push(r.value.cost)
    return costs
  }

  async function handleDetect() {
    if (photos.length === 0) return
    setBatchPreviewError(null)

    if (billingEnabled) {
      const tokensNeeded = photos.length * 2
      let balance: number
      try {
        balance = await fetchTokenBalance()
        setWalletBalance(balance)
      } catch {
        setBatchPreviewError('Could not verify token balance. Please try again.')
        return
      }

      if (balance < tokensNeeded) {
        setBatchPreviewError(`Insufficient tokens: needs ${tokensNeeded}, balance ${balance}.`)
        return
      }
    }

    setDetectingInBbox(true)
    setDetectProgress({ done: 0, total: photos.length })
    setBatchCost(null)

    // Each photo's detections land as soon as that photo finishes, instead of
    // waiting for the slowest one.
    const costs = await detectPhotos(photos.map((_, i) => i), photos.map(p => p.file))
    if (unmountedRef.current) return
    addBatchCost(costs)
    setAutoDetected(true)
    setDetectingInBbox(false)
    setDetectProgress(null)
  }

  /** Retry detection on photos whose detect failed. */
  async function retryDetect(indices: number[]) {
    const targets = indices.filter(i => photos[i] && !photos[i].detecting)
    if (targets.length === 0) return
    setPhotos(prev => prev.map((ph, i) => targets.includes(i) ? { ...ph, detecting: true, detectError: null } : ph))
    const costs = await detectPhotos(targets, targets.map(i => photos[i].file))
    if (!unmountedRef.current) addBatchCost(costs)
  }

  // ── Bbox ────────────────────────────────────────────────────────────────

  function updateDetections(photoIdx: number, dets: Detection[]) {
    setPhotos(prev => prev.map((p, i) => i === photoIdx ? { ...p, detections: dets } : p))
  }

  function handleTapAdd(photoIdx: number, x: number, y: number, scale = 1) {
    const s = Math.max(1, scale)
    const existing = photos[photoIdx]?.detections ?? []
    const newDet: Detection = {
      id: String(Date.now()),
      label: 'Item',
      category: closetCategories[0] || 'tops',
      cropColor: CROP_COLORS[existing.length % CROP_COLORS.length],
      box: { x: Math.max(0, Math.min(80, x - (10 / s))), y: Math.max(0, Math.min(82, y - (9 / s))), w: Math.max(5, 20 / s), h: Math.max(5, 18 / s) },
      kept: true,
      alternatives: ['bottoms', 'shoes', 'accessories', 'outerwear', 'bags'],
    }
    updateDetections(photoIdx, [...existing, newDet])
  }

  async function handleReanalyze(photoIdx: number) {
    setReanalyzing(true)
    setDescribeOpen(false)
    try {
      const file = photos[photoIdx].file
      const result = await withRateLimitRetry(() => detectBulkItems(file), { gate: aiGate() })
      updateDetections(photoIdx, result.detections)
      setPhotos(prev => prev.map((ph, i) => i === photoIdx ? { ...ph, sourceUri: result.sourceUri } : ph))
    } catch { /* ignore */ } finally {
      setReanalyzing(false)
      setDescribeText('')
    }
  }

  function totalKeptCount() {
    return photos.reduce((acc, p) => acc + (p.detections?.filter(d => d.kept).length ?? 0), 0)
  }

  /**
   * Crop one box and classify it, inside the review pass's bounded queue. A
   * 429 waits and retries; any other failure marks only this item
   * (classifyError) so the card offers a retry. `existingCrop` skips the crop
   * when only the classify step failed.
   */
  // One server copy per photo for boxes drawn by hand (no bulk-detect ran),
  // shared by all its boxes; keyed by the File so a reordered list can't mix them up.
  const stagedSourceRef = useRef(new WeakMap<File, Promise<string>>())
  function ensureSourceUri(photoFile: File): Promise<string> {
    let staged = stagedSourceRef.current.get(photoFile)
    if (!staged) {
      staged = stageSourcePhoto(photoFile).then(uri => {
        if (!unmountedRef.current) setPhotos(prev => prev.map(ph => ph.file === photoFile ? { ...ph, sourceUri: uri } : ph))
        return uri
      })
      staged.catch(() => stagedSourceRef.current.delete(photoFile))
      stagedSourceRef.current.set(photoFile, staged)
    }
    return staged
  }

  /** Server crop (staging the photo first if needed); the canvas crop is the last resort. */
  async function cropBox(photoFile: File, box: Detection['box'], sourceUri?: string | null): Promise<File> {
    try {
      return await cropDetectedBox(sourceUri || await ensureSourceUri(photoFile), box)
    } catch (err) {
      console.warn('[bulk-add] server crop failed, trying the browser:', err)
      return cropToBbox(photoFile, box)
    }
  }

  function cropAndClassify(i: number, photoFile: File, box: Detection['box'], existingCrop: File | null, sourceUri?: string | null) {
    const gen = reviewGenRef.current
    const stale = () => gen !== reviewGenRef.current || unmountedRef.current
    const limit = classifyLimitRef.current ??= limitConcurrency(CROP_CLASSIFY_CONCURRENCY)
    return limit(async () => {
      if (stale()) return
      try {
        let croppedFile = existingCrop
        if (!croppedFile) {
          const crop = await cropBox(photoFile, box, sourceUri)
          if (stale()) return
          croppedFile = crop
          const croppedPreview = trackObjectUrl(crop)
          setReviewQueue(prev => prev.map((ri, idx) =>
            idx === i ? { ...ri, croppedFile: crop, croppedPreview } : ri
          ))
        }
        const file = croppedFile
        const cls = await withRateLimitRetry(() => analyzeItem(file), { gate: aiGate() })
        if (stale()) return
        setReviewQueue(prev => prev.map((ri, idx) =>
          idx !== i ? ri : { ...ri, ...applyClassificationToItem(ri, cls) }
        ))
      } catch (err) {
        // Visible in the console: these failures used to be silent.
        console.warn('[bulk-add] crop/classify failed:', err)
        if (stale()) return
        setReviewQueue(prev => prev.map((ri, idx) =>
          idx === i ? { ...ri, classifying: false, classifyError: true } : ri
        ))
      }
    })
  }

  function retryClassify(idx: number) {
    const ri = reviewQueue[idx]
    if (!ri || ri.classifying) return
    const photo = photos[ri.photoIdx]
    if (!photo) return
    setReviewQueue(prev => prev.map((r, i) => i === idx ? { ...r, classifying: true, classifyError: false } : r))
    void cropAndClassify(idx, photo.file, ri.box, ri.croppedFile, photo.sourceUri)
  }

  async function handleProceedToReview() {
    const items: ReviewItem[] = []
    for (let photoIdx = 0; photoIdx < photos.length; photoIdx++) {
      for (const det of (photos[photoIdx].detections ?? [])) {
        if (!det.kept) continue
        items.push({
          id: det.id,
          photoIdx,
          box: det.box,
          category: det.category,
          cropColor: det.cropColor,
          croppedFile: null,
          croppedPreview: null,
          classification: null,
          classifying: true,
          classifyError: false,
          decision: 'pending',
          saveKey: crypto.randomUUID(),
          createdItemId: null,
          createdImageUri: null,
          editCategory: det.category,
          editSubcategory: '',
          editColors: [],
          editBrand: '',
          editSize: '',
          editSeason: '',
          editDescription: '',
        })
      }
    }
    // Going back to the boxes and forward again rebuilds the queue; drop the
    // previous pass's crop previews first, and retire its still-queued jobs.
    for (const ri of reviewQueue) releaseObjectUrl(ri.croppedPreview)
    reviewGenRef.current++
    classifyLimitRef.current = limitConcurrency(CROP_CLASSIFY_CONCURRENCY)
    setReviewQueue(items)
    setActiveReviewIdx(0)
    setSavedCount(0)
    setUndoStack([])
    setStep('review')

    // Background: crop each bbox, then classify, a few at a time
    items.forEach((item, i) => {
      void cropAndClassify(i, photos[item.photoIdx].file, item.box, null, photos[item.photoIdx].sourceUri)
    })
  }

  // ── Review ──────────────────────────────────────────────────────────────

  // Find the next item that still needs a decision (excludes decidedIdx which is mid-transition).
  // Searches forward then wraps backward. Returns null if everything is settled.
  function advanceAfterDecision(decidedIdx: number) {
    for (let i = decidedIdx + 1; i < reviewQueue.length; i++) {
      if (reviewQueue[i].decision === 'pending') { setActiveReviewIdx(i); return }
    }
    for (let i = 0; i < decidedIdx; i++) {
      if (reviewQueue[i].decision === 'pending') { setActiveReviewIdx(i); return }
    }
    // Nothing left to decide — the useEffect below will trigger done once saving settles
  }

  async function handleSave(idx: number) {
    const item = reviewQueue[idx]
    if (item.decision === 'saving' || item.decision === 'saved') return // in-flight or already saved
    if (!item.croppedFile) { handleSkip(idx); return }

    setReviewQueue(prev => prev.map((ri, i) => i === idx ? { ...ri, decision: 'saving' } : ri))
    setUndoStack(prev => [...prev, idx])
    advanceAfterDecision(idx)

    try {
      // Same idempotency key on every attempt, so a 429 retry can't duplicate.
      const file = item.croppedFile
      const created = await withRateLimitRetry(
        () => createItem(file, buildItemPayload(item), { idempotencyKey: item.saveKey }),
        { gate: saveGate() },
      )
      setReviewQueue(prev => prev.map((ri, i) => i === idx ? { ...ri, decision: 'saved', createdItemId: created.id, createdImageUri: created.imageUri } : ri))
      setSavedCount(c => c + 1)
      track('item_added', { category: created.category, subcategory: created.subcategory })
    } catch {
      setReviewQueue(prev => prev.map((ri, i) => i === idx ? { ...ri, decision: 'failed' } : ri))
    }
  }

  async function handleSkip(idx: number) {
    const item = reviewQueue[idx]
    if (item.decision === 'saving') return // can't interrupt an in-flight save

    // If the item was already saved to the backend, delete it before flipping the decision.
    // Fire-and-forget the network call so the UI feels instant; surface errors via console.
    if (item.decision === 'saved' && item.createdItemId) {
      const idToRemove = item.createdItemId
      setSavedCount(c => Math.max(0, c - 1))
      deleteItem(idToRemove).catch(err => {
        console.error('Failed to delete item on skip', err)
      })
    }

    // A skipped item's saved copy is being deleted, so a later undo + save must
    // create a fresh one rather than replay the deleted item: rotate the key.
    const saveKey = item.decision === 'saved' ? crypto.randomUUID() : item.saveKey
    setReviewQueue(prev => prev.map((ri, i) => i === idx ? { ...ri, decision: 'skipped', saveKey, createdItemId: null, createdImageUri: null } : ri))
    setUndoStack(prev => [...prev, idx])
    advanceAfterDecision(idx)
  }

  function handleUndo() {
    if (undoStack.length === 0) return
    const lastIdx = undoStack[undoStack.length - 1]
    const last = reviewQueue[lastIdx]
    if (last.decision !== 'skipped') return // can only undo skips
    setReviewQueue(prev => prev.map((ri, i) => i === lastIdx ? { ...ri, decision: 'pending' } : ri))
    setUndoStack(prev => prev.slice(0, -1))
    setActiveReviewIdx(lastIdx)
  }

  // Transition off review once every item is settled. Route through 'extras'
  // if any items were saved (so user can add views / generate covers); otherwise
  // jump straight to 'done'.
  useEffect(() => {
    if (step !== 'review' || reviewQueue.length === 0) return
    const allSettled = reviewQueue.every(ri => ri.decision !== 'pending' && ri.decision !== 'saving')
    if (!allSettled) return
    const anySaved = reviewQueue.some(ri => ri.decision === 'saved' && ri.createdItemId)
    setTimeout(() => setStep(anySaved ? 'extras' : 'done'), 350)
  }, [step, reviewQueue])

  // Signal parent when done step is reached
  useEffect(() => {
    if (step !== 'done') return
    const itemIds = reviewQueue
      .filter(ri => ri.decision === 'saved' && ri.createdItemId)
      .map(ri => ri.createdItemId as string)
    onSaved(savedCount, itemIds)
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render helpers ──────────────────────────────────────────────────────

  const keptCount = totalKeptCount()
  const failedPhotoIdxs = photos.flatMap((p, i) => (p.detectError && !p.detecting ? [i] : []))
  const classifyingCount = reviewQueue.filter(ri => ri.classifying).length
  const activePhoto = photos[activePhotoIdx]
  const currentReviewItem = reviewQueue[activeReviewIdx]

  const headerTitle: Record<FlowStep, string> = {
    upload: mode === 'onboarding' ? 'add wardrobe' : 'add items',
    detecting: 'scanning...',
    bbox: `photo ${activePhotoIdx + 1} of ${photos.length}`,
    review: `item ${Math.min(activeReviewIdx + 1, reviewQueue.length)} of ${reviewQueue.length}`,
    extras: 'polish',
    done: 'done',
  }

  const extrasItems: ExtrasItem[] = reviewQueue
    .filter(ri => ri.decision === 'saved' && ri.createdItemId && ri.createdImageUri)
    .map(ri => ({
      id: ri.createdItemId!,
      imageUri: ri.createdImageUri!,
      label: ri.classification?.subcategory ?? ri.editCategory ?? ri.category,
    }))

  return (
    <div
      className="fixed inset-0 nav-anchor-right z-[60] flex justify-center bg-black/50 h-[100dvh] overflow-hidden"
    >
      <div
        className="bg-paper border-x-2 border-ink w-full max-w-lg flex flex-col h-full max-h-[100dvh] overflow-hidden min-h-0"
        onPointerDown={() => { if (showSwipeHint) dismissHint() }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b-2 border-ink flex-none">
          <div className="flex items-center gap-3 min-w-0">
            {step === 'upload' && onBack && (
              <button onClick={onBack} className="w-9 h-9 flex items-center justify-center border-2 border-ink bg-paper text-ink rounded-base shadow-flat-xs hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors]" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
            )}
            {step === 'bbox' && (
              <button onClick={() => setStep('upload')} className="w-9 h-9 flex items-center justify-center border-2 border-ink bg-paper text-ink rounded-base shadow-flat-xs hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors]" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
            )}
            {step === 'review' && (
              <button onClick={() => setStep('bbox')} className="w-9 h-9 flex items-center justify-center border-2 border-ink bg-paper text-ink rounded-base shadow-flat-xs hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors]" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
            )}
            <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] truncate">
              {headerTitle[step]}
            </span>
          </div>
          <div className="flex items-center gap-3 flex-none">
            {step === 'extras' && (
              <button onClick={() => setStep('done')} className="text-[12px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink">skip</button>
            )}
            <button onClick={onClose} aria-label="Close" className="w-9 h-9 flex items-center justify-center border-2 border-ink bg-paper text-ink rounded-base shadow-flat-xs hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors]"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="flex flex-none h-0.5">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className={`flex-1 ${STEP_ORDER[step] >= i ? 'bg-accent' : 'bg-outline-variant'}`} />
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">

          {/* ── UPLOAD ── */}
          {step === 'upload' && (
            <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
              {mode === 'onboarding' && (
                <div className="border-2 border-ink p-3 bg-surface rounded-base">
                  <p className="text-[13px] font-bold font-mono uppercase tracking-widest">add your first items</p>
                  <p className="text-[12px] font-mono text-muted leading-relaxed mt-0.5">
                    a few photos is enough to get started — outfit on, flat lay, or items on hangers. add up to {MAX_BATCH_PHOTOS} at once.
                  </p>
                </div>
              )}

              {/* Selected photos row */}
              {photos.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1.5 pr-1.5">
                  {photos.map((p, i) => (
                    <div key={p.preview} className="relative flex-none">
                      <img
                        src={p.thumb}
                        alt={`photo ${i + 1}`}
                        className="w-20 h-20 object-cover border-2 border-ink rounded-base"
                      />
                      <button
                        onClick={() => removePhoto(i)}
                        aria-label={`Remove photo ${i + 1}`}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-accent text-accent-on flex items-center justify-center hover:bg-active"
                      >
                        <X className="w-3 h-3" strokeWidth={2.5} />
                      </button>
                    </div>
                  ))}
                  {photos.length < MAX_BATCH_PHOTOS && (
                    <label
                      className="w-20 h-20 border-2 border-dashed border-outline-variant flex flex-col items-center justify-center cursor-pointer hover:border-ink transition-colors flex-none"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <span className="text-[20px] text-muted">+</span>
                      <span className="text-[11px] font-mono text-muted uppercase tracking-wider mt-0.5">add photo</span>
                    </label>
                  )}
                </div>
              )}

              {/* Counter */}
              {photos.length > 0 && (
                <p className="text-[12px] font-mono uppercase tracking-widest text-muted">
                  {photos.length} photo{photos.length !== 1 ? 's' : ''} selected · up to {MAX_BATCH_PHOTOS}
                </p>
              )}
              {batchLimitNote && (
                <p role="status" className="text-[12px] font-mono text-muted">{batchLimitNote}</p>
              )}

              <input id="flow-file-input" ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onInputChange} />

              {/* Drop zone */}
              {photos.length === 0 && (
                <label
                  htmlFor="flow-file-input"
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  className={`border-2 border-dashed cursor-pointer flex flex-col items-center gap-3 py-12 px-6 transition-colors ${
                    dragOver ? 'border-ink bg-surface-dim' : 'border-outline-variant hover:border-ink'
                  }`}
                >
                  <Camera className="w-8 h-8 text-ink" />
                  <div className="text-center">
                    <p className="text-[13px] font-bold font-mono uppercase tracking-widest text-ink">tap to upload</p>
                    <p className="text-[12px] font-mono text-muted mt-0.5">up to {MAX_BATCH_PHOTOS} photos · or drag here</p>
                  </div>
                </label>
              )}

              {photos.length > 0 && (
                <Button className="w-full" onClick={() => { setActivePhotoIdx(0); setStep('bbox') }}>
                  continue <ChevronRight className="w-3.5 h-3.5 inline-block ml-1" />
                </Button>
              )}

              {photos.length === 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[12px] font-mono uppercase tracking-widest text-muted">what happens next</p>
                  {[
                    [Search, 'AI spots every garment in your photo'],
                    [Pencil, 'You approve the bounding boxes'],
                    [ArrowLeftRight, 'Swipe to save or skip each item'],
                  ].map(([Icon, text]) => {
                    const IconComponent = Icon as typeof Search
                    return (
                      <div key={text as string} className="flex items-start gap-2.5">
                        <IconComponent className="w-3.5 h-3.5 mt-0.5 text-ink flex-none" />
                        <p className="text-[13px] font-mono text-ink leading-relaxed">{text as string}</p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── BBOX ── */}
          {step === 'bbox' && activePhoto && (
            <div className="flex flex-col flex-1 min-h-0">
              {/* Per-photo nav */}
              {photos.length > 1 && (
                <div className="flex items-center justify-between px-4 py-2 border-b border-outline-variant flex-none">
                  <button
                    onClick={() => setActivePhotoIdx(i => Math.max(0, i - 1))}
                    disabled={activePhotoIdx === 0}
                    className="text-[12px] font-mono uppercase tracking-widest text-muted hover:text-ink disabled:opacity-30"
                  >
                    <ChevronLeft className="w-3 h-3 inline-block mr-1" /> prev
                  </button>
                  {photos.length <= MAX_NAV_DOTS ? (
                    <div className="flex gap-1">
                      {photos.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setActivePhotoIdx(i)}
                          className={`w-1.5 h-1.5 rounded-full transition-all ${
                            i === activePhotoIdx ? 'bg-accent' : 'bg-outline-variant hover:bg-muted'
                          }`}
                        />
                      ))}
                    </div>
                  ) : (
                    <span className="text-[12px] font-mono uppercase tracking-widest text-muted">
                      {activePhotoIdx + 1} / {photos.length}
                    </span>
                  )}
                  <button
                    onClick={() => setActivePhotoIdx(i => Math.min(photos.length - 1, i + 1))}
                    disabled={activePhotoIdx === photos.length - 1}
                    className="text-[12px] font-mono uppercase tracking-widest text-muted hover:text-ink disabled:opacity-30"
                  >
                    next <ChevronRight className="w-3 h-3 inline-block ml-1" />
                  </button>
                </div>
              )}

              {/* Detection count — only once detection has run */}
              {activePhoto.detections !== null && (
                <div className="px-4 py-2 border-b border-outline-variant bg-surface flex items-center justify-between flex-none">
                  <p className="text-[12px] font-mono uppercase tracking-widest text-muted">
                    {activePhoto.detections.filter(d => d.kept).length} selected
                    {' · '}{activePhoto.detections.length} detected
                  </p>
                  {activePhoto.detecting ? (
                    <p className="text-[12px] font-mono text-muted">retrying…</p>
                  ) : activePhoto.detectError && !detectingInBbox && (
                    <button
                      onClick={() => void retryDetect([activePhotoIdx])}
                      className="text-[12px] font-mono text-error hover:text-ink"
                    >
                      detection failed · retry
                    </button>
                  )}
                </div>
              )}

              {/* Batch-level failures: other photos stay usable; retry just these. */}
              {!detectingInBbox && failedPhotoIdxs.length > 0 && (
                <div className="px-4 py-2 border-b border-outline-variant flex items-center justify-between gap-2 flex-none">
                  <p className="text-[12px] font-mono text-error">
                    {failedPhotoIdxs.length} photo{failedPhotoIdxs.length !== 1 ? 's' : ''} couldn't be scanned
                  </p>
                  <button
                    onClick={() => void retryDetect(failedPhotoIdxs)}
                    className="text-[12px] font-mono uppercase tracking-widest text-ink border-2 border-ink bg-paper rounded-base shadow-flat-xs px-1.5 py-0.5 hover:bg-surface-dim flex-none"
                  >
                    retry {failedPhotoIdxs.length > 1 ? 'all' : ''}
                  </button>
                </div>
              )}
              {!detectingInBbox && aiPacing && photos.some(p => p.detecting) && <PacingNote />}

              {detectingInBbox ? (
                <div className="flex flex-col items-center justify-center gap-6 py-16 flex-1">
                  <div className="flex flex-wrap justify-center gap-2 max-h-[40vh] overflow-y-auto px-4">
                    {photos.map((p, i) => (
                      <div
                        key={i}
                        className={`w-16 h-16 border-2 border-ink overflow-hidden rounded-base transition-opacity ${p.detections === null ? 'opacity-40' : ''}`}
                      >
                        <img src={p.thumb} alt="" className="w-full h-full object-cover" />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    {[0, 1, 2].map(i => (
                      <div key={i} className="w-1.5 h-1.5 bg-accent rounded-full"
                        style={{ animation: `bounce 1s ${i * 0.2}s ease-in-out infinite` }} />
                    ))}
                  </div>
                  <p role="status" className="text-[13px] font-mono uppercase tracking-widest text-muted">
                    {detectProgress && detectProgress.total > 1
                      ? `detecting · ${detectProgress.done} of ${detectProgress.total} done`
                      : 'detecting items...'}
                  </p>
                  {aiPacing && <PacingNote />}
                  <style>{`@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}`}</style>
                </div>
              ) : reanalyzing ? (
                <div className="flex flex-col items-center justify-center gap-4 py-20 flex-1">
                  <div className="flex gap-1">
                    {[0, 1, 2].map(i => (
                      <div key={i} className="w-1.5 h-1.5 bg-accent rounded-full"
                        style={{ animation: `bounce 1s ${i * 0.2}s ease-in-out infinite` }} />
                    ))}
                  </div>
                  <p className="text-[13px] font-mono uppercase tracking-widest text-muted">re-analysing...</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-hidden p-2">
                  <DetectionOverlay
                    detections={activePhoto.detections ?? []}
                    onChange={dets => updateDetections(activePhotoIdx, dets)}
                    onTapAdd={(x, y, scale) => handleTapAdd(activePhotoIdx, x, y, scale)}
                    sourcePhotoUri={activePhoto.preview}
                    sourcePhotoLabel={`photo ${activePhotoIdx + 1}`}
                    aspectRatio={activePhoto.aspectRatio ?? undefined}
                    categories={closetCategories.length > 0 ? closetCategories : undefined}
                  />
                </div>
              )}

              {/* Footer */}
              <div
                className="flex-none border-t-2 border-ink px-4 py-3 bg-paper flex flex-col gap-2"
                style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
              >
                {activePhoto.detections === null ? (
                  /* No boxes yet — offer auto-detect; user can also tap photo to draw */
                  <>
                    {batchPreviewError && (
                      <p className="text-[12px] font-mono text-error uppercase tracking-widest">{batchPreviewError}</p>
                    )}
                    <Button className="w-full" onClick={() => void handleDetect()} disabled={detectingInBbox}>
                      <Sparkles className="w-3.5 h-3.5 inline-block mr-1.5" />
                      auto-detect
                      {billingEnabled && (
                        <span className="ml-1.5 opacity-60 text-[11px]">
                          · {photos.length * 2} tokens{walletBalance !== null ? ` / ${walletBalance} bal` : ''}
                        </span>
                      )}
                    </Button>
                    <p className="text-[11px] font-mono text-muted text-center">Or press +Add card to draw items</p>
                  </>
                ) : (
                  /* Boxes exist (drawn or detected) */
                  <>
                    {autoDetected && (
                      <button
                        onClick={() => setDescribeOpen(true)}
                        className="w-full flex items-center gap-2 border border-outline-variant px-3 py-2 hover:border-ink transition-colors text-left"
                      >
                        <AlertCircle className="w-3.5 h-3.5 text-muted flex-none" />
                        <span className="text-[12px] font-mono uppercase tracking-widest text-muted hover:text-ink flex-1">
                          something off? re-analyse with a hint
                        </span>
                      </button>
                    )}
                    <div className={`flex items-center gap-2 ${activePhotoIdx < photos.length - 1 ? 'justify-between' : 'justify-end'}`}>
                      {activePhotoIdx < photos.length - 1 && (
                        <button
                          disabled={keptCount === 0}
                          onClick={() => void handleProceedToReview()}
                          className="text-[12px] font-mono uppercase tracking-widest text-muted hover:text-ink disabled:opacity-30 py-1"
                        >
                          skip to review →
                        </button>
                      )}
                      {activePhotoIdx < photos.length - 1 ? (
                        <Button onClick={() => setActivePhotoIdx(i => i + 1)}>
                          next photo <ChevronRight className="w-3.5 h-3.5 inline-block ml-1" />
                        </Button>
                      ) : (
                        <Button
                          disabled={keptCount === 0}
                          onClick={() => void handleProceedToReview()}
                        >
                          review {keptCount} <ChevronRight className="w-3.5 h-3.5 inline-block ml-1" />
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── REVIEW ── */}
          {step === 'review' && currentReviewItem && (
            <div className="flex flex-col flex-1 min-h-0">
              {/* Per-item nav — Lucide chevrons sized for thumbs on mobile */}
              <div className="flex items-center justify-between px-2 md:px-4 py-2 border-b border-outline-variant flex-none">
                  <button
                    onClick={() => setActiveReviewIdx(i => Math.max(0, i - 1))}
                    disabled={activeReviewIdx === 0}
                    aria-label="Previous item"
                    className="text-ink hover:text-ink disabled:opacity-30 flex items-center justify-center min-w-[48px] min-h-[44px] md:min-w-0 md:min-h-0 md:px-2"
                  >
                    <ChevronLeft className="w-7 h-7 md:w-4 md:h-4" strokeWidth={2.5} />
                    <span className="hidden md:inline text-[12px] font-mono uppercase tracking-widest ml-1">prev</span>
                  </button>
                  {reviewQueue.length > MAX_NAV_DOTS ? (
                    <span className="text-[12px] font-mono uppercase tracking-widest text-muted">
                      {activeReviewIdx + 1} / {reviewQueue.length}
                    </span>
                  ) : (
                  <div className="flex gap-1.5 md:gap-1">
                    {reviewQueue.map((ri, i) => (
                      <button
                        key={i}
                        onClick={() => setActiveReviewIdx(i)}
                        aria-label={`Go to item ${i + 1}`}
                        className={`rounded-full w-2.5 h-2.5 md:w-3 md:h-3 transition-all ${
                          i === activeReviewIdx ? 'bg-accent ring-2 ring-accent ring-offset-1 ring-offset-paper' :
                          ri.decision === 'saved' ? 'bg-success' :
                          ri.decision === 'skipped' ? 'bg-error' :
                          ri.decision === 'failed' ? 'bg-error' :
                          'bg-outline-variant hover:bg-muted'
                        }`}
                      />
                    ))}
                  </div>
                  )}
                  <button
                    onClick={() => setActiveReviewIdx(i => Math.min(reviewQueue.length - 1, i + 1))}
                    disabled={activeReviewIdx === reviewQueue.length - 1}
                    aria-label="Next item"
                    className="text-ink hover:text-ink disabled:opacity-30 flex items-center justify-center min-w-[48px] min-h-[44px] md:min-w-0 md:min-h-0 md:px-2"
                  >
                    <span className="hidden md:inline text-[12px] font-mono uppercase tracking-widest mr-1">next</span>
                    <ChevronRight className="w-7 h-7 md:w-4 md:h-4" strokeWidth={2.5} />
                  </button>
                </div>

              {/* Background analysis progress — a long batch keeps classifying while you swipe. */}
              {classifyingCount > 0 && (
                <p role="status" className="px-4 py-1 border-b border-outline-variant text-[11px] font-mono uppercase tracking-widest text-muted flex-none">
                  analysing · {reviewQueue.length - classifyingCount} of {reviewQueue.length} done
                </p>
              )}
              {(aiPacing && classifyingCount > 0) || savePacing ? <PacingNote /> : null}

              <SwipeCard
                key={currentReviewItem.id}
                item={currentReviewItem}
                showHint={showSwipeHint && activeReviewIdx === 0}
                onDismissHint={dismissHint}
                onSave={() => { dismissHint(); void handleSave(activeReviewIdx) }}
                onSkip={() => { dismissHint(); void handleSkip(activeReviewIdx) }}
                onUpdateItem={updates => setReviewQueue(prev => prev.map((ri, i) => i === activeReviewIdx ? { ...ri, ...updates } : ri))}
                onRetryClassify={() => retryClassify(activeReviewIdx)}
              />
            </div>
          )}

          {/* ── DONE ── */}
          {step === 'extras' && (
            <AddRelatedViewsStep
              items={extrasItems}
              onDone={() => setStep('done')}
            />
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center gap-6 py-16 px-6 flex-1">
              <div className="w-16 h-16 bg-accent flex items-center justify-center text-white text-[28px]">✓</div>
              <div className="text-center flex flex-col gap-1.5">
                <p className="text-[24px] font-bold font-mono uppercase tracking-tight">
                  {savedCount} item{savedCount !== 1 ? 's' : ''} saved
                </p>
                <p className="text-[13px] font-mono text-muted uppercase tracking-widest">to your closet</p>
              </div>

              {reviewQueue.filter(ri => ri.decision === 'failed').length > 0 && (
                <p className="text-[12px] font-mono text-error uppercase tracking-widest text-center">
                  {reviewQueue.filter(ri => ri.decision === 'failed').length} item{reviewQueue.filter(ri => ri.decision === 'failed').length !== 1 ? 's' : ''} failed to save
                </p>
              )}

              <div className="flex flex-col gap-2 w-full">
                {mode === 'onboarding' ? (
                  <Button className="w-full" onClick={() => { onClose(); navigate('/closet') }}>
                    view closet
                  </Button>
                ) : (
                  <>
                    <Button className="w-full" onClick={() => { onClose(); navigate('/closet') }}>
                      view closet
                    </Button>
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => {
                        for (const p of photos) { releaseObjectUrl(p.preview); releaseObjectUrl(p.thumb) }
                        for (const ri of reviewQueue) releaseObjectUrl(ri.croppedPreview)
                        reviewGenRef.current++
                        setAutoDetected(false)
                        setBatchLimitNote(null)
                        setPhotos([])
                        setReviewQueue([])
                        setActiveReviewIdx(0)
                        setSavedCount(0)
                        setUndoStack([])
                        setStep('upload')
                      }}
                    >
                      add more items
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* "Something off?" sheet */}
        <Sheet open={describeOpen} onClose={() => setDescribeOpen(false)} title="describe what's off" peekHeight="55vh">
          <div className="p-4 flex flex-col gap-4">
            <p className="text-[13px] font-mono text-muted leading-relaxed">
              Tell us what's wrong — we'll re-detect with your hint.
            </p>
            <div className="flex flex-col gap-1.5">
              {[
                "There's a belt I missed",
                "The red thing is a jacket, not a top",
                "Ignore the blanket, just the clothes",
              ].map(ex => (
                <button
                  key={ex}
                  onClick={() => setDescribeText(ex)}
                  className="text-left text-[12px] font-mono text-muted border border-outline-variant px-2 py-1.5 hover:border-ink transition-colors"
                >
                  "{ex}"
                </button>
              ))}
            </div>
            <textarea
              className="border-2 border-ink px-3 py-2 text-[14px] font-mono w-full resize-none"
              rows={3}
              placeholder="Describe what's off..."
              value={describeText}
              onChange={e => setDescribeText(e.target.value)}
            />
          </div>
          <div className="px-4 pb-4 flex gap-2">
            <Button className="flex-1" disabled={!describeText.trim()} onClick={() => void handleReanalyze(activePhotoIdx)}>
              re-analyse
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => setDescribeOpen(false)}>
              cancel
            </Button>
          </div>
        </Sheet>
      </div>
    </div>
  )
}
