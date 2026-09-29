import { useState } from 'react'
import { useNavigate } from 'react-router'
import { AddItemFlow } from '../modals/AddItemFlow'
import { Button } from '../components/ui/Button'
import { ChevronRight, Plus } from 'lucide-react'

interface OnboardingProps {
  onComplete?: () => void
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const navigate = useNavigate()
  const [showFlow, setShowFlow] = useState(false)
  const [savedCount, setSavedCount] = useState<number | null>(null)

  function finish() {
    localStorage.setItem('closet_onboarded', 'true')
    if (onComplete) { onComplete() } else { navigate('/closet') }
  }

  function handleDone(count: number) {
    setSavedCount(count)
    setShowFlow(false)
    localStorage.setItem('closet_onboarded', 'true')
  }

  function handleSkip() {
    finish()
  }

  if (showFlow) {
    return (
      <AddItemFlow
        mode="onboarding"
        onClose={() => setShowFlow(false)}
        onSaved={handleDone}
      />
    )
  }

  return (
    <div className="min-h-screen bg-paper">
      {/* Hero */}
      <div className="border-b-2 border-ink px-4 py-8 bg-surface">
        <p className="text-[14px] font-mono uppercase tracking-[0.18em] text-muted mb-2">
          VASTRA 
        </p>
        <h1 className="text-[28px] font-bold font-mono uppercase leading-none tracking-tight text-ink mb-3">
          add your<br />wardrobe
        </h1>
        <p className="text-[14px] font-mono text-muted leading-relaxed mb-6 max-w-sm">
          Take a photo or upload one of you wearing your outfit, or your items laying, and Vastra will help scan them for you. 
        </p>

        <Button className="w-full" onClick={() => { setShowFlow(true); setSavedCount(null) }}>
          <Plus className="w-3.5 h-3.5 inline-block mr-1" strokeWidth={2.5} /> start adding items
        </Button>

        {savedCount !== null && (
          <div className="mt-3 border-2 border-ink bg-paper px-3 py-2 flex items-center justify-between gap-2 rounded-base">
            <div className="flex items-center gap-2">
              <span className="text-[14px]">✓</span>
              <p className="text-[14px] font-mono uppercase tracking-widest text-ink">
                {savedCount} items added to your closet
              </p>
            </div>
            <button
              onClick={finish}
              className="text-[14px] font-mono uppercase tracking-widest text-muted underline hover:text-ink"
            >
              view <ChevronRight className="w-3 h-3 inline-block" />
            </button>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="px-4 py-5">
        <p className="text-[14px] font-mono uppercase tracking-[0.14em] text-muted mb-3">how it works</p>
        <div className="flex flex-col gap-0">
          {[
            { num: '01', title: 'upload 1–3 photos', desc: 'Mirror selfie, flat lay on bed, items on hangers — anything works.' },
            { num: '02', title: 'scan every garment', desc: 'Gemini draws bounding boxes around each item. You approve or adjust.' },
            { num: '03', title: 'swipe to save or skip', desc: 'One card per item. Swipe right to keep, left to skip.' },
          ].map((s, i, arr) => (
            <div key={s.num} className={`flex gap-3 py-3 ${i < arr.length - 1 ? 'border-b border-outline-variant' : ''}`}>
              <div className="flex-none w-8 text-[14px] font-bold font-mono text-muted pt-0.5">{s.num}</div>
              <div className="flex flex-col gap-0.5">
                <p className="text-[14px] font-bold font-mono uppercase tracking-wide text-ink">{s.title}</p>
                <p className="text-[14px] font-mono text-muted leading-relaxed">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="px-4 pb-8">
        <button
          onClick={handleSkip}
          className="text-[14px] font-mono uppercase tracking-widest text-muted underline hover:text-muted"
        >
         Skip - add items later 
        </button>
      </div>
    </div>
  )
}
