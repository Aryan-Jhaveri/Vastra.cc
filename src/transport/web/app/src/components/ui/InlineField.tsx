import { useState } from 'react'
import { Pencil } from 'lucide-react'

interface InlineFieldProps {
  label: string
  value: string | null | undefined
  onSave: (next: string) => Promise<void> | void
  placeholder?: string
  multiline?: boolean
  valueClassName?: string
  maxLength?: number
  /** Open straight into edit mode (e.g. after tapping an item to edit its size). */
  startEditing?: boolean
  /** Always show the input, no pencil: Save appears on the row once it changes (#372, Notes). */
  alwaysOpen?: boolean
}

export function InlineField({ label, value, onSave, placeholder, multiline, valueClassName, maxLength, startEditing, alwaysOpen }: InlineFieldProps) {
  const [editingState, setEditing] = useState(!!startEditing)
  const editing = editingState || !!alwaysOpen
  const [inputValue, setInputValue] = useState(startEditing || alwaysOpen ? (value ?? '') : '')
  const dirty = inputValue !== (value ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function startEdit() {
    setInputValue(value ?? '')
    setSaveError(null)
    setEditing(true)
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(inputValue)
      setEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">{label}</p>
      {editing ? (
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            {multiline ? (
              <textarea
                autoFocus={!alwaysOpen}
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onBlur={() => { if (!alwaysOpen || dirty) void handleSave() }}
                placeholder={placeholder}
                rows={3}
                maxLength={maxLength}
                disabled={saving}
                className="flex-1 border-2 border-ink px-3 py-1.5 text-[14px] font-mono outline-none focus:bg-surface-dim bg-paper text-ink resize-none placeholder:text-muted placeholder:normal-case disabled:opacity-50"
              />
            ) : (
              <input
                autoFocus={!alwaysOpen}
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onBlur={() => { if (!alwaysOpen || dirty) void handleSave() }}
                onKeyDown={e => e.key === 'Enter' && void handleSave()}
                placeholder={placeholder}
                maxLength={maxLength}
                disabled={saving}
                className="flex-1 border-2 border-ink px-3 py-1.5 text-sm font-mono outline-none focus:bg-surface-dim bg-paper text-ink disabled:opacity-50"
              />
            )}
            {(!alwaysOpen || dirty || saving) && (
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => void handleSave()}
                disabled={saving}
                className="shrink-0 self-start border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim transition-colors disabled:opacity-50"
              >
                {saving ? '…' : 'Save'}
              </button>
            )}
          </div>
          {saveError && (
            <p className="text-[12px] font-mono text-error">{saveError}</p>
          )}
        </div>
      ) : (
        <button type="button" onClick={startEdit} className="flex items-center gap-2 group">
          <span className={valueClassName ?? 'text-sm font-mono capitalize'}>
            {value || <span className="text-muted">—</span>}
          </span>
          <Pencil className="w-3 h-3 text-muted group-hover:text-ink" />
        </button>
      )}
    </div>
  )
}
