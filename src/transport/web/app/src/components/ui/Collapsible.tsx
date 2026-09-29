import { useState, useEffect } from 'react'
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { ChevronDown } from 'lucide-react'

interface CollapsibleSectionProps {
  title: string
  storageKey: string
  badge?: string
  defaultOpen?: boolean
  /** Optional control mounted in the header row (right side, before the chevron).
   *  Rendered outside the Radix Trigger so clicks on it don't toggle open state. */
  headerAction?: React.ReactNode
  children: React.ReactNode
}

export function CollapsibleSection({
  title,
  storageKey,
  badge,
  defaultOpen = true,
  headerAction,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(() => {
    const stored = sessionStorage.getItem(storageKey)
    if (stored !== null) return stored === 'true'
    return defaultOpen
  })

  useEffect(() => {
    sessionStorage.setItem(storageKey, String(open))
  }, [open, storageKey])

  return (
    <CollapsiblePrimitive.Root open={open} onOpenChange={setOpen}>
      <div className="border-b-2 border-ink w-full flex items-center justify-between p-3 hover:bg-surface-dim transition-colors min-h-[44px]">
        <CollapsiblePrimitive.Trigger className="flex-1 flex items-center gap-2 text-left">
          <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">{title}</span>
          {badge !== undefined && (
            <span className="text-[14px] font-mono text-muted">({badge})</span>
          )}
        </CollapsiblePrimitive.Trigger>
        <div className="flex items-center gap-2 shrink-0">
          {headerAction}
          <CollapsiblePrimitive.Trigger className="flex items-center justify-center" aria-label={open ? 'Collapse' : 'Expand'}>
            <ChevronDown className={`w-4 h-4 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </CollapsiblePrimitive.Trigger>
        </div>
      </div>
      <CollapsiblePrimitive.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="pt-3">
          {children}
        </div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  )
}
