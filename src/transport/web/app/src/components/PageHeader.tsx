import type { ReactNode } from 'react'

interface PageHeaderProps {
  /** Page title — rendered as h1 on a single line. */
  title: string
  /** Optional small uppercase mono subtitle under the title (e.g. "33 items"). */
  subtitle?: ReactNode
  /** Optional right-aligned content (date, action buttons, etc.). */
  right?: ReactNode
  /** Optional flag to remove the reserved subtitle space when no subtitle is provided. */
  hideEmptySubtitle?: boolean
}

/**
 * Standard page header used across the five top-level pages.
 *
 * Layout reference: Closet page header.
 * - 22px bold title, `leading-none`, single-line (`whitespace-nowrap` + truncation safety)
 * - 9px mono uppercase subtitle slot (~14px of vertical space)
 * - 2px bottom rule + 8px bottom padding
 *
 * This keeps the header block the same height across pages even when only a
 * title is set — the subtitle slot reserves space.
 */
export function PageHeader({ title, subtitle, right, hideEmptySubtitle }: PageHeaderProps) {
  // We render the slot if a subtitle is provided, OR if we haven't explicitly hidden the empty space.
  const showSubtitleSlot = subtitle || !hideEmptySubtitle;
  return (
    <div className="flex items-end justify-between border-b-[3px] border-ink pb-2">
      <div className="min-w-0 flex-1 overflow-hidden">
        <h1 className="text-[24px] font-bold leading-none whitespace-nowrap truncate pb-1 tracking-tight">
          {title}
        </h1>
        {showSubtitleSlot && (
          <div className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] mt-0.5 min-h-[12px] truncate">
            {subtitle}
          </div>
        )}
      </div>
      {right && <div className="shrink-0 ml-2">{right}</div>}
    </div>
  )
}
