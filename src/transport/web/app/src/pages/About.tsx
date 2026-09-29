import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { PageHeader } from '../components/PageHeader'

const FOUNDERS = [
  { label: 'aryan',  name: 'Aryan Jhaveri', handle: 'Aryan-Jhaveri' },
  { label: 'harsh',  name: 'Harsh Kapoor',  handle: 'harashkapoor' },
  { label: 'tarang', name: 'Tarang Soni',   handle: 'tarang-soni' },
]

type FounderLabel = 'aryan' | 'harsh' | 'tarang'

export function About() {
  const navigate = useNavigate()
  const [active, setActive] = useState<FounderLabel>('aryan')
  const [readme, setReadme] = useState<Record<FounderLabel, string | null>>({
    aryan: null,
    harsh: null,
    tarang: null,
  })
  const [loading, setLoading] = useState(false)

  const founder = FOUNDERS.find(f => f.label === active)!

  useEffect(() => {
    if (readme[active] !== null) return
    setLoading(true)
    fetch(`https://raw.githubusercontent.com/${founder.handle}/${founder.handle}/main/README.md`)
      .then(r => r.ok ? r.text() : null)
      .catch(() => null)
      .then(text => {
        setReadme(prev => ({ ...prev, [active]: text ?? '' }))
        setLoading(false)
      })
  }, [active, founder.handle, readme])

  return (
    <div className="flex flex-col p-4 pb-20">
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-2 mb-4 text-muted hover:text-ink transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Settings</span>
      </button>

      <PageHeader title="Made with love" hideEmptySubtitle={true} />
      <div className="mb-6" />

      <p className="text-[14px] font-mono text-muted leading-relaxed mb-6">
        Made with love and appreciation for artisans, and crafts.
      </p>

      {/* Name tab strip */}
      <div className="flex border-2 border-ink shadow-flat-xs rounded-base overflow-hidden mb-6">
        {FOUNDERS.map(({ label }, i) => (
          <button
            key={label}
            onClick={() => setActive(label as FounderLabel)}
            className={`flex-1 py-2.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] transition-colors ${
              active === label ? 'bg-accent text-accent-on' : 'text-ink hover:bg-surface-dim'
            } ${i > 0 ? 'border-l-2 border-ink' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Active founder header */}
      <div className="flex items-center gap-4 mb-6">
        <img
          src={`https://github.com/${founder.handle}.png`}
          alt={founder.name}
          className="w-12 h-12 rounded-full border-2 border-ink"
        />
        <div>
          <p className="text-sm font-bold">{founder.name}</p>
          <a
            href={`https://github.com/${founder.handle}`}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-mono text-muted hover:text-ink transition-colors"
          >
            @{founder.handle}
          </a>
        </div>
      </div>

      {/* README */}
      {loading && (
        <p className="text-[13px] font-mono text-muted">Loading...</p>
      )}

      {!loading && readme[active] === '' && (
        <p className="text-[13px] font-mono text-muted">No profile README found.</p>
      )}

      {!loading && readme[active] && (
        <div className="prose prose-sm max-w-none font-mono text-[13px] leading-relaxed text-ink [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-bold [&_h3]:text-sm [&_h3]:font-semibold [&_a]:text-accent [&_a]:underline [&_img]:rounded-base [&_img]:border-2 [&_img]:border-ink [&_pre]:bg-surface-dim [&_pre]:border-2 [&_pre]:border-ink [&_pre]:p-3 [&_pre]:rounded-base [&_code]:bg-surface-dim [&_code]:px-1 [&_code]:rounded">
          <ReactMarkdown>{readme[active]!}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}
