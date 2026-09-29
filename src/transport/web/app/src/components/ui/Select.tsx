import * as RadixSelect from '@radix-ui/react-select'
import { ChevronDown, Check } from 'lucide-react'

interface SelectProps {
  label?: string
  id?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  className?: string
}

export function Select({ label, id, value, onChange, options, placeholder, className = '' }: SelectProps) {
  const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-')
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-ink">
          {label}
        </label>
      )}
      <RadixSelect.Root value={value} onValueChange={onChange}>
        <RadixSelect.Trigger
          id={selectId}
          className="flex items-center justify-between rounded-xl border border-outline-variant px-3 py-2 text-sm bg-paper text-ink outline-none focus:border-ink cursor-pointer data-[placeholder]:text-muted"
        >
          <RadixSelect.Value placeholder={placeholder ?? 'Select…'} />
          <RadixSelect.Icon asChild>
            <ChevronDown size={14} strokeWidth={2} className="shrink-0 ml-2 text-muted" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            style={{ maxHeight: 'min(var(--radix-select-content-available-height), 280px)' }}
            className="z-50 w-[var(--radix-select-trigger-width)] rounded-xl border border-outline-variant bg-paper shadow-lg"
          >
            <RadixSelect.Viewport
              style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
              className="p-1 overflow-y-auto max-h-[inherit]"
            >
              {options.map(o => (
                <RadixSelect.Item
                  key={o.value}
                  value={o.value}
                  className="flex items-center justify-between px-3 py-2 text-sm text-ink rounded-lg cursor-pointer select-none outline-none data-[highlighted]:bg-surface-dim data-[state=checked]:font-medium"
                >
                  <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator>
                    <Check size={12} strokeWidth={2.5} />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  )
}
