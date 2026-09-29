import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { getInstanceConfig, type InstanceConfig } from '../api/auth'

// Settings › Instance (#315): the admin's read-only view of the active config.
// Changes go through `make setup` or the .env file, then a restart — nothing
// here writes. Secrets only ever arrive as set / not set.

const SECTION_LABEL = 'text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant'

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-outline-variant py-2 flex items-center justify-between gap-3">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-[14px] font-mono text-muted text-right">{value}</p>
    </div>
  )
}

export function SettingsInstance() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<InstanceConfig | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    getInstanceConfig().then(setConfig).catch(() => setError(true))
  }, [])

  return (
    <div className="flex flex-col p-4 pb-20">
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-2 mb-4 text-muted hover:text-ink transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Settings</span>
      </button>

      <PageHeader title="Instance." hideEmptySubtitle={true} />
      <p className="text-sm font-mono text-muted leading-relaxed mt-2">
        Read-only. To change it, run <code className="bg-surface-dim px-1">make setup</code> or edit the .env file, then restart Vastra.
      </p>

      {error && <p className="text-[14px] font-mono text-error py-3">Couldn't load the configuration.</p>}
      {!config && !error && <p className="text-[14px] font-mono text-muted py-3">Loading…</p>}

      {config && (
        <>
          <p className={SECTION_LABEL}>In effect</p>
          <Summary label="Mode" value={config.hostedMode ? 'Hosted' : 'Self-hosted'} />
          <Summary label="New accounts" value={config.signupsOpen ? 'Anyone can sign up' : 'Only accounts you create'} />
          <Summary label="Ask (chat)" value={config.chatEnabled ? 'On' : 'Off'} />
          <Summary label="Decision model" value={config.decisions ?? 'None'} />

          {config.groups.map(group => (
            <div key={group.title}>
              <p className={SECTION_LABEL}>{group.title}</p>
              {group.entries.map(entry => (
                <div key={entry.key} className="border-b border-outline-variant py-2 flex items-start justify-between gap-3" data-testid={`config-${entry.key}`}>
                  <p className="text-[13px] font-mono shrink-0">{entry.key}</p>
                  <p className={`text-[13px] font-mono text-right break-all ${entry.set ? '' : 'text-muted'}`}>
                    {!entry.set ? 'not set' : entry.secret ? 'set' : entry.value}
                  </p>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
