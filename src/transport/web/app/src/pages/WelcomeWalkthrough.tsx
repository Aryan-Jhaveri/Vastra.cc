import { useState } from 'react'
import { LottieAnim } from '../components/LottieAnim'

interface WelcomeWalkthroughProps {
  onComplete: () => void
}

export function WelcomeWalkthrough({ onComplete }: WelcomeWalkthroughProps) {
  const [showGuideCta, setShowGuideCta] = useState(false)

  function handleComplete() {
    localStorage.setItem('closet_walkedthrough', 'true')
    setShowGuideCta(true)
  }

  function handleSkip() {
    localStorage.setItem('closet_walkedthrough', 'true')
    setShowGuideCta(true)
  }

  function handleContinue() {
    onComplete()
  }

  if (showGuideCta) {
    return (
      <div className="fixed inset-0 z-50 bg-paper/80 flex items-center justify-center p-4">
        <div className="w-full max-w-sm border-2 border-ink bg-surface p-6 rounded-base shadow-flat-xs flex flex-col gap-4">
          <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-ink">
            The full guide is available in Settings → Guide.
          </p>
          <button
            onClick={handleContinue}
            className="w-full border-2 border-ink bg-accent text-accent-on px-4 py-3 text-[14px] font-bold font-mono uppercase tracking-[0.08em] rounded-base hover:opacity-90 transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-paper">
      <button
        onClick={handleSkip}
        className="absolute top-0 right-0 z-10 m-4 text-[13px] font-bold font-mono uppercase tracking-[0.08em] text-muted hover:text-ink bg-paper px-3 py-1.5 border-2 border-ink shadow-flat-xs rounded-base"
      >
        Skip
      </button>

      <LottieAnim
        key="welcome"
        src="/animations/mob-Welcome_cleaned.json"
        className="w-full h-full"
        loop={false}
        autoplay={true}
        onComplete={handleComplete}
      />
    </div>
  )
}
