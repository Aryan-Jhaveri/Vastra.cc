import { useState, useRef, useEffect } from 'react'
import { Sheet } from './ui/Sheet'
import { Button } from './ui/Button'
import { AuthImage } from './AuthImage'
import { generateThumbnail, setItemImagePrimary, fetchItemImages } from '../api/items'
import type { ItemImage } from '../api/items'
import { MAX_REF_IMAGES } from '../constants'
import { requestWalletRefresh } from '../lib/walletEvents'

type State = 'confirm' | 'generating' | 'result' | 'error'

interface MakePrettySheetProps {
  itemId: string
  imageUri: string
  label: string
  open: boolean
  onClose: () => void
  onUsed?: (newImageUri: string) => void
  onGenerated?: () => void
}

export function MakePrettySheet({ itemId, imageUri, label, open, onClose, onUsed, onGenerated }: MakePrettySheetProps) {
  const [state, setState] = useState<State>('confirm')
  const [generatedImage, setGeneratedImage] = useState<ItemImage | null>(null)
  const [genError, setGenError] = useState<string | null>(null)
  const [naturalSourceCount, setNaturalSourceCount] = useState<number | null>(null)
  const instructionRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    fetchItemImages(itemId).then(imgs => {
      const naturalRefs = imgs.filter(i => i.role !== 'generated')
      setNaturalSourceCount(naturalRefs.length)
    }).catch(() => {
      setNaturalSourceCount(null)
    })
  }, [open, itemId])

  function handleClose() {
    setState('confirm')
    setGeneratedImage(null)
    setGenError(null)
    onClose()
  }

  async function runGenerate(opts: { instruction?: string; sourceImageIds?: string[] } = {}) {
    setState('generating')
    setGenError(null)
    try {
      const { image } = await generateThumbnail(itemId, opts)
      setGeneratedImage(image)
      setState('result')
      requestWalletRefresh()
      onGenerated?.()
    } catch (err) {
      setGenError(String(err))
      setState('error')
    }
  }

  async function generate() {
    const instruction = instructionRef.current?.value?.trim()
    await runGenerate({ instruction: instruction || undefined })
  }

  async function handleUseNew() {
    if (!generatedImage) return
    try {
      await setItemImagePrimary(itemId, generatedImage.id)
      onUsed?.(generatedImage.imageUri)
    } catch { /* best-effort */ }
    handleClose()
  }

  const src = `/${imageUri}`

  return (
    <>
      {/* Confirm */}
      <Sheet
        open={open && state === 'confirm'}
        onClose={handleClose}
        title="generate thumbnail"
        peekHeight="48vh"
        actions={
          <div className="px-4 py-3 flex gap-2">
            <Button className="flex-1" onClick={generate}>generate thumbnail</Button>
            <Button variant="secondary" className="flex-1" onClick={handleClose}>cancel</Button>
          </div>
        }
      >
        <div className="p-4 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 border-2 border-ink overflow-hidden flex-none bg-surface-dim">
              <AuthImage src={src} alt={label} className="w-full h-full object-contain" />
            </div>
            <div>
              <p className="text-[14px] font-bold font-mono uppercase">{label}</p>
              <p className="text-[14px] font-mono text-muted mt-0.5">current thumbnail</p>
            </div>
          </div>
          <p className="text-[14px] font-mono text-muted leading-relaxed">
            Create a nice thumbnail and make your closet look organized!
          </p>
          {naturalSourceCount !== null && (
            <div className="border border-outline-variant px-3 py-2 flex items-center justify-between">
              <span className="text-[14px] font-mono uppercase tracking-widest text-muted">reference photos</span>
              <span className="text-[14px] font-bold font-mono text-ink">
                {naturalSourceCount} / {MAX_REF_IMAGES}
                {naturalSourceCount === 0 && (
                  <span className="ml-1 font-normal text-muted normal-case tracking-normal">
                    · using cover as reference — quality limited
                  </span>
                )}
                {naturalSourceCount > 0 && naturalSourceCount < 2 && (
                  <span className="ml-1 font-normal text-muted normal-case tracking-normal">
                    · add more for better results
                  </span>
                )}
                {naturalSourceCount > MAX_REF_IMAGES && (
                  <span className="ml-1 font-normal text-error normal-case tracking-normal">
                    · remove some in gallery (max {MAX_REF_IMAGES})
                  </span>
                )}
              </span>
            </div>
          )}
          <div className="border-2 border-ink px-3 py-2 flex items-center justify-between bg-surface rounded-base">
            <span className="text-[14px] font-mono uppercase tracking-widest text-muted">cost</span>
            <span className="text-[14px] font-bold font-mono uppercase">16 tokens</span>
          </div>
          <input
            ref={instructionRef}
            className="border-2 border-ink px-3 py-2 text-[14px] font-mono w-full outline-none focus:bg-surface bg-paper text-ink"
            placeholder='optional: "on a hanger, front view"'
          />
        </div>
      </Sheet>

      {/* Generating — dismissable while the model runs */}
      <Sheet open={open && state === 'generating'} onClose={handleClose} title="generating…" peekHeight="42vh">
        <div className="flex flex-col items-center gap-5 py-8 px-6">
          <div className="w-20 border-2 border-ink overflow-hidden bg-surface-dim relative rounded-base" style={{ aspectRatio: '4/5' }}>
            <AuthImage src={src} alt={label} className="w-full h-full object-contain opacity-50" />
            {/* Shimmer overlay so the user sees something is happening */}
            <div className="absolute inset-0 shimmer" />
          </div>
          <div className="text-center flex flex-col gap-1">
            <p className="text-[14px] font-bold font-mono uppercase tracking-widest text-ink">generating product photo</p>
            <p className="text-[14px] font-mono text-muted uppercase tracking-wider">gemini image · usually ~15s</p>
          </div>
          <div className="flex gap-1.5">
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="w-2 h-2 bg-ink rounded-full"
                style={{ animation: `bounce2 1s ${i * 0.2}s ease-in-out infinite` }}
              />
            ))}
          </div>
          <p className="text-[14px] font-mono text-muted text-center max-w-[24ch]">
            Tap outside the box to close it, don't worry, your thumbnail will be ready and attached to your item
          </p>
        </div>
        <style>{`
          @keyframes bounce2 { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
          @keyframes shimmer {
            0% { transform: translateX(-100%) }
            100% { transform: translateX(100%) }
          }
          .shimmer {
            background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.6) 50%, transparent 70%);
            animation: shimmer 1.6s ease-in-out infinite;
          }
        `}</style>
      </Sheet>

      {/* Result */}
      <Sheet open={open && state === 'result'} onClose={handleClose} title="choose your cover" peekHeight="72vh">
        <div className="p-4 flex flex-col gap-4">
          <div className="flex gap-3">
            <div className="flex-1 flex flex-col gap-1">
              <div className="w-full border-2 border-outline-variant overflow-hidden bg-surface-dim" style={{ aspectRatio: '4/5' }}>
                <AuthImage src={src} alt={label} className="w-full h-full object-contain" />
              </div>
              <p className="text-[14px] font-mono uppercase tracking-widest text-muted text-center">original</p>
              <Button variant="secondary" className="w-full text-[14px]" onClick={handleClose}>keep original</Button>
            </div>
            {generatedImage && (
              <div className="flex-1 flex flex-col gap-1">
                <div className="w-full border-2 border-ink overflow-hidden relative bg-surface-dim rounded-base" style={{ aspectRatio: '4/5' }}>
                  <AuthImage src={`/${generatedImage.imageUri}`} alt="generated" className="w-full h-full object-contain" />
                  <div className="absolute top-1 right-1 bg-ink text-accent-on text-[14px] font-mono px-1 py-0.5 uppercase tracking-wider">
                    new
                  </div>
                </div>
                <p className="text-[14px] font-mono uppercase tracking-widest text-muted text-center">product shot</p>
                <Button className="w-full text-[14px]" onClick={handleUseNew}>use new</Button>
              </div>
            )}
          </div>
          <button
            className="text-[14px] font-mono uppercase tracking-widest text-muted underline text-center"
            onClick={() => setState('confirm')}
          >
            try again with different instructions
          </button>
        </div>
      </Sheet>

      {/* Error */}
      <Sheet
        open={open && state === 'error'}
        onClose={handleClose}
        title="generation failed"
        peekHeight="30vh"
        actions={
          <div className="px-4 py-3 flex gap-2">
            <Button className="flex-1" onClick={() => setState('confirm')}>try again</Button>
            <Button variant="secondary" className="flex-1" onClick={handleClose}>cancel</Button>
          </div>
        }
      >
        <div className="p-4 flex flex-col gap-4">
          <p className="text-[14px] font-mono text-muted">{genError ?? 'Unknown error'}</p>
        </div>
      </Sheet>
    </>
  )
}
