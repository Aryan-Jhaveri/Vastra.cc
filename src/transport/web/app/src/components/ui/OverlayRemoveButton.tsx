import { Trash2 } from 'lucide-react'
import { Spinner } from './Spinner'

interface OverlayRemoveButtonProps {
  onClick: () => void
  disabled?: boolean
  busy?: boolean
}

export function OverlayRemoveButton({ onClick, disabled, busy }: OverlayRemoveButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className="flex items-center gap-1 border-2 border-error bg-paper text-error px-2 py-1 text-[14px] font-bold font-sans uppercase tracking-[0.08em] shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-40 rounded-base"
    >
      {busy ? <Spinner size={12} /> : <Trash2 className="w-3 h-3 shrink-0" strokeWidth={2} />}
      <span className="leading-none">Remove</span>
    </button>
  )
}
