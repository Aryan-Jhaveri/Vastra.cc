import { useState } from 'react'
import { Share2, Check, Copy } from 'lucide-react'
import { createShare } from '../api/share'

interface Props {
  source: 'outfit' | 'suggestion' | 'inspiration' | 'manual'
  sourceRef?: string
  description: string
  imageUris?: string[]
  className?: string
}

export function ShareButton({ source, sourceRef, description, imageUris, className = '' }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'copied'>('idle')

  async function handleShare() {
    setState('loading')
    try {
      const { url } = await createShare({ source, sourceRef, description, imageUris })

      let shared = false
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Vastra outfit', url })
          shared = true
        } catch {
          // user dismissed share sheet or share failed — fall through to clipboard
        }
      }

      if (!shared) {
        try {
          await navigator.clipboard.writeText(url)
        } catch {
          // clipboard API unavailable (HTTP) — execCommand fallback
          const el = document.createElement('textarea')
          el.value = url
          el.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
          document.body.appendChild(el)
          el.focus()
          el.select()
          document.execCommand('copy')
          document.body.removeChild(el)
        }
      }

      setState('copied')
      setTimeout(() => setState('idle'), 2500)
    } catch {
      setState('idle')
    }
  }

  return (
    <button
      onClick={handleShare}
      disabled={state === 'loading'}
      title="Share"
      aria-label="Share"
      className={`border-2 border-ink px-2 py-1.5 flex items-center gap-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim transition-colors disabled:opacity-40 rounded-base ${className}`}
    >
      {state === 'copied' ? (
        <>
          <Check className="w-3 h-3" strokeWidth={2.5} />
          Copied
        </>
      ) : state === 'loading' ? (
        <>
          <Copy className="w-3 h-3" />
          Sharing…
        </>
      ) : (
        <>
          <Share2 className="w-3 h-3" />
          Share
        </>
      )}
    </button>
  )
}
