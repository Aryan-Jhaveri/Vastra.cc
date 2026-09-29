export type HomeTab = 'suggest' | 'reminders' | 'discover' | 'ask'

interface Props {
  active: HomeTab
  onChange: (tab: HomeTab) => void
  /** #328 — the Ask tab only exists when /api/auth/status reports chatEnabled. */
  showAsk?: boolean
}

export function TabStrip({ active, onChange, showAsk = false }: Props) {
  const tabs: { id: HomeTab; label: string }[] = [
    { id: 'suggest', label: 'Suggest' },
    { id: 'reminders', label: 'Reminders' },
    { id: 'discover', label: 'Discover' },
    ...(showAsk ? [{ id: 'ask' as const, label: 'Ask' }] : []),
  ]

  return (
    <div className="flex border-2 border-ink shadow-flat-xs rounded-base overflow-hidden">
      {tabs.map(({ id, label }, i) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex-1 py-2.5 text-[14px] font-bold font-mono uppercase tracking-[0.02em] transition-colors ${
            active === id ? 'bg-accent text-accent-on' : 'text-ink hover:bg-surface-dim'
          } ${i > 0 ? 'border-l-2 border-ink' : ''}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
