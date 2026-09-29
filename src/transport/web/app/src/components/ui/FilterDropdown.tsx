import * as Select from '@radix-ui/react-select'
import { ChevronDown, Check } from 'lucide-react'

interface FilterDropdownProps {
  label: string
  options: string[]
  value: string
  onChange: (v: string) => void
}

export function FilterDropdown({ label, options, value, onChange }: FilterDropdownProps) {
  const id = `filter-${label.toLowerCase()}`
  return (
    <div className="flex flex-col gap-0.5 flex-1 min-w-[80px]">
      <label htmlFor={id} className="text-[14px] font-mono text-muted uppercase tracking-[0.08em]">{label}</label>
      <Select.Root value={value || '__all__'} onValueChange={v => onChange(v === '__all__' ? '' : v)}>
        <Select.Trigger
          id={id}
          className="flex items-center justify-between w-full border-2 border-ink px-2 py-1.5 text-[14px] font-mono uppercase tracking-[0.05em] bg-paper text-ink outline-none focus:bg-surface-dim cursor-pointer data-[placeholder]:text-muted rounded-base overflow-hidden"
        >
          <span className="truncate min-w-0 flex-1">
            <Select.Value placeholder="All" />
          </span>
          <Select.Icon asChild>
            <ChevronDown size={11} strokeWidth={2.5} className="shrink-0 ml-1" />
          </Select.Icon>
        </Select.Trigger>

        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={3}
            style={{ maxHeight: 'min(var(--radix-select-content-available-height), 240px)' }}
            className="z-50 w-[var(--radix-select-trigger-width)] border-2 border-ink bg-paper shadow-flat-md rounded-base"
          >
            <Select.Viewport
              style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
              className="overflow-y-auto max-h-[inherit]"
            >
              <SelectOption value="__all__" label="All" />
              {options.map(opt => (
                <SelectOption key={opt} value={opt} label={opt} />
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  )
}

function SelectOption({ value, label }: { value: string; label: string }) {
  return (
    <Select.Item
      value={value}
      title={label}
      className="flex items-center justify-between px-2 py-1.5 text-[14px] font-mono uppercase tracking-[0.05em] text-ink cursor-pointer select-none outline-none data-[highlighted]:bg-surface-dim data-[state=checked]:font-bold overflow-hidden"
    >
      <span className="truncate min-w-0 flex-1">
        <Select.ItemText>{label}</Select.ItemText>
      </span>
      <Select.ItemIndicator className="shrink-0 ml-1">
        <Check size={8} strokeWidth={2.5} />
      </Select.ItemIndicator>
    </Select.Item>
  )
}
