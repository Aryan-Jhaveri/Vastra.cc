import { AuthImage } from './AuthImage'
import type { SharePayload } from '../api/share'

interface Props {
  payload: SharePayload
}

export function SharePreviewCard({ payload }: Props) {
  const images = payload.imageUris.slice(0, 3)
  const sender = payload.senderName
    ? payload.senderName
    : payload.senderHandle
      ? `@${payload.senderHandle}`
      : 'Someone'

  return (
    <div className="border-2 border-ink p-3 flex gap-3 bg-surface rounded-base">
      {images.length > 0 && (
        <div className="flex gap-1 shrink-0">
          {images.map((uri, i) => (
            <div key={i} className="w-12 h-14 border border-outline-variant overflow-hidden bg-surface-dim">
              <AuthImage src={`/${uri}`} alt="" className="w-full h-full object-contain" />
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-muted">
          From {sender}
        </span>
        <p className="text-[14px] font-mono text-ink leading-relaxed line-clamp-3">
          {payload.description}
        </p>
        {payload.outfit && (
          <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">
            {payload.outfit.name}
          </span>
        )}
      </div>
    </div>
  )
}
